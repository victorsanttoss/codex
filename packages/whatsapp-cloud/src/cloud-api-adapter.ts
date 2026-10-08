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
import { verifyMetaSignature } from "./signature";
import { ChannelSendError } from "./errors";
import { makeFetchHttpClient, type HttpClient } from "./http";

const SIGNATURE_HEADER = "x-hub-signature-256";
export const CLOUD_API_ADAPTER_KEY = "cloud_api";

/** Evento de conta (lifecycle) — específico do canal, fora da port genérica. */
export interface NormalizedAccountEvent {
  provider: string;
  wabaId?: string;
  event: string;
  raw: unknown;
}

export interface CloudApiConfig {
  /** App secret da PLATAFORMA — verifica a assinatura do webhook. */
  appSecret: string;
  /** phone_number_id do tenant — necessário para ENVIAR. */
  phoneNumberId?: string;
  /** Token de envio do tenant (do TenantSecretsStore). */
  accessToken?: string;
  graphApiBase?: string;
  graphApiVersion?: string;
  http?: HttpClient;
  /** Timeout de rede por requisição (default 20s) — usado quando `http` não é injetado. */
  timeoutMs?: number;
  retry?: { maxAttempts: number; baseDelayMs: number };
  /** Injetável para teste (evita delays reais). */
  sleep?: (ms: number) => Promise<void>;
  /** Injetável para jitter determinístico em teste. */
  jitter?: () => number;
}

/** Adaptador concreto da WhatsApp Cloud API (oficial). Implementa ChannelProvider. */
export class CloudApiChannelProvider implements ChannelProvider {
  readonly kind = "whatsapp" as const;
  private readonly http: HttpClient;
  private readonly base: string;
  private readonly version: string;
  private readonly retry: { maxAttempts: number; baseDelayMs: number };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  constructor(private readonly config: CloudApiConfig) {
    this.http = config.http ?? makeFetchHttpClient(config.timeoutMs);
    this.base = (config.graphApiBase ?? "https://graph.facebook.com").replace(/\/$/, "");
    this.version = config.graphApiVersion ?? "v21.0";
    this.retry = config.retry ?? { maxAttempts: 3, baseDelayMs: 200 };
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.jitter = config.jitter ?? Math.random;
  }

  // ── Inbound ─────────────────────────────────────────────────

  normalizeInboundWebhook(request: InboundWebhookRequest): NormalizedInboundMessage[] {
    const out: NormalizedInboundMessage[] = [];
    for (const value of this.verifyAndExtractValues(request)) {
      const phoneNumberId = str(getPath(value, ["metadata", "phone_number_id"]));
      const displayPhone = str(getPath(value, ["metadata", "display_phone_number"]));
      const contacts = asArray(getPath(value, ["contacts"]));
      const senderName = str(getPath(contacts[0], ["profile", "name"]));

      for (const raw of asArray(getPath(value, ["messages"]))) {
        const m = raw as Record<string, unknown>;
        const from = str(m.from);
        const id = str(m.id);
        if (!from || !id || !phoneNumberId) continue;
        const ts = Number(m.timestamp);
        out.push({
          provider: CLOUD_API_ADAPTER_KEY,
          externalMessageId: id,
          conversationKey: `${CLOUD_API_ADAPTER_KEY}:${phoneNumberId}:${from}`,
          from,
          to: displayPhone ?? phoneNumberId,
          receivedAt: new Date(Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now()).toISOString(),
          ...(senderName ? { senderName } : {}),
          channelAccountId: phoneNumberId,
          content: this.parseContent(m),
        });
      }
    }
    return out;
  }

