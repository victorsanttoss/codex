import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { TenantSecretKind } from "@sdr/core";
import {
  claimDueOutbox,
  enqueueOutbox,
  getActiveConnectionForTenant,
  getConversationContact,
  getConversationWindow,
  getLeadProfile,
  isContactOptedOut,
  isHumanTakeover,
  isWithinServiceWindow,
  claimHumanOutbox,
  listConnectionsForTenant,
  markOutboxCanceled,
  markOutboxFailed,
  markOutboxSent,
  recordOutboundMessage,
  recordSentOutbox,
  recordUsage,
  type ClaimedOutbox,
  type ClaimRouting,
  type EnqueueOutboxInput,
  type OutboxBilling,
} from "@sdr/db";
import { ChannelSendError } from "@sdr/whatsapp-cloud";
import { BaileysSendError } from "@sdr/whatsapp-baileys";
import { ChannelFactory } from "../whatsapp/channel-factory.service";
import { safeErrorFields } from "../observability/logger";

/** `transient` de qualquer erro de canal (Cloud/Baileys); desconhecido = transiente. */
function isSendErrorTransient(err: unknown): boolean {
  if (err instanceof ChannelSendError || err instanceof BaileysSendError)
    return err.transient;
  return true;
}

// `scheduled` (0034) também é resolvido: lead com horário marcado não recebe
// follow-up proativo de re-engajamento.
const RESOLVED = new Set(["qualified", "handoff", "disqualified", "scheduled"]);

const BASE_BACKOFF_MS = 30_000;

/**
 * Seam de ENVIO proativo pelo canal NÃO-OFICIAL (M13). Implementado pelo
 * SessionManager e REGISTRADO via `setBaileysOutbound` SÓ no session-worker (evita
 * dependência circular de módulo). O scheduler não o registra e, por isso, não
 * envia por Baileys — o tick do session-worker processa esses números. Roteamento
 * sticky: só o worker dono do socket envia.
 */
export interface BaileysOutbound {
  ownsLiveSocket(phoneNumberId: string): boolean;
  /** `clientMessageId` → messageId do WhatsApp (envio idempotente; sem dupla entrega). */
  sendText(
    phoneNumberId: string,
    toPhone: string,
    text: string,
    clientMessageId?: string,
  ): Promise<{ id: string }>;
}

