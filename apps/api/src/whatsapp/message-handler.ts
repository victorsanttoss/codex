import { Injectable } from "@nestjs/common";

export interface ReplyOptions {
  /** Only an already persisted opt-out acknowledgment may bypass opt-out/takeover. */
  allowOptOutReply?: boolean;
}

/**
 * Seam do PROCESSAMENTO de mensagem (o agente é o M6). A pipeline entrega a
 * mensagem normalizada + um `reply()` que já cuida de janela/envio/persistência.
 */
export interface InboundMessageContext {
  tenantId: string;
  conversationId: string;
  conversationKey: string;
  from: string;
  receivedAt?: string;
  senderAddress?: string;
  provider?: string;
  channelAccountId?: string;
  /** Conversation lock fencing, checked before committing turn effects. */
  isValid?(): Promise<boolean>;
  message: { externalMessageId: string; type: string; text?: string };
  reply(text: string, options?: ReplyOptions): Promise<void>;
  /** Replays an earlier persisted turn using its own destination metadata. */
  replyForTurn?(
    externalMessageId: string,
    text: string,
    options?: ReplyOptions,
  ): Promise<void>;
}

/**
 * A transport may permit retry only when no delivery could have occurred.
 * Unknown network outcomes, partial multi-bubble sends and post-send persistence
 * failures are uncertain, and must never trigger a blind resend.
 */
export class ReplyDeliveryError extends Error {
  constructor(
    readonly delivery: "not_sent" | "uncertain",
    code = "reply_delivery_failed",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ReplyDeliveryError";
  }
}

export interface InboundMessageHandler {
  handle(ctx: InboundMessageContext): Promise<void>;
  /** Executes a persisted plan only; never generates a new response. */
  resume?(ctx: InboundMessageContext): Promise<void>;
}

export const INBOUND_HANDLER = "INBOUND_HANDLER";

/** Handler stub do M2: ecoa o texto (valida o fluxo ponta a ponta). */
@Injectable()
export class EchoMessageHandler implements InboundMessageHandler {
  async handle(ctx: InboundMessageContext): Promise<void> {
    const text = ctx.message.text ?? "(mensagem não-texto recebida)";
    await ctx.reply(`echo: ${text}`);
  }
}