  normalizeStatusEvents(request: InboundWebhookRequest): NormalizedStatusEvent[] {
    const out: NormalizedStatusEvent[] = [];
    for (const value of this.verifyAndExtractValues(request)) {
      const phoneNumberId = str(getPath(value, ["metadata", "phone_number_id"]));
      for (const raw of asArray(getPath(value, ["statuses"]))) {
        const s = raw as Record<string, unknown>;
        const id = str(s.id);
        const status = str(s.status);
        if (!id || !isStatus(status)) continue;
        const ts = Number(s.timestamp);
        const errors = asArray(s.errors);
        const firstErr = errors[0] as Record<string, unknown> | undefined;
        out.push({
          provider: CLOUD_API_ADAPTER_KEY,
          externalMessageId: id,
          status,
          timestamp: new Date(Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now()).toISOString(),
          ...(phoneNumberId ? { channelAccountId: phoneNumberId } : {}),
          ...(str(s.recipient_id) ? { recipientId: str(s.recipient_id)! } : {}),
          ...(firstErr ? { error: buildError(firstErr) } : {}),
        });
      }
    }
    return out;
  }

  /** Verifica a assinatura UMA vez e extrai TODOS os `value` (entries × changes). */
  private verifyAndExtractValues(request: InboundWebhookRequest): Record<string, unknown>[] {
    const header = request.headers[SIGNATURE_HEADER] ?? request.headers["X-Hub-Signature-256"];
    if (!verifyMetaSignature(request.rawBody, header, this.config.appSecret)) return [];
    let parsed: unknown;
    try {
      const body = Buffer.isBuffer(request.rawBody)
        ? request.rawBody.toString("utf8")
        : request.rawBody;
      parsed = body ? JSON.parse(body) : null;
    } catch {
      return [];
    }
    const values: Record<string, unknown>[] = [];
    for (const entry of asArray(getPath(parsed, ["entry"]))) {
      for (const change of asArray(getPath(entry, ["changes"]))) {
        const value = getPath(change, ["value"]);
        if (isRecord(value)) values.push(value);
      }
    }
    return values;
  }

  /** Assinatura é válida? (para logging/métrica de rejeição no caller). */
  verifySignature(request: InboundWebhookRequest): boolean {
    const header = request.headers[SIGNATURE_HEADER] ?? request.headers["X-Hub-Signature-256"];
    return verifyMetaSignature(request.rawBody, header, this.config.appSecret);
  }

  /**
   * Eventos de conta (`account_update`): revogação, ban, restrição etc. Método
   * CONCRETO (não está na port genérica — é lifecycle específico do canal).
   * `entry.id` é o waba_id. Verifica assinatura; inválido => vazio.
   */
  normalizeAccountEvents(request: InboundWebhookRequest): NormalizedAccountEvent[] {
    const header = request.headers[SIGNATURE_HEADER] ?? request.headers["X-Hub-Signature-256"];
    if (!verifyMetaSignature(request.rawBody, header, this.config.appSecret)) return [];
    let parsed: unknown;
    try {
      const body = Buffer.isBuffer(request.rawBody)
        ? request.rawBody.toString("utf8")
        : request.rawBody;
      parsed = body ? JSON.parse(body) : null;
    } catch {
      return [];
    }
    const out: NormalizedAccountEvent[] = [];
    for (const entry of asArray(getPath(parsed, ["entry"]))) {
      const wabaId = str(getPath(entry, ["id"]));
      for (const change of asArray(getPath(entry, ["changes"]))) {
        if (str(getPath(change, ["field"])) !== "account_update") continue;
        const value = getPath(change, ["value"]);
        out.push({
          provider: CLOUD_API_ADAPTER_KEY,
          ...(wabaId ? { wabaId } : {}),
          event: str(getPath(value, ["event"])) ?? "unknown",
          raw: value,
        });
      }
    }
    return out;
  }

  private parseContent(m: Record<string, unknown>): NormalizedInboundMessage["content"] {
    const type = str(m.type) ?? "unknown";
    if (type === "text") {
      return { type: "text", text: str(getPath(m, ["text", "body"])) ?? "" };
    }
    if (["image", "video", "audio", "document", "sticker"].includes(type)) {
      const media = (m[type] ?? {}) as Record<string, unknown>;
      return {
        type: "media",
        mediaType: type,
        ...(str(media.id) ? { mediaId: str(media.id)! } : {}),
        ...(str(media.caption) ? { caption: str(media.caption)! } : {}),
      };
    }
    return { type: "unsupported", raw: m };
  }

  // ── Outbound ────────────────────────────────────────────────