/**
 * OUTBOX de saída: enfileira (idempotente) e PROCESSA o envio com garantia
 * at-least-once. O `client_message_id` vira `biz_opaque_callback_data` no
 * provedor (dedup/correlação): um reenvio após crash não entrega 2×.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  private baileys?: BaileysOutbound;

  constructor(private readonly channels: ChannelFactory) {}

  /** Registra o seam de envio Baileys (chamado só no session-worker, M13). */
  setBaileysOutbound(seam: BaileysOutbound): void {
    this.baileys = seam;
  }

  /** Enfileira no contexto do tenant ativo (reivindica via idempotency_key). */
  async enqueue(
    input: EnqueueOutboxInput,
  ): Promise<{ outboxId: string; created: boolean }> {
    return enqueueOutbox(input);
  }

  /**
   * NÚCLEO COMPARTILHADO com o caminho REATIVO (dívida M8): registra no MESMO
   * livro-razão (outbox) uma resposta do agente que JÁ foi enviada, + o metering.
   * A linha nasce `sent` e não é reivindicada pelo scheduler. Webhooks reconciliam
   * delivered/read pelo external_message_id. Por padrão é best-effort; turnos
   * duráveis pedem strict para que falha do ledger permaneça observável como
   * entrega incerta, sem reenvio automático. Metering continua best-effort.
   */
  async recordReactiveDelivery(
    i: {
      conversationId: string;
      toPhone: string;
      text: string;
      externalMessageId: string;
      provider: string;
      billing?: OutboxBilling;
    },
    options?: { strict?: boolean },
  ): Promise<void> {
    const billing = i.billing ?? "service";
    try {
      await recordSentOutbox({
        conversationId: i.conversationId,
        toPhone: i.toPhone,
        payload: { text: i.text },
        idempotencyKey: `reactive:${i.externalMessageId}`,
        externalMessageId: i.externalMessageId,
        billing,
      });
    } catch (err) {
      this.logger.warn({
        event: "reactive_ledger_failed",
        conversationId: i.conversationId,
        error: safeErrorFields(err),
      });
      // Durable reactive turns must retain ambiguous post-send failures. Other
      // callers preserve the prior best-effort policy; metering stays best-effort.
      if (options?.strict) throw err;
    }
    await this.meter(billing, "free_form", false, i.provider);
  }

  /** Metering de saída compartilhado (reativo e proativo) — best-effort. */
  private async meter(
    billing: string,
    kind: string,
    proactive: boolean,
    provider?: string,
  ): Promise<void> {
    try {
      await recordUsage({
        type: "outbound_message",
        channel: "whatsapp",
        metadata: {
          billing,
          proactive,
          kind,
          ...(provider ? { provider } : {}),
        },
      });
    } catch (err) {
      this.logger.warn({
        event: "outbound_metering_failed",
        error: safeErrorFields(err),
      });
    }
  }

  /**
   * Processa um lote de `pending` vencidos (no contexto do tenant ativo). Retorna
   * quantos foram ENVIADOS. Idempotente/seguro p/ rodar concorrente (SKIP LOCKED).
   *
   * MULTI-CONEXÃO (migration 0030): a partição cloud/baileys acontece NO CLAIM,
   * linha a linha, pela conexão gravada no enqueue — o scheduler (sem o seam)
   * reivindica só linhas Cloud; o session-worker só linhas Baileys cujos sockets
   * vivem NELE. Tenant com os dois provedores não starva nenhuma partição e a
   * mensagem sai pelo NÚMERO da conversa, não pelo default do tenant. Linhas sem
   * connection_id (legado) seguem o fallback por tenant de sempre.
   */
  async processDue(batch = 20): Promise<number> {
    const fallback = await getActiveConnectionForTenant();
    let routing: ClaimRouting;
    if (this.baileys) {
      // session-worker: só números Baileys com socket ABERTO neste worker.
      const owned = (await listConnectionsForTenant("baileys"))
        .filter((c) => this.baileys!.ownsLiveSocket(c.phoneNumberId))
        .map((c) => c.phoneNumberId);
      const includeUnrouted =
        !!fallback &&
        fallback.provider === "baileys" &&
        this.baileys.ownsLiveSocket(fallback.phoneNumberId);
      if (owned.length === 0 && !includeUnrouted) return 0; // nada enviável daqui
      routing = { provider: "baileys", phoneNumberIds: owned, includeUnrouted };
    } else {
      // scheduler/api: só linhas Cloud. Linhas sem conexão entram quando o
      // fallback do tenant NÃO é Baileys (inclui tenant sem conexão nenhuma —
      // falha observável abaixo, como antes).
      routing = {
        provider: "cloud_api",
        includeUnrouted: !fallback || fallback.provider !== "baileys",
      };
    }
    const claimed = await claimDueOutbox(batch, undefined, routing);
    if (claimed.length === 0) return 0;
    let sent = 0;
    for (const row of claimed) {
      // Roteamento: conexão DA LINHA; sem vínculo, fallback por tenant.
      const conn = row.connection ?? fallback;
      if (!conn) {
        await markOutboxFailed(
          row.id,
          "tenant sem conexão ativa",
          row.attempts,
          row.maxAttempts,
          BASE_BACKOFF_MS,
        );
        continue;
      }
      // Conexão da linha fora do ar (disconnected/revoked): não envia por OUTRO
      // número (seria o bug do número errado) — re-tenta até voltar ou esgotar.
      if (row.connection && row.connection.status !== "active") {
        await markOutboxFailed(
          row.id,
          `conexão ${row.connection.phoneNumberId} indisponível (${row.connection.status})`,
          row.attempts,
          row.maxAttempts,
          BASE_BACKOFF_MS * 2 ** Math.max(0, row.attempts - 1),
        );
        continue;
      }
      // GUARDRAIL no ENVIO: o lead pode ter optado-out/respondido/sido resolvido
      // ENTRE o enfileiramento e agora. Revalida e CANCELA (terminal) se preciso.
      const cancel = await this.shouldCancel(row);
      if (cancel) {
        await markOutboxCanceled(row.id, cancel);
        this.logger.log(`Outbox ${row.id} cancelado no envio: ${cancel}.`);
        continue;
      }

      let externalId: string;
      try {
        externalId = await this.send(conn, row);
      } catch (err) {
        // Erro permanente (Cloud OU Baileys) → falha direto; senão, retry. Ambos
        // os erros de canal expõem `transient`; erro desconhecido = transiente.
        const transient = isSendErrorTransient(err);
        await markOutboxFailed(
          row.id,
          err instanceof Error ? err.message : "erro de envio",
          transient ? row.attempts : row.maxAttempts, // permanente → falha direto
          row.maxAttempts,
          BASE_BACKOFF_MS * 2 ** Math.max(0, row.attempts - 1),
        );
        this.logger.warn(
          `Outbox ${row.id} falhou (attempt ${row.attempts}): ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      // marca enviado FORA do try do envio (metering nunca rebaixa 'sent').
      await markOutboxSent(row.id, externalId);
      sent++;
      // metering best-effort compartilhado — falha aqui não reabre a mensagem.
      await this.meter(row.billing, row.kind, true, conn.provider);
    }
    return sent;
  }

  /** Revalida guardrails no envio; retorna o motivo de cancelamento ou null. */
  private async shouldCancel(row: ClaimedOutbox): Promise<string | null> {
    if (!row.conversationId) return null;
    const contact = await getConversationContact(row.conversationId);
    if (contact && (await isContactOptedOut(contact.waId))) return "opted_out";
    const lead = await getLeadProfile(row.conversationId);
    if (lead && RESOLVED.has(lead.status)) return "resolved";
    // Humano assumiu a conversa: nada PROATIVO enfileirado (cadência/outbox) sai
    // por cima do atendimento. Só linhas proativas passam por aqui (reativas
    // nascem 'sent' e nunca são reivindicadas).
    if (await isHumanTakeover(row.conversationId)) return "human_takeover";
    if (row.kind === "free_form") {
      const window = await getConversationWindow(row.conversationId);
      if (!isWithinServiceWindow(window)) return "out_of_window";
    }
    return null;
  }

  /**
   * ENVIO MANUAL do humano pelo painel (conversa em takeover): IDEMPOTENTE por
   * `clientKey` do painel (achado Codex) — a linha entra no livro-razão ANTES do
   * provedor (`claimHumanOutbox`, origin='human'); retry do painel com a mesma
   * chave não reenvia (devolve `deduped`), requisição concorrente devolve
   * `in_flight`. Sucesso grava o outbound no histórico (`messages`, como o
   * reply() do agente). Os guardrails (takeover/opt-out/janela 24h) são do
   * CHAMADOR (painel). Síncrono: usa o timeout dos adaptadores.
   */
  async sendHumanMessage(i: {
    conversationId: string;
    toPhone: string;
    text: string;
    clientKey: string;
    connection: {
      connectionId?: string;
      phoneNumberId: string;
      secretRef: string;
      provider: string;
    };
  }): Promise<
    | { state: "sent"; externalMessageId: string; messageId: string }
    | { state: "deduped"; externalMessageId: string | null; createdAt: Date }
    | { state: "in_flight" }
  > {
    const claim = await claimHumanOutbox({
      conversationId: i.conversationId,
      ...(i.connection.connectionId
        ? { connectionId: i.connection.connectionId }
        : {}),
      toPhone: i.toPhone,
      text: i.text,
      idempotencyKey: `human:client:${i.clientKey}`,
    });
    if (claim.state === "already_sent") {
      return {
        state: "deduped",
        externalMessageId: claim.externalMessageId,
        createdAt: claim.createdAt,
      };
    }
    if (claim.state === "in_flight") return { state: "in_flight" };

    let externalId: string;
    try {
      externalId = await this.send(i.connection, {
        toPhone: i.toPhone,
        kind: "free_form",
        payload: { text: i.text },
        clientMessageId: `human-${i.clientKey}`, // determinístico: Baileys deduplica reenvio
      });
    } catch (err) {
      // Libera para retry legítimo do painel (claim reabre linhas 'failed').
      const msg = err instanceof Error ? err.message : String(err);
      await markOutboxFailed(claim.outboxId, msg, 1, 1, 0).catch((e) =>
        this.logger.warn(
          `markOutboxFailed humano falhou: ${e instanceof Error ? e.message : e}`,
        ),
      );
      throw err;
    }
    await markOutboxSent(claim.outboxId, externalId);
    // Histórico da conversa — mesmo registro que o caminho reativo faz. A mensagem
    // JÁ chegou ao lead: falha aqui não pode falhar o request (retry deduparia).
    let messageId = "";
    try {
      const rec = await recordOutboundMessage({
        conversationId: i.conversationId,
        type: "text",
        content: { text: i.text },
        externalMessageId: externalId,
      });
      messageId = rec.messageId;
    } catch (err) {
      this.logger.error(
        `histórico do envio humano falhou (${externalId}): ${err instanceof Error ? err.message : err}`,
      );
    }
    await this.meter("service", "free_form", false, i.connection.provider);
    return { state: "sent", externalMessageId: externalId, messageId };
  }

  private async send(
    conn: { phoneNumberId: string; secretRef: string; provider: string },
    row: Pick<
      ClaimedOutbox,
      "toPhone" | "kind" | "payload" | "clientMessageId"
    >,
  ): Promise<string> {
    // Baileys (não-oficial): envia pelo SOCKET do worker dono; SEM HSM → template
    // vira texto. Os guardrails do M8 (shouldCancel) já rodaram acima.
    if (conn.provider === "baileys") {
      if (!this.baileys)
        throw new ChannelSendError("Sem seam Baileys neste processo.", false);
      // FAIL-CLOSED (achado Codex): template sem corpo mandaria o NOME do
      // template ao lead ("followup_1") — erro permanente, nunca lead-facing.
      if (row.kind === "template") {
        const body = (row.payload as { bodyText?: string }).bodyText;
        if (typeof body !== "string" || !body.trim()) {
          throw new ChannelSendError(
            `Template '${(row.payload as { templateName?: string }).templateName ?? "?"}' sem bodyText — envio não-oficial bloqueado.`,
            false,
          );
        }
      }
      const text =
        row.kind === "template"
          ? renderTemplateText(row.payload)
          : (row.payload as { text: string }).text;
      // clientMessageId → messageId do WhatsApp (idempotência: reenvio órfão após
      // crash não duplica a entrega).
      const res = await this.baileys.sendText(
        conn.phoneNumberId,
        row.toPhone,
        text,
        row.clientMessageId,
      );
      return res.id;
    }
    const sender = await this.channels.tenantSender(
      conn.phoneNumberId,
      conn.secretRef as TenantSecretKind,
    );
    if (row.kind === "template") {
      const p = row.payload as {
        templateName: string;
        languageCode: string;
        variables?: Record<string, string>;
      };
      const res = await sender.sendTemplate({
        to: row.toPhone,
        templateName: p.templateName,
        languageCode: p.languageCode,
        clientMessageId: row.clientMessageId,
        ...(p.variables ? { variables: p.variables } : {}),
      });
      return res.externalMessageId;
    }
    const p = row.payload as { text: string };
    const res = await sender.sendMessage({
      to: row.toPhone,
      text: p.text,
      clientMessageId: row.clientMessageId,
    });
    return res.externalMessageId;
  }
}

/**
 * Render textual de um template (sem HSM). Preferência: `bodyText` (M8-ext — a
 * mensagem ESCRITA PELO CLIENTE no catálogo). Fallback legado: nome+variáveis
 * (templates antigos sem corpo; nunca deveria chegar ao lead em produção).
 */
function renderTemplateText(payload: unknown): string {
  const p = payload as {
    templateName?: string;
    variables?: Record<string, string>;
    bodyText?: string;
  };
  if (typeof p.bodyText === "string" && p.bodyText.trim()) return p.bodyText;
  const name = p.templateName ?? "";
  const vars = p.variables
    ? Object.keys(p.variables)
        .sort()
        .map((k) => p.variables![k])
    : [];
  return vars.length > 0 ? `${name}: ${vars.join(" ")}` : name;
}
