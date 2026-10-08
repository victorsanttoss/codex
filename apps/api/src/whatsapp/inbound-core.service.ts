import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { runWithTenant, type NormalizedInboundMessage } from "@sdr/core";
import {
  isMessageProcessed,
  getAgentTurn,
  markMessageProcessed,
  recordInboundMessage,
  recordUsage,
  setInboundTranscription,
  type ResolvedConnection,
  type AgentTurnRow,
} from "@sdr/db";
import { MediaService } from "./media.service";
import { AudioEnrichmentService } from "../transcription/audio-enrichment.service";
import { SerializedRunner } from "../queue/serialized-runner";
import type { LockHandle } from "../queue/redis-mutex";
import {
  INBOUND_HANDLER,
  ReplyDeliveryError,
  type InboundMessageHandler,
  type ReplyOptions,
} from "./message-handler";
import { InboundRateLimitService } from "./inbound-rate-limit.service";
import { ImobBrokerInboundService } from "../imobiliario/imob-broker-inbound.service";
import { logCorrelationId, safeErrorFields } from "../observability/logger";

/** Fábrica do closure de resposta — varia por canal (Cloud HTTP vs Baileys socket). */
export type ReplyFactory = (
  msg: NormalizedInboundMessage,
  conversationId: string,
  handle: LockHandle,
) => (text: string, options?: ReplyOptions) => Promise<void>;

export interface InboundHandleOptions {
  /**
   * Tempo máximo aguardando o FIFO-lock da conversa. Canais com retry durável
   * (fila BullMQ) devem usar espera CURTA e re-tentar via fila em vez de girar
   * segurando o slot do worker (o `LockTimeoutError` propaga).
   */
  lockWaitMs?: number;
}

/**
 * NÚCLEO de entrada COMPARTILHADO entre os canais (Cloud API e Baileys). Faz
 * dedup → FIFO por conversa → persiste inbound → baixa/transcreve mídia → chama
 * o agente (INBOUND_HANDLER) com um closure de resposta INJETADO pelo canal.
 * O agente/RAG/CRM/cadência NÃO mudam; só a forma de enviar a resposta difere.
 */
@Injectable()
export class InboundCoreService {
  private readonly logger = new Logger(InboundCoreService.name);

  constructor(
    private readonly media: MediaService,
    private readonly audio: AudioEnrichmentService,
    private readonly runner: SerializedRunner,
    @Inject(INBOUND_HANDLER) private readonly handler: InboundMessageHandler,
    // @Optional: construções manuais em teste (4 args) seguem válidas; produção
    // injeta o rate-limit por conversa (anti-flood).
    @Optional() private readonly rateLimit?: InboundRateLimitService,
    // Vertical imobiliária (fork): mensagem de CORRETOR cadastrado é desviada
    // para o fluxo de aceite/status — nunca cai no agente SDR de qualificação.
    @Optional() private readonly brokerInbound?: ImobBrokerInboundService,
  ) {}

