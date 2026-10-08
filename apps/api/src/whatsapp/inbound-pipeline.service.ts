import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  runWithTenant,
  type InboundWebhookRequest,
  type NormalizedInboundMessage,
  type NormalizedStatusEvent,
  type TenantSecretKind,
} from "@sdr/core";
import {
  findConnectionOwner,
  getConversationWindow,
  isWithinServiceWindow,
  isHumanTakeover,
  isContactOptedOut,
  markMessageStatusByExternalId,
  quarantineInbound,
  recordOutboundMessage,
  reconcileOutboxStatus,
  resolveConnectionByPhoneNumberId,
  setConnectionStatus,
  type AgentTurnRow,
  type ResolvedConnection,
} from "@sdr/db";
import { ChannelSendError } from "@sdr/whatsapp-cloud";
import { ChannelFactory } from "./channel-factory.service";
import { InboundCoreService } from "./inbound-core.service";
import { bubblePauseMs, formatWhatsAppReply } from "./reply-format";
import { OutboxService } from "../outbox/outbox.service";
import type { LockHandle } from "../queue/redis-mutex";
import { ReplyDeliveryError, type ReplyOptions } from "./message-handler";
import { logCorrelationId, safeErrorFields } from "../observability/logger";

/** Espera CURTA pelo FIFO-lock: contenção vira retry via fila (não gira 25s no slot). */
const LOCK_WAIT_MS = 2_000;

/**
 * Erro agregado do processamento do webhook: uma ou mais mensagens/status
 * falharam. Propaga para o worker BullMQ FALHAR o job e re-tentar com backoff
 * (at-least-once): as já processadas são puladas pelo dedup pós-sucesso.
 */
export class InboundProcessingError extends Error {
  constructor(readonly causes: unknown[]) {
    super(`Falha em ${causes.length} evento(s) do webhook`);
    this.name = "InboundProcessingError";
  }
}

/**
 * Pipeline de entrada do WhatsApp:
 *   webhook -> normalizar -> resolver tenant (system) -> FIFO por conversa ->
 *   dedup (pós-sucesso) -> persistir -> baixar mídia -> handler -> echo
 *   outbound -> metering. Eventos de status atualizam as mensagens outbound.
 */
@Injectable()
export class InboundPipelineService {
  private readonly logger = new Logger(InboundPipelineService.name);

  constructor(
    private readonly channels: ChannelFactory,
    private readonly core: InboundCoreService,
    private readonly outbox: OutboxService,
  ) {}

  async process(request: InboundWebhookRequest): Promise<void> {
    const normalizer = this.channels.platformNormalizer();
    if (!normalizer.verifySignature(request)) {
      this.logger.warn("Webhook com assinatura inválida — ignorado.");
      return;
    }
    const messages = normalizer.normalizeInboundWebhook(request);
    const statuses = normalizer.normalizeStatusEvents(request);

    // Processa TODOS os eventos do webhook e só então re-lança (agregado): uma
    // mensagem ruim não bloqueia as demais NESTA tentativa, mas o job FALHA e o
    // BullMQ re-tenta com backoff — sem isso, o catch engolia o erro e o dedup
    // impedia o reprocesso (perda permanente da mensagem).
    const errors: unknown[] = [];
    // Um webhook pode ter VÁRIAS mensagens do mesmo número: quarentena uma vez
    // por phone_number_id (o payload inteiro é reprocessado no replay; o dedup
    // pula o que já foi processado).
    const quarantined = new Set<string>();
    for (const msg of messages) {
      try {
        await this.processMessage(msg, request, quarantined);
      } catch (err) {
        this.logger.error({
          event: "inbound_processing_failed",
          messageRef: logCorrelationId(msg.externalMessageId),
          error: safeErrorFields(err),
        });
        errors.push(err);
      }
    }
    for (const st of statuses) {
      try {
        await this.processStatus(st);
      } catch (err) {
        this.logger.error({
          event: "inbound_status_failed",
          messageRef: logCorrelationId(st.externalMessageId),
          error: safeErrorFields(err),
        });
        errors.push(err);
      }
    }
    if (errors.length > 0) throw new InboundProcessingError(errors);
  }