  sendMessage(msg: OutboundTextMessage): Promise<SendResult> {
    return this.send({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: msg.to,
      type: "text",
      text: { preview_url: false, body: msg.text },
      // correlação no provedor (ecoado nos status) — não é dedup garantido.
      ...(msg.clientMessageId ? { biz_opaque_callback_data: msg.clientMessageId } : {}),
    });
  }

  sendTemplate(msg: OutboundTemplateMessage): Promise<SendResult> {
    const components = msg.variables
      ? [
          {
            type: "body",
            parameters: Object.keys(msg.variables)
              .sort()
              .map((k) => ({ type: "text", text: msg.variables![k] })),
          },
        ]
      : undefined;
    return this.send({
      messaging_product: "whatsapp",
      to: msg.to,
      type: "template",
      template: {
        name: msg.templateName,
        language: { code: msg.languageCode },
        ...(components ? { components } : {}),
      },
      ...(msg.clientMessageId ? { biz_opaque_callback_data: msg.clientMessageId } : {}),
    });
  }

  private async send(payload: Record<string, unknown>): Promise<SendResult> {
    if (!this.config.phoneNumberId || !this.config.accessToken) {
      throw new ChannelSendError("Adaptador sem phoneNumberId/accessToken para enviar.", false);
    }
    const url = `${this.base}/${this.version}/${this.config.phoneNumberId}/messages`;
    const headers = {
      authorization: `Bearer ${this.config.accessToken}`,
      "content-type": "application/json",
    };
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const res = await this.http.post(url, { headers, body: JSON.stringify(payload) });
        if (res.status >= 200 && res.status < 300) {
          const json = (await res.json()) as Record<string, unknown>;
          const messages = asArray(json.messages);
          const id = str(getPath(messages[0], ["id"]));
          if (!id) throw new ChannelSendError("Resposta sem message id.", false, res.status);
          return { externalMessageId: id, acceptedAt: new Date().toISOString() };
        }
        throw this.mapHttpError(res.status, await safeJson(res));
      } catch (err) {
        const e = this.asSendError(err);
        if (!e.transient || attempt >= this.retry.maxAttempts) throw e;
        const backoff =
          this.retry.baseDelayMs * 2 ** (attempt - 1) + Math.floor(this.jitter() * 50);
        await this.sleep(backoff);
      }
    }
  }

  private mapHttpError(status: number, body: unknown): ChannelSendError {
    const rawCode = getPath(body, ["error", "code"]);
    // a Meta retorna `code` numérico (ex.: 190 = OAuth) — normalizar p/ string.
    const code =
      typeof rawCode === "string" ? rawCode : rawCode != null ? String(rawCode) : undefined;
    const message = str(getPath(body, ["error", "message"])) ?? `HTTP ${status}`;
    const transient = status === 429 || status >= 500;
    return new ChannelSendError(message, transient, status, code);
  }

  private asSendError(err: unknown): ChannelSendError {
    if (err instanceof ChannelSendError) return err;
    // erro de rede (fetch lançou) => transiente
    return new ChannelSendError(err instanceof Error ? err.message : "erro de rede", true);
  }

  // ── Ciclo de vida ──────────────────────────────────────────
  // A Cloud API é stateless (sem socket); o flag representa "habilitado/pausado"
  // e honra o contrato de ciclo de vida (connect/disconnect/status coerentes).
  private enabled = true;
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

// ── helpers de parsing seguro ─────────────────────────────────
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function getPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function isStatus(v: unknown): v is NormalizedStatusEvent["status"] {
  return v === "sent" || v === "delivered" || v === "read" || v === "failed";
}
function buildError(e: Record<string, unknown>): NonNullable<NormalizedStatusEvent["error"]> {
  const out: NonNullable<NormalizedStatusEvent["error"]> = {};
  const code = str(e.code) ?? (e.code != null ? String(e.code) : undefined);
  if (code) out.code = code;
  const title = str(e.title);
  if (title) out.title = title;
  const detail = str(e.message);
  if (detail) out.detail = detail;
  return out;
}
async function safeJson(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
