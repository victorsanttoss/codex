import { Injectable, Logger } from "@nestjs/common";
import { runWithTenant, type InboundWebhookRequest } from "@sdr/core";
import { findConnectionsByWaba, setTemplateStatus } from "@sdr/db";

export interface TemplateStatusEvent {
  wabaId: string;
  name: string;
  languageCode: string;
  /** Status normalizado do catálogo ('approved' | 'rejected' | 'paused' | 'pending'). */
  status: string;
  rawEvent: string;
  /** Id do template na Meta (ecoado do Graph) — correlaciona com a submissão atual. */
  metaTemplateId?: string;
}

/** Eventos da Meta → status do catálogo. Desconhecido = não mexe (fail-safe). */
const EVENT_TO_STATUS: Record<string, string> = {
  APPROVED: "approved",
  REJECTED: "rejected",
  PAUSED: "paused",
  PENDING: "pending",
  PENDING_DELETION: "rejected",
  DISABLED: "rejected",
};

/**
 * Parser PURO do webhook `message_template_status_update` (aprovação de HSM).
 * Payload cru é dado não-confiável: só extrai strings esperadas; formato fora
 * do esperado → ignora a entrada (nunca lança).
 */
export function parseTemplateStatusEvents(rawBody: string): TemplateStatusEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const out: TemplateStatusEvent[] = [];
  const entries = (parsed as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const wabaId = typeof (entry as { id?: unknown })?.id === "string" ? ((entry as { id: string }).id) : "";
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!wabaId || !Array.isArray(changes)) continue;
    for (const change of changes) {
      const c = change as { field?: unknown; value?: Record<string, unknown> };
      if (c?.field !== "message_template_status_update") continue;
      const v = c.value ?? {};
      const rawEvent = typeof v.event === "string" ? v.event.toUpperCase() : "";
      const name = typeof v.message_template_name === "string" ? v.message_template_name : "";
      const languageCode = typeof v.message_template_language === "string" ? v.message_template_language : "";
      const status = EVENT_TO_STATUS[rawEvent];
      if (!name || !languageCode || !status) continue;
      // A Meta manda o id como número ou string — normaliza p/ string.
      const rawId = v.message_template_id;
      const metaTemplateId =
        typeof rawId === "string" && rawId ? rawId : typeof rawId === "number" ? String(rawId) : undefined;
      out.push({ wabaId, name, languageCode, status, rawEvent, ...(metaTemplateId ? { metaTemplateId } : {}) });
    }
  }
  return out;
}

/**
 * Handler ADITIVO (fora da pipeline de mensagem, mesmo padrão do
 * AccountEventsService/M3): resolve o tenant pela WABA e atualiza o status do
 * template no catálogo. É isto que tira o cliente do "aguardando aprovação da
 * Meta" — a cadência só passa a disparar quando o webhook trouxer APPROVED.
 */
@Injectable()
export class TemplateStatusEventsService {
  private readonly logger = new Logger(TemplateStatusEventsService.name);

  async process(request: InboundWebhookRequest): Promise<void> {
    const raw = typeof request.rawBody === "string" ? request.rawBody : request.rawBody.toString("utf8");
    const events = parseTemplateStatusEvents(raw);
    for (const ev of events) {
      const target = await findConnectionsByWaba(ev.wabaId);
      if (!target) {
        this.logger.warn(`template_status '${ev.rawEvent}' p/ waba ${ev.wabaId} sem conexão conhecida.`);
        continue;
      }
      await runWithTenant({ tenantId: target.tenantId }, async () => {
        const result = await setTemplateStatus(ev.name, ev.languageCode, ev.status, ev.metaTemplateId);
        if (result === "not_found") {
          this.logger.warn(`template_status: '${ev.name}/${ev.languageCode}' não está no catálogo do tenant ${target.tenantId}.`);
          return;
        }
        if (result === "id_mismatch") {
          // Webhook ATRASADO de submissão antiga (nome reutilizado) — não pode
          // aprovar/rejeitar o corpo atual (achado Codex).
          this.logger.warn(`template_status IGNORADO por id divergente: '${ev.name}/${ev.languageCode}' evento ${ev.metaTemplateId ?? "?"} (Meta: ${ev.rawEvent}).`);
          return;
        }
        this.logger.log(`Template '${ev.name}/${ev.languageCode}' → ${ev.status} (Meta: ${ev.rawEvent}).`);
      });
    }
  }
}
