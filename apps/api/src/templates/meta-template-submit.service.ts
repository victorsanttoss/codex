import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { getActiveConnectionForTenant, makeCipherFromEnv, TenantSecretsStore } from "@sdr/db";
import type { HttpClient } from "@sdr/whatsapp-cloud";
import { APP_CONFIG } from "../config/config.module";
import type { AppConfig } from "@sdr/config";
import { WHATSAPP_HTTP } from "../whatsapp/http.token";

export interface SubmitResult {
  /** true = pedido de aprovação ENVIADO à Meta (status continua 'pending' até o webhook). */
  submitted: boolean;
  /** Id do template devolvido pelo Graph — correlaciona o webhook de aprovação. */
  metaTemplateId?: string;
  /** Motivo quando não submetido (sem conexão oficial, sem WABA/token, erro Graph). */
  reason?: string;
}

/**
 * Submete um template (HSM) à META para aprovação (M8-ext) — automatiza o passo
 * manual: o cliente escreve o follow-up e o pedido já sai via Graph API
 * (`POST /{waba_id}/message_templates`). O RESULTADO (APPROVED/REJECTED) volta
 * pelo webhook (`message_template_status_update`) e atualiza o catálogo — a
 * cadência só dispara template aprovado (guardrail M8 intocado). Best-effort:
 * falha aqui NUNCA quebra o fluxo do cliente; o template fica 'pending' e a
 * submissão pode ser repetida (Meta trata nome+idioma como upsert de rascunho).
 */
@Injectable()
export class MetaTemplateSubmitService {
  private readonly logger = new Logger(MetaTemplateSubmitService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Optional() @Inject(WHATSAPP_HTTP) private readonly http: HttpClient | null,
  ) {}

  async submit(input: {
    name: string;
    languageCode: string;
    category: string;
    bodyText: string;
  }): Promise<SubmitResult> {
    const conn = await getActiveConnectionForTenant();
    if (!conn || conn.provider !== "cloud_api") {
      return { submitted: false, reason: "sem conexão Cloud API ativa (Baileys não exige aprovação)" };
    }
    if (!conn.wabaId) return { submitted: false, reason: "conexão sem WABA conhecida" };
    if (!this.http) return { submitted: false, reason: "HTTP da Meta indisponível neste processo" };

    const token = await new TenantSecretsStore(makeCipherFromEnv()).get(conn.secretRef);
    if (!token) return { submitted: false, reason: "token do WhatsApp ausente" };

    const root = (this.cfg.whatsapp.graphApiBase ?? "https://graph.facebook.com").replace(/\/$/, "");
    const url = `${root}/${this.cfg.whatsapp.graphApiVersion}/${conn.wabaId}/message_templates`;
    try {
      const res = await this.http.post(url, {
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          language: input.languageCode,
          category: input.category.toUpperCase(),
          components: [{ type: "BODY", text: input.bodyText }],
        }),
      });
      if (res.status >= 200 && res.status < 300) {
        const body = (await res.json().catch(() => ({}))) as { id?: unknown };
        const metaTemplateId =
          typeof body.id === "string" && body.id ? body.id : typeof body.id === "number" ? String(body.id) : undefined;
        this.logger.log(`Template '${input.name}/${input.languageCode}' submetido à Meta (aguardando aprovação).`);
        return { submitted: true, ...(metaTemplateId ? { metaTemplateId } : {}) };
      }
      const detail = JSON.stringify(await res.json().catch(() => ({}))).slice(0, 300);
      this.logger.warn(`Meta recusou a submissão de '${input.name}': HTTP ${res.status} ${detail}`);
      return { submitted: false, reason: `Graph HTTP ${res.status}` };
    } catch (err) {
      this.logger.warn(`Falha ao submeter '${input.name}' à Meta: ${err instanceof Error ? err.message : err}`);
      return { submitted: false, reason: "erro de rede na Graph API" };
    }
  }
}
