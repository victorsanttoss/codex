import { Injectable, Logger } from "@nestjs/common";
import {
  armCadence,
  cancelPendingOutbox,
  claimDueCadence,
  completeCadence,
  countOutboxSentSince,
  enqueueOutbox,
  getConversationContact,
  getLeadProfile,
  isContactOptedOut,
  isHumanTakeover,
  markContactOptedOut,
  stopCadence,
} from "@sdr/db";
import { CadenceConfigService, withinBusinessHours } from "./cadence-config.service";
import { TemplateService, TemplateError } from "./template.service";

// `scheduled` (0034) também é resolvido: lead com horário marcado não recebe
// follow-up proativo de re-engajamento.
const RESOLVED = new Set(["qualified", "handoff", "disqualified", "scheduled"]);

/**
 * Motor de cadência. Os GUARDRAILS de compliance são re-checados NO MOMENTO DO
 * ENVIO (não só ao armar) — cancelamento é trivial. Disparo proativo só por
 * template (fora da janela 24h), idempotente via outbox.
 */
@Injectable()
export class CadenceService {
  private readonly logger = new Logger(CadenceService.name);

  constructor(
    private readonly config: CadenceConfigService,
    private readonly templates: TemplateService,
  ) {}

  /** Qualquer inbound PARA a cadência ativa (stop-on-engagement) + cancela pendências. */
  async onInbound(conversationId: string): Promise<void> {
    await stopCadence(conversationId, "engagement");
    await cancelPendingOutbox(conversationId, "engagement"); // nada proativo já enfileirado sai
  }

  /** Opt-out (LGPD): marca o contato, para a cadência e CANCELA pendências. */
  async optOut(conversationId: string, waId: string): Promise<void> {
    await markContactOptedOut(waId);
    await stopCadence(conversationId, "opted_out");
    await cancelPendingOutbox(conversationId, "opted_out");
  }

  /** Arma o 1º passo ao fim de um turno sem resolução (se habilitado e não opt-out). */
  async armFirstStep(conversationId: string): Promise<void> {
    const settings = await this.config.forTenant();
    if (!settings.enabled || settings.steps.length === 0) return;
    const contact = await getConversationContact(conversationId);
    if (!contact || (await isContactOptedOut(contact.waId))) return;
    const delayMs = settings.steps[0]!.delayMinutes * 60_000;
    await armCadence(conversationId, 0, new Date(Date.now() + delayMs));
  }

  /**
   * Varre cadências vencidas e dispara o passo — RE-CHECANDO todos os guardrails
   * agora. Retorna quantos passos foram enfileirados.
   */
  async scanAndDispatch(now: Date = new Date()): Promise<number> {
    const settings = await this.config.forTenant();
    if (!settings.enabled) return 0;
    const due = await claimDueCadence(50);
    let dispatched = 0;

    for (const c of due) {
      // 1) lead resolvido (qualificado/handoff/desqualificado) → para.
      const lead = await getLeadProfile(c.conversationId);
      if (lead && RESOLVED.has(lead.status)) {
        await stopCadence(c.conversationId, "resolved");
        continue;
      }
      const contact = await getConversationContact(c.conversationId);
      if (!contact) {
        await stopCadence(c.conversationId, "no_contact");
        continue;
      }
      // 2) opt-out → para.
      if (await isContactOptedOut(contact.waId)) {
        await stopCadence(c.conversationId, "opted_out");
        continue;
      }
      // 2b) humano assumiu a conversa → o robô NÃO faz follow-up; para a cadência.
      if (await isHumanTakeover(c.conversationId)) {
        await stopCadence(c.conversationId, "human_takeover");
        continue;
      }
      // 3) passos esgotados → completa.
      if (c.currentStep >= settings.steps.length) {
        await completeCadence(c.conversationId);
        continue;
      }
      // 4) fora do horário comercial → ADIA (não avança; re-tentado no próximo tick).
      if (!withinBusinessHours(settings, now)) continue;
      // 5) teto de frequência → ADIA.
      const phone = contact.phone ?? contact.waId;
      const since = new Date(now.getTime() - settings.frequencyWindowHours * 3_600_000);
      if ((await countOutboxSentSince(phone, since)) >= settings.frequencyCap) continue;

      // 6) template aprovado? (fora da janela só template)
      const step = settings.steps[c.currentStep]!;
      let payload;
      try {
        payload = await this.templates.resolve(step.templateName, step.languageCode);
      } catch (err) {
        if (err instanceof TemplateError) {
          this.logger.warn(`Cadência ${c.conversationId}: ${err.message} — parando.`);
          await stopCadence(c.conversationId, "template_missing");
          continue;
        }
        throw err;
      }

      // 7) enfileira no outbox (idempotente por passo).
      const key = `cadence:${c.conversationId}:${c.currentStep}`;
      const { created } = await enqueueOutbox({
        conversationId: c.conversationId,
        toPhone: phone,
        kind: "template",
        payload: payload as unknown as Record<string, unknown>,
        idempotencyKey: key,
        clientMessageId: key,
        billing: "template",
      });
      // Concorrência (achado Codex): só o worker que REALMENTE criou o outbox
      // conta o dispatch. Mas o AVANÇO do passo roda MESMO com `created=false`:
      // se o scheduler morreu ENTRE o enqueue e o avanço, o próximo scan encontra
      // a mesma cadência vencida, o enqueue devolve created=false (idempotency_key
      // por passo garante envio único) e a cadência DESTRAVA aqui. Avançar em
      // dobro é inócuo: armCadence/completeCadence são idempotentes por passo.
      if (created) dispatched++;

      // 8) avança (ou completa).
      const nextStep = c.currentStep + 1;
      if (nextStep >= settings.steps.length) {
        await completeCadence(c.conversationId);
      } else {
        const delayMs = settings.steps[nextStep]!.delayMinutes * 60_000;
        await armCadence(c.conversationId, nextStep, new Date(now.getTime() + delayMs));
      }
    }
    return dispatched;
  }
}