  /** Processa uma mensagem normalizada no contexto do tenant da conexão. */
  async handle(
    msg: NormalizedInboundMessage,
    conn: ResolvedConnection,
    replyFactory: ReplyFactory,
    opts?: InboundHandleOptions,
  ): Promise<void> {
    // Anti-flood por conversa/número ANTES de qualquer trabalho (lock/DB/LLM): o
    // excesso é descartado silenciosamente (só log). Limite folgado — conversa
    // legítima não chega perto.
    if (this.rateLimit && !(await this.rateLimit.allow(msg.conversationKey))) {
      this.logger.warn({
        event: "inbound_rate_limited",
        tenantId: conn.tenantId,
        conversationRef: logCorrelationId(msg.conversationKey),
      });
      return;
    }
    await runWithTenant({ tenantId: conn.tenantId }, async () => {
      await this.runner.run(
        msg.conversationKey,
        async (handle) => {
          // Dedup SOB o lock (o FIFO serializa reentregas concorrentes) e o
          // registro só APÓS o sucesso — falha transitória (DB/LLM/envio) deixa
          // a mensagem elegível para o retry do worker (at-least-once, ADR 0024).
          if (await isMessageProcessed(msg.provider, msg.externalMessageId)) {
            return; // reentrega/retry de mensagem já processada: pula
          }
          const rec = await recordInboundMessage({
            conversationKey: msg.conversationKey,
            waId: msg.from,
            ...(msg.senderName ? { profileName: msg.senderName } : {}),
            externalMessageId: msg.externalMessageId,
            type: msg.content.type,
            content: { ...msg.content },
            receivedAt: new Date(msg.receivedAt),
          });

          // Áudio (M12): transcreve e injeta como TEXTO. O download via Media API é
          // ESPECÍFICO do Cloud (Graph + secretRef); o Baileys baixaria via socket
          // (follow-up) — por isso o download só roda para 'cloud_api'. Mídia Baileys
          // hoje cai na política não-texto do M6 (sem bytes), sem tocar o Graph.
          let enrichedText: string | undefined;
          if (
            msg.provider === "cloud_api" &&
            msg.content.type === "media" &&
            msg.content.mediaId
          ) {
            const downloaded = await this.media.downloadAndStore(
              rec.messageId,
              msg.content.mediaId,
              conn.secretRef,
            );
            if (downloaded && msg.content.mediaType === "audio") {
              const text = await this.audio.transcribeInbound({
                mediaObjectId: downloaded.mediaObjectId,
                providerMediaId: msg.content.mediaId,
                buffer: downloaded.buffer,
                mimeType: downloaded.mimeType ?? "audio/ogg",
              });
              if (text && text.trim()) {
                enrichedText = text.trim();
                // Persiste a transcrição NO content da mensagem (não só em
                // media_objects): assim o histórico da conversa a inclui NESTE
                // turno E nos próximos (a IA lembra do que o lead falou por voz).
                // Roda ANTES do handler para o getConversationHistory dele já ver
                // o texto. Best-effort: se falhar, o turno atual perde o áudio no
                // contexto do LLM (histórico vem só do banco), mas a resposta não
                // trava — o handler ainda recebe o texto via `message.text`.
                try {
                  await setInboundTranscription(rec.messageId, enrichedText);
                } catch (err) {
                  this.logger.warn({
                    event: "inbound_transcription_persist_failed",
                    messageId: rec.messageId,
                    error: safeErrorFields(err),
                  });
                }
              }
            }
          }

          // CORRETOR parceiro? Desvia p/ aceite/status (imobiliária) — o agente
          // SDR nunca trata corretor como lead. Roda APÓS persistir o inbound
          // (histórico) e a transcrição de áudio (corretor pode mandar voz).
          if (this.brokerInbound) {
            const handledAsBroker = await this.brokerInbound.maybeHandle({
              from: msg.from,
              text:
                msg.content.type === "text" ? msg.content.text : enrichedText,
              conversationId: rec.conversationId,
              reply: replyFactory(msg, rec.conversationId, handle),
            });
            if (handledAsBroker) {
              await recordUsage({
                type: "inbound_message",
                channel: "whatsapp",
              });
              await markMessageProcessed(
                msg.provider,
                msg.externalMessageId,
                msg.conversationKey,
              );
              return;
            }
          }

          await this.handler.handle({
            tenantId: conn.tenantId,
            conversationId: rec.conversationId,
            conversationKey: msg.conversationKey,
            from: msg.from,
            isValid: () => handle.isValid(),
            receivedAt: msg.receivedAt,
            provider: msg.provider,
            ...(msg.senderAddress ? { senderAddress: msg.senderAddress } : {}),
            ...(msg.channelAccountId
              ? { channelAccountId: msg.channelAccountId }
              : {}),
            message: {
              externalMessageId: msg.externalMessageId,
              type:
                msg.content.type === "text" || enrichedText
                  ? "text"
                  : msg.content.type,
              ...(msg.content.type === "text"
                ? { text: msg.content.text }
                : enrichedText
                  ? { text: enrichedText }
                  : {}),
            },
            reply: replyFactory(msg, rec.conversationId, handle),
            replyForTurn: this.replyForStoredTurn(
              rec.conversationId,
              msg.conversationKey,
              replyFactory,
              handle,
            ),
          });

          // Metering/dedup only after success. Inbound persistence is idempotent;
          // a durable plan resumes its checkpoints instead of regenerating it.
          await recordUsage({ type: "inbound_message", channel: "whatsapp" });
          await markMessageProcessed(
            msg.provider,
            msg.externalMessageId,
            msg.conversationKey,
          );
        },
        opts?.lockWaitMs !== undefined
          ? { waitMs: opts.lockWaitMs }
          : undefined,
      );
    });
  }