  private async processMessage(
    msg: NormalizedInboundMessage,
    request: InboundWebhookRequest,
    quarantined: Set<string>,
  ): Promise<void> {
    const pnid = msg.channelAccountId;
    if (!pnid) return;
    const conn = await resolveConnectionByPhoneNumberId(pnid);
    if (!conn) {
      // O resolve só devolve conexões `active`. Se a conexão EXISTE mas está
      // fora do ar (token 401, desconexão temporária), a mensagem do lead NÃO
      // pode sumir: vai para a QUARENTENA (0032) e o sweep re-enfileira o
      // payload quando a conexão voltar. `revoked` é terminal — não quarentena.
      await this.quarantineIfDisconnected(pnid, request, quarantined);
      return;
    }
    // Núcleo compartilhado (FIFO→dedup→persiste→mídia→agente); o ENVIO da resposta
    // é o closure específico do Cloud (HTTP + janela de 24h). Espera curta pelo
    // lock: se a conversa está ocupada, LockTimeoutError propaga e a fila re-tenta.
    await this.core.handle(
      msg,
      conn,
      (m, conversationId, handle) =>
        this.makeReply(pnid, conn.secretRef, m, conversationId, handle),
      { lockWaitMs: LOCK_WAIT_MS },
    );
  }

  /** Replay only the persisted agent plan; core supplies tenant/FIFO fencing. */
  async recoverTurn(
    turn: AgentTurnRow,
    conn: ResolvedConnection,
    phoneNumberId: string,
  ): Promise<void> {
    await this.core.resumeStoredTurn(
      turn,
      conn,
      (msg, conversationId, handle) =>
        this.makeReply(
          phoneNumberId,
          conn.secretRef,
          msg,
          conversationId,
          handle,
        ),
      { lockWaitMs: LOCK_WAIT_MS },
    );
  }

  /**
   * BEST-EFFORT: guarda o payload do webhook em quarentena quando a conexão do
   * número existe mas não está `active` (disconnected/connecting). Falha aqui
   * NÃO derruba o job (o comportamento antigo era descartar; a quarentena é
   * estritamente melhor) — só loga.
   */
  private async quarantineIfDisconnected(
    pnid: string,
    request: InboundWebhookRequest,
    quarantined: Set<string>,
  ): Promise<void> {
    if (quarantined.has(pnid)) return; // já guardado para este webhook
    try {
      const owner = await findConnectionOwner(pnid);
      if (
        !owner ||
        (owner.status !== "disconnected" && owner.status !== "connecting")
      ) {
        this.logger.warn({
          event: "inbound_connection_missing",
          accountRef: logCorrelationId(pnid),
        });
        return;
      }
      const id = await quarantineInbound({
        tenantId: owner.tenantId,
        phoneNumberId: pnid,
        payload: {
          headers: request.headers,
          query: request.query,
          rawBody: request.rawBody,
        },
      });
      quarantined.add(pnid);
      this.logger.warn({
        event: "inbound_quarantined",
        accountRef: logCorrelationId(pnid),
        status: owner.status,
        quarantineId: id,
      });
    } catch (err) {
      this.logger.error({
        event: "inbound_quarantine_failed",
        accountRef: logCorrelationId(pnid),
        error: safeErrorFields(err),
      });
    }
  }

