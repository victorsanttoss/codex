import { Injectable, Logger } from "@nestjs/common";
import { runWithTenant, type InboundWebhookRequest } from "@sdr/core";
import { findConnectionsByWaba, setConnectionStatus, type ConnectionStatus } from "@sdr/db";
import { ChannelFactory } from "./channel-factory.service";

/**
 * Handler ADITIVO de eventos de conta da Meta (`account_update`) — fora da
 * pipeline de mensagem. Revogação/ban/restrição transicionam o status de TODAS
 * as conexões da WABA (o resolver do M2 já filtra `active`, então para de rotear).
 */
@Injectable()
export class AccountEventsService {
  private readonly logger = new Logger(AccountEventsService.name);

  constructor(private readonly channels: ChannelFactory) {}

  async process(request: InboundWebhookRequest): Promise<void> {
    const events = this.channels.platformNormalizer().normalizeAccountEvents(request);
    for (const ev of events) {
      if (!ev.wabaId) continue;
      const { status, known } = classifyEvent(ev.event);
      if (!known) {
        this.logger.warn(`Evento de conta DESCONHECIDO '${ev.event}' (waba ${ev.wabaId}) — revisar.`);
      }
      if (!status) continue; // evento conhecido sem transição, ou desconhecido

      const target = await findConnectionsByWaba(ev.wabaId);
      if (!target) {
        this.logger.warn(`account_update '${ev.event}' p/ waba ${ev.wabaId} sem conexão conhecida.`);
        continue;
      }
      await runWithTenant({ tenantId: target.tenantId }, async () => {
        for (const pnid of target.phoneNumberIds) await setConnectionStatus(pnid, status);
      });
      this.logger.warn(
        `${target.phoneNumberIds.length} conexão(ões) -> ${status} por '${ev.event}' (tenant ${target.tenantId}).`,
      );
    }
  }
}

/**
 * Allowlist de eventos conhecidos da Meta (`account_update`). Eventos não
 * mapeados são logados para revisão e não mudam status (fail-safe).
 */
const KNOWN_EVENTS: Record<string, ConnectionStatus | "noop"> = {
  ACCOUNT_DELETED: "revoked",
  ACCOUNT_BANNED: "revoked",
  ACCOUNT_VIOLATION: "revoked",
  DISABLED_UPDATE: "revoked",
  PARTNER_APP_UNINSTALLED: "revoked",
  ACCOUNT_RESTRICTION: "disconnected",
  PARTNER_ADDED: "noop",
  PHONE_NUMBER_QUALITY_UPDATE: "noop",
  PHONE_NUMBER_NAME_UPDATE: "noop",
  ACCOUNT_UPDATE: "noop",
};

export function classifyEvent(event: string): { status?: ConnectionStatus; known: boolean } {
  const e = KNOWN_EVENTS[event.toUpperCase()];
  if (e === undefined) return { known: false };
  return e === "noop" ? { known: true } : { status: e, known: true };
}