  /** Resume a stored plan under the same tenant/FIFO boundary, without inbound/LLM work. */
  async resumeStoredTurn(
    turn: AgentTurnRow,
    conn: ResolvedConnection,
    replyFactory: ReplyFactory,
    opts?: InboundHandleOptions,
  ): Promise<void> {
    await runWithTenant({ tenantId: conn.tenantId }, async () => {
      await this.runner.run(
        turn.conversationKey,
        async (handle) => {
          // Re-read with RLS after acquiring the lock. An arbitrary/cross-tenant
          // row or a concurrently completed turn must not become a fresh turn.
          const current = await getAgentTurn(
            turn.conversationId,
            turn.externalMessageId,
          );
          if (!current?.plan || current.status !== "ready") return;
          if (current.conversationKey !== turn.conversationKey)
            throw new Error("agent_turn_conversation_mismatch");
          const msg = storedTurnMessage(current);
          if (!this.handler.resume)
            throw new Error("agent_turn_resume_handler_unavailable");
          await this.handler.resume({
            tenantId: conn.tenantId,
            conversationId: current.conversationId,
            conversationKey: current.conversationKey,
            from: msg.from,
            isValid: () => handle.isValid(),
            receivedAt: msg.receivedAt,
            provider: msg.provider,
            ...(msg.senderAddress ? { senderAddress: msg.senderAddress } : {}),
            ...(msg.channelAccountId
              ? { channelAccountId: msg.channelAccountId }
              : {}),
            message: {
              externalMessageId: current.externalMessageId,
              type: current.plan.source!.type,
            },
            reply: replyFactory(msg, current.conversationId, handle),
            replyForTurn: this.replyForStoredTurn(
              current.conversationId,
              current.conversationKey,
              replyFactory,
              handle,
            ),
          });
        },
        opts?.lockWaitMs !== undefined
          ? { waitMs: opts.lockWaitMs }
          : undefined,
      );
    });
  }

  private replyForStoredTurn(
    conversationId: string,
    conversationKey: string,
    replyFactory: ReplyFactory,
    handle: LockHandle,
  ): (
    externalMessageId: string,
    text: string,
    options?: ReplyOptions,
  ) => Promise<void> {
    return async (externalMessageId, text, options) => {
      const turn = await getAgentTurn(conversationId, externalMessageId);
      if (!turn?.plan || turn.conversationKey !== conversationKey) {
        throw new ReplyDeliveryError("not_sent", "reply_source_missing");
      }
      const send = replyFactory(
        storedTurnMessage(turn),
        conversationId,
        handle,
      );
      if (options) await send(text, options);
      else await send(text);
    };
  }
}

/** Persisted metadata is a routing identity, never a new synthetic inbound. */
export function storedTurnMessage(
  turn: AgentTurnRow,
): NormalizedInboundMessage {
  const source = turn.plan?.source;
  const parts = turn.conversationKey.split(":");
  const [provider, account, from] = parts;
  if (
    !source ||
    parts.length !== 3 ||
    !provider ||
    !account ||
    !from ||
    source.from !== from ||
    (source.provider && source.provider !== provider) ||
    (source.channelAccountId && source.channelAccountId !== account)
  ) {
    throw new ReplyDeliveryError("not_sent", "agent_turn_invalid_source");
  }
  return {
    provider,
    channelAccountId: account,
    externalMessageId: turn.externalMessageId,
    conversationKey: turn.conversationKey,
    from: source.from,
    to: account,
    receivedAt: source.receivedAt ?? "",
    ...(source.senderAddress ? { senderAddress: source.senderAddress } : {}),
    content:
      source.type === "text"
        ? { type: "text", text: "" }
        : { type: "unsupported", raw: null },
  };
}
