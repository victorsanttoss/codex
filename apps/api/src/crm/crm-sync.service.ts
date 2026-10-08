import { Injectable, Logger } from "@nestjs/common";
import { toE164 } from "@sdr/core";
import { getCrmSync, upsertCrmSync } from "@sdr/db";
import { CrmService } from "./crm.service";
import { CrmConfigService } from "./crm-config.service";

/** Mascara um telefone para diagnóstico sem expor PII: mantém só os 4 últimos. */
export function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length <= 4) return "***";
  return `***${digits.slice(-4)}`;
}

export interface LeadSyncPayload {
  conversationId: string;
  phone: string;
  name?: string;
  fields: Record<string, unknown>;
  stage: string;
  status: string;
  score?: number;
}

/**
 * Sincroniza o lead com o CRM (no contexto do tenant). IDEMPOTENTE: o provider
 * deduplica contato por telefone e oportunidade por contato; o mapa
 * `crm_external_sync` registra o resultado. Retry do job ou novo handoff do
 * mesmo lead NÃO duplica contato/oportunidade.
 */
@Injectable()
export class CrmSyncService {
  private readonly logger = new Logger(CrmSyncService.name);

  constructor(
    private readonly crm: CrmService,
    private readonly config: CrmConfigService,
  ) {}

  async sync(payload: LeadSyncPayload): Promise<void> {
    // SEM curto-circuito por status 'synced': um lead já sincronizado que ganhou
    // campos novos DEVE re-sincronizar (o jobId da fila inclui hash do payload —
    // só chega job aqui quando o conteúdo mudou ou é a 1ª vez). A proteção contra
    // loop fica no ENQUEUE (jobId por conteúdo deduplica payload idêntico); o
    // update no CRM é idempotente pela chave canônica (ADR 0026: contato por
    // telefone, oportunidade por contato) — re-sync atualiza, nunca duplica.
    // `existing` segue usado p/ não duplicar a atividade de 1ª sincronização.
    const existing = await getCrmSync(payload.conversationId);
    // Chave E.164 canônica para dedup. O phone vem do wa_id (SEMPRE internacional)
    // — nunca prefixamos país default aqui (revisão Codex: '1555...' dos EUA viraria
    // '+551555...'). Ambos os casos são PERMANENTES (não adianta re-tentar; sai sem
    // lançar), mas com semântica distinta: sem dígito algum = 'skipped' (lead sem
    // telefone); dígitos presentes porém E.164 inválido = 'failed' observável (erro
    // de payload/mapeamento upstream — não mascarar como skip).
    const phone = toE164(payload.phone);
    if (!phone) {
      const hasDigits = /\d/.test(payload.phone);
      if (hasDigits) {
        // LGPD: NÃO logar o telefone em claro. Só o conversationId + o fato de ser
        // inválido (o valor mascarado vai só ao lastError, que é tenant-scoped).
        this.logger.error(`Lead ${payload.conversationId} com telefone INVÁLIDO (não-E.164) — sync marcado failed.`);
      } else {
        this.logger.warn(`Lead ${payload.conversationId} sem telefone — sync pulado.`);
      }
      await upsertCrmSync({
        conversationId: payload.conversationId,
        crmAdapter: (await this.config.forTenant()).crmAdapter,
        status: hasDigits ? "failed" : "skipped",
        lastError: hasDigits ? `telefone inválido (não-E.164): ${maskPhone(payload.phone)}` : "sem telefone",
      });
      return;
    }

    const provider = await this.crm.crmForTenant();
    const settings = await this.config.forTenant();
    try {
      const { externalId: contactId } = await provider.upsertContact({
        phone,
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        fields: payload.fields,
      });
      const { externalId: opportunityId } = await provider.upsertOpportunity({
        contactExternalId: contactId,
        conversationId: payload.conversationId,
        // Reusa a oportunidade que JÁ criamos nesta conversa (se houver): o provider
        // atualiza exatamente ESSA, sem adivinhar qual lead do contato é o nosso.
        ...(existing?.opportunityExternalId
          ? { knownExternalId: existing.opportunityExternalId }
          : {}),
        title: "Lead WhatsApp",
        stage: payload.stage,
        status: "open",
        ...(payload.score !== undefined ? { score: payload.score } : {}),
      });
      // atividade só na 1ª sincronização (não duplica nota em retry/re-handoff).
      if (provider.addActivity && !existing) {
        await provider.addActivity({
          contactExternalId: contactId,
          kind: "sync",
          body: `Lead ${payload.status} (score ${payload.score ?? 0})`,
        });
      }
      await upsertCrmSync({
        conversationId: payload.conversationId,
        crmAdapter: settings.crmAdapter,
        contactExternalId: contactId,
        opportunityExternalId: opportunityId,
        status: "synced",
      });
      this.logger.log(`Lead ${payload.conversationId} sincronizado (${settings.crmAdapter}).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await upsertCrmSync({
        conversationId: payload.conversationId,
        crmAdapter: settings.crmAdapter,
        status: "failed",
        lastError: msg,
      });
      throw err; // deixa o worker re-tentar
    }
  }
}
