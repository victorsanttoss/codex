import type {
  ChannelProvider,
  InboundWebhookRequest,
  NormalizedInboundMessage,
  NormalizedStatusEvent,
  OutboundTemplateMessage,
  OutboundTextMessage,
  ProviderLifecycleStatus,
  SendResult,
} from "@sdr/core";
import type { BaileysConnection } from "./driver";
import { BaileysSendError } from "./errors";
import {
  BAILEYS_ADAPTER_KEY,
  jidToPhone,
  phoneToJid,
  type BaileysInboundEnvelope,
  type BaileysStatusEnvelope,
} from "./envelope";

export { BAILEYS_ADAPTER_KEY };

export interface BaileysChannelConfig {
  /** Conta (número/JID-bare) que este adaptador representa. = channelAccountId. */
  accountId: string;
  /** Socket vivo (do session-worker). Sem ele, o adaptador só normaliza/inerte. */
  connection?: BaileysConnection;
  /** Relógio injetável (testes determinísticos). */
  clock?: () => Date;
  id?: string;
}

/**
 * Adaptador do canal NÃO-OFICIAL (Baileys/WhatsApp Web). Implementa a MESMA port
 * `ChannelProvider` do Cloud — por isso pluga na mesma pipeline. Diferenças:
 *  - INBOUND é por EVENTO (não webhook): o session-worker serializa os eventos do
 *    socket num envelope e chama `normalizeInboundWebhook` (sem assinatura — a
 *    autenticação é a própria sessão).
 *  - `sendTemplate` NÃO tem HSM: é renderizado como mensagem de TEXTO normal
 *    (documentado). Os guardrails do M8 valem com rigor ainda maior.
 *  - É STATEFUL: envia pelo `connection` (socket) — só funciona no worker dono.
 */
export class BaileysChannelProvider implements ChannelProvider {
  readonly kind = "whatsapp" as const;
  readonly id: string;
  private readonly clock: () => Date;
  private enabled = false;

  constructor(private readonly config: BaileysChannelConfig) {
    this.id = config.id ?? BAILEYS_ADAPTER_KEY;
    this.clock = config.clock ?? (() => new Date());
  }

  // ── Outbound ────────────────────────────────────────────────

  async sendMessage(msg: OutboundTextMessage): Promise<SendResult> {
    if (!this.config.connection) {
      // Sem socket local: não dá para enviar de um worker que não detém a sessão.
      throw new BaileysSendError("Sem socket Baileys para enviar (worker não-dono).", false);
    }
    try {
      // clientMessageId vira o messageId do WhatsApp → envio IDEMPOTENTE (dedup
      // por id; reenvio após crash não entrega 2×).
      const { id } = await this.config.connection.sendText(
        phoneToJid(msg.to),
        msg.text,
        msg.clientMessageId ? { messageId: msg.clientMessageId } : undefined,
      );
      if (!id) throw new BaileysSendError("Baileys não devolveu id de mensagem.", false);
      return { externalMessageId: id, acceptedAt: this.clock().toISOString() };
    } catch (err) {
      if (err instanceof BaileysSendError) throw err;
      // queda de socket/erro de rede → transiente (reconecta e retenta).
      throw new BaileysSendError(err instanceof Error ? err.message : "erro de envio", true);
    }
  }

  /** Não-oficial não tem HSM: renderiza o template como TEXTO normal. */
  sendTemplate(msg: OutboundTemplateMessage): Promise<SendResult> {
    return this.sendMessage({
      to: msg.to,
      text: renderTemplateAsText(msg),
      ...(msg.clientMessageId ? { clientMessageId: msg.clientMessageId } : {}),
    });
  }

  // ── Inbound (por evento, via envelope) ──────────────────────

  normalizeInboundWebhook(request: InboundWebhookRequest): NormalizedInboundMessage[] {
    const env = parse<BaileysInboundEnvelope>(request.rawBody);
    if (!env || !env.accountId || !Array.isArray(env.messages)) return [];
    const out: NormalizedInboundMessage[] = [];
    for (const m of env.messages) {
      if (!m || typeof m.id !== "string" || typeof m.from !== "string") continue;
      if (m.fromMe) continue; // eco do próprio número não é inbound
      const phone = jidToPhone(m.from);
      if (!phone) continue;
      out.push({
        provider: BAILEYS_ADAPTER_KEY,
        externalMessageId: m.id,
        conversationKey: `${BAILEYS_ADAPTER_KEY}:${env.accountId}:${phone}`,
        from: phone,
        to: env.accountId,
        // Endereço BRUTO do remetente (JID original), p/ responder no MESMO JID —
        // essencial para contatos por LID (`@lid`, novo id do WhatsApp que oculta
        // o telefone): reconstruir `<digitos>@s.whatsapp.net` a partir do phone
        // manda para um destino que o WA aceita mas NÃO entrega.
        senderAddress: m.from,
        receivedAt: new Date(typeof m.timestampMs === "number" && m.timestampMs > 0 ? m.timestampMs : this.clock().getTime()).toISOString(),
        ...(m.pushName ? { senderName: m.pushName } : {}),
        channelAccountId: env.accountId,
        content: parseContent(m),
      });
    }
    return out;
  }

  normalizeStatusEvents(request: InboundWebhookRequest): NormalizedStatusEvent[] {
    const env = parse<BaileysStatusEnvelope>(request.rawBody);
    if (!env || !env.accountId || !Array.isArray(env.statuses)) return [];
    const out: NormalizedStatusEvent[] = [];
    for (const s of env.statuses) {
      if (!s || typeof s.id !== "string" || !isStatus(s.status)) continue;
      out.push({
        provider: BAILEYS_ADAPTER_KEY,
        externalMessageId: s.id,
        status: s.status,
        timestamp: this.clock().toISOString(),
        channelAccountId: env.accountId,
        ...(s.to ? { recipientId: jidToPhone(s.to) } : {}),
      });
    }
    return out;
  }

  // ── Ciclo de vida ──────────────────────────────────────────
  // O socket real é gerido pelo SessionManager; aqui o flag honra o contrato.
  async connect(): Promise<void> {
    this.enabled = true;
  }
  async disconnect(): Promise<void> {
    this.enabled = false;
  }
  async status(): Promise<ProviderLifecycleStatus> {
    return this.enabled
      ? { state: "connected", since: new Date(0).toISOString() }
      : { state: "disconnected" };
  }
}

/** Render textual de um "template" (sem HSM): junta nome + variáveis ordenadas. */
function renderTemplateAsText(msg: OutboundTemplateMessage): string {
  const vars = msg.variables
    ? Object.keys(msg.variables)
        .sort()
        .map((k) => msg.variables![k])
    : [];
  return vars.length > 0 ? `${msg.templateName}: ${vars.join(" ")}` : msg.templateName;
}

function parseContent(m: { text?: string; media?: { type: string; id?: string; caption?: string } }): NormalizedInboundMessage["content"] {
  if (m.media && typeof m.media.type === "string") {
    return {
      type: "media",
      mediaType: m.media.type,
      ...(m.media.id ? { mediaId: m.media.id } : {}),
      ...(m.media.caption ? { caption: m.media.caption } : {}),
    };
  }
  if (typeof m.text === "string") return { type: "text", text: m.text };
  return { type: "unsupported", raw: m };
}

function parse<T>(rawBody: string | Buffer): T | null {
  try {
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
    return body ? (JSON.parse(body) as T) : null;
  } catch {
    return null;
  }
}

function isStatus(v: unknown): v is NormalizedStatusEvent["status"] {
  return v === "sent" || v === "delivered" || v === "read" || v === "failed";
}