  /**
   * Closure de resposta: respeita a janela de 24h, envia PICADO em bolhas como
   * um humano (reply-format: parágrafo = mensagem; sanitiza markdown/[n]) e
   * persiste cada bolha. O Graph não oferece chave de idempotência: qualquer
   * envio ambíguo/ parcial é `uncertain`, para conciliação sem reenvio automático.
   */
  private makeReply(
    phoneNumberId: string,
    secretRef: TenantSecretKind,
    msg: NormalizedInboundMessage,
    conversationId: string,
    handle: LockHandle,
  ): (text: string, options?: ReplyOptions) => Promise<void> {
    return async (text: string, options?: ReplyOptions) => {
      let attempted = 0;
      let accepted = 0;
      try {
        if (
          msg.provider !== "cloud_api" ||
          (msg.channelAccountId && msg.channelAccountId !== phoneNumberId)
        ) {
          throw new Error("reply_connection_mismatch");
        }
        // No internal network retries: a timeout may already have delivered a
        // bubble. The durable turn decides whether a later retry is safe.
        const sender = await this.channels.tenantSender(
          phoneNumberId,
          secretRef,
          {
            retry: { maxAttempts: 1, baseDelayMs: 0 },
          },
        );
        const bubbles = formatWhatsAppReply(text);
        if (bubbles.length === 0) throw new Error("reply_empty");
        for (let i = 0; i < bubbles.length; i++) {
          const bubble = bubbles[i]!;
          if (i > 0) await this.bubblePause(bubblePauseMs(bubble));
          if (!(await handle.isValid())) throw new Error("reply_lock_lost");
          if (
            !options?.allowOptOutReply &&
            ((await isHumanTakeover(conversationId)) ||
              (await isContactOptedOut(msg.from)))
          ) {
            throw new Error("reply_current_policy_blocked");
          }
          // Read the CURRENT persisted window, including more recent inbound.
          // Recovery never fabricates a new inbound timestamp/window.
          if (
            !isWithinServiceWindow(await getConversationWindow(conversationId))
          ) {
            throw new Error("reply_window_closed");
          }
          let sent;
          attempted++;
          try {
            sent = await sender.sendMessage({ to: msg.from, text: bubble });
          } catch (err) {
            if (
              err instanceof ChannelSendError &&
              (err.status === 401 || String(err.providerCode) === "190")
            ) {
              try {
                await setConnectionStatus(phoneNumberId, "disconnected");
              } catch (statusError) {
                this.logger.error({
                  event: "reply_connection_status_failed",
                  error: safeErrorFields(statusError),
                });
              }
            }
            throw err;
          }
          accepted++;
          await recordOutboundMessage({
            conversationId,
            type: "text",
            content: { text: bubble },
            externalMessageId: sent.externalMessageId,
          });
          await this.outbox.recordReactiveDelivery(
            {
              conversationId,
              toPhone: msg.from,
              text: bubble,
              externalMessageId: sent.externalMessageId,
              provider: "cloud_api",
            },
            { strict: true },
          );
        }
      } catch (err) {
        const definiteFirstRejection =
          attempted === 1 &&
          accepted === 0 &&
          err instanceof ChannelSendError &&
          err.status !== undefined &&
          err.status >= 400 &&
          err.status < 500 &&
          err.status !== 408;
        throw new ReplyDeliveryError(
          attempted === 0 || definiteFirstRejection ? "not_sent" : "uncertain",
          "cloud_reply_failed",
          { cause: err },
        );
      }
    };
  }

  /** Pausa entre bolhas — injetável p/ testes determinísticos. */
  bubblePause: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms));

  private async processStatus(st: NormalizedStatusEvent): Promise<void> {
    const pnid = st.channelAccountId;
    if (!pnid) return;
    const conn = await resolveConnectionByPhoneNumberId(pnid);
    if (!conn) return;
    await runWithTenant({ tenantId: conn.tenantId }, async () => {
      await markMessageStatusByExternalId(
        st.externalMessageId,
        st.status,
        st.error as Record<string, unknown> | undefined,
      );
      // Reconciliação do outbox (M8): avança a linha de saída por external_message_id.
      if (
        st.status === "delivered" ||
        st.status === "read" ||
        st.status === "failed"
      ) {
        await reconcileOutboxStatus(st.externalMessageId, st.status);
      }
    });
  }
}
