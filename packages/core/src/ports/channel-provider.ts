/**
 * PORT de canal de mensagens. O núcleo não sabe se por trás está a Cloud API
 * oficial da Meta ou uma via não-oficial — fala somente com esta interface.
 * Nenhum adaptador concreto neste módulo (M2/M3 implementam).
 */

export type ChannelKind = "whatsapp";

export interface OutboundTextMessage {
  to: string;
  text: string;
  /** Permite ao chamador correlacionar/idempotência no lado do provedor. */
  clientMessageId?: string;
}

export interface OutboundTemplateMessage {
  to: string;
  templateName: string;
  languageCode: string;
  variables?: Record<string, string>;
  clientMessageId?: string;
}

export interface SendResult {
  /** ID atribuído pelo provedor à mensagem enviada. */
  externalMessageId: string;
  acceptedAt: string;
}

/**
 * Envelope cru do webhook recebido. Carrega o material necessário para o
 * adaptador VERIFICAR autenticidade (assinatura HMAC em headers, etc.) e
 * identificar a conta/phone number — sem que o núcleo precise saber o formato.
 */
export interface InboundWebhookRequest {
  headers: Record<string, string>;
  query: Record<string, string>;
  /** Corpo bruto (string ou Buffer) — necessário para validar assinatura. */
  rawBody: string | Buffer;
}

/** Mensagem de entrada já NORMALIZADA (agnóstica de provedor). */
export interface NormalizedInboundMessage {
  provider: string;
  externalMessageId: string;
  /** Chave de partição FIFO por conversa (ex.: tenant+contato). */
  conversationKey: string;
  from: string;
  to: string;
  receivedAt: string;
  /** Nome de exibição do remetente, quando o provedor fornece. */
  senderName?: string;
  /**
   * Endereço BRUTO do remetente no provedor (ex.: JID do Baileys `...@lid` ou
   * `...@s.whatsapp.net`). Quando presente, a RESPOSTA deve ir para ESTE endereço
   * (responder no mesmo JID) em vez de reconstruir um JID a partir de `from` —
   * crítico para contatos por LID, cujo telefone é oculto e não reconstruível.
   */
  senderAddress?: string;
  /**
   * Identificador agnóstico da CONTA do canal que recebeu a mensagem (para a
   * Cloud API = phone_number_id). Usado para resolver o tenant. Opcional para
   * não quebrar adaptadores/fakes simples.
   */
  channelAccountId?: string;
  content:
    | { type: "text"; text: string }
    | {
        type: "media";
        mediaType: string;
        /** Referência de mídia do provedor (ex.: media_id da Cloud API). */
        mediaId?: string;
        url?: string;
        caption?: string;
      }
    | { type: "unsupported"; raw: unknown };
}

/** Atualização de status de uma mensagem OUTBOUND (delivery receipt). */
export interface NormalizedStatusEvent {
  provider: string;
  /** ID externo da mensagem outbound a que o status se refere. */
  externalMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  channelAccountId?: string;
  recipientId?: string;
  error?: { code?: string; title?: string; detail?: string };
}

export type ProviderLifecycleStatus =
  | { state: "connected"; since: string }
  | { state: "disconnected"; reason?: string }
  | { state: "degraded"; reason: string };

export interface ChannelProvider {
  readonly kind: ChannelKind;

  sendMessage(msg: OutboundTextMessage): Promise<SendResult>;
  sendTemplate(msg: OutboundTemplateMessage): Promise<SendResult>;

  /**
   * Converte o webhook bruto (com headers/assinatura) em zero+ mensagens
   * normalizadas. Cabe ao adaptador validar a assinatura aqui e devolver
   * vazio (ou lançar) se inválida. Sem efeito colateral, facilita o contrato.
   */
  normalizeInboundWebhook(request: InboundWebhookRequest): NormalizedInboundMessage[];

  /**
   * Extrai eventos de STATUS (sent/delivered/read/failed) do mesmo webhook.
   * Separado de normalizeInboundWebhook porque status não é "mensagem".
   * Também valida assinatura; inválido => vazio.
   */
  normalizeStatusEvents(request: InboundWebhookRequest): NormalizedStatusEvent[];

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): Promise<ProviderLifecycleStatus>;
}
