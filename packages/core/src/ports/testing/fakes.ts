import type {
  ChannelProvider,
  InboundWebhookRequest,
  NormalizedInboundMessage,
  NormalizedStatusEvent,
  OutboundTemplateMessage,
  OutboundTextMessage,
  ProviderLifecycleStatus,
  SendResult,
} from "../channel-provider";
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
  StreamChunk,
} from "../llm-provider";
import type { EmbeddingProvider, EmbeddingResult } from "../embedding-provider";
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from "../transcription-provider";

/**
 * Adaptadores FAKE em memória — existem só para exercitar os contratos e a
 * fundação. Não são implementações reais (M2/M4 entregam as de verdade).
 */

export class FakeChannelProvider implements ChannelProvider {
  readonly kind = "whatsapp" as const;
  readonly sent: Array<OutboundTextMessage | OutboundTemplateMessage> = [];
  private connected = false;
  private seq = 0;

  async sendMessage(msg: OutboundTextMessage): Promise<SendResult> {
    this.sent.push(msg);
    return { externalMessageId: `fake-${++this.seq}`, acceptedAt: new Date(0).toISOString() };
  }

  async sendTemplate(msg: OutboundTemplateMessage): Promise<SendResult> {
    this.sent.push(msg);
    return { externalMessageId: `fake-tpl-${++this.seq}`, acceptedAt: new Date(0).toISOString() };
  }

  normalizeInboundWebhook(request: InboundWebhookRequest): NormalizedInboundMessage[] {
    // Formato fake: rawBody JSON { messages: [{ id, from, to, text }] }
    let parsed: unknown;
    try {
      const body = Buffer.isBuffer(request.rawBody)
        ? request.rawBody.toString("utf8")
        : request.rawBody;
      parsed = body ? JSON.parse(body) : null;
    } catch {
      return [];
    }
    const p = parsed as { messages?: Array<Record<string, string>> } | null;
    if (!p?.messages) return [];
    return p.messages.map((m) => ({
      provider: "fake",
      externalMessageId: String(m.id),
      conversationKey: `fake:${m.from}`,
      from: String(m.from),
      to: String(m.to),
      receivedAt: new Date(0).toISOString(),
      content: { type: "text", text: String(m.text ?? "") },
    }));
  }

  normalizeStatusEvents(request: InboundWebhookRequest): NormalizedStatusEvent[] {
    // Formato fake: rawBody JSON { statuses: [{ id, status, to }] }
    let parsed: unknown;
    try {
      const body = Buffer.isBuffer(request.rawBody)
        ? request.rawBody.toString("utf8")
        : request.rawBody;
      parsed = body ? JSON.parse(body) : null;
    } catch {
      return [];
    }
    const p = parsed as { statuses?: Array<Record<string, string>> } | null;
    if (!p?.statuses) return [];
    return p.statuses.map((s) => ({
      provider: "fake",
      externalMessageId: String(s.id),
      status: (s.status as NormalizedStatusEvent["status"]) ?? "sent",
      timestamp: new Date(0).toISOString(),
      recipientId: s.to ? String(s.to) : undefined,
    }));
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async status(): Promise<ProviderLifecycleStatus> {
    return this.connected
      ? { state: "connected", since: new Date(0).toISOString() }
      : { state: "disconnected" };
  }
}

export class FakeLLMProvider implements LLMProvider {
  readonly id = "fake-llm";

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const content = `echo: ${lastUser?.content ?? ""}`;
    return {
      content,
      toolCalls: [],
      usage: { tokensIn: countTokens(req), tokensOut: estimateTokens(content) },
      finishReason: "stop",
    };
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(req);
    for (const word of result.content.split(" ")) {
      yield { type: "delta", content: word + " " };
    }
    yield { type: "done", usage: result.usage, finishReason: result.finishReason };
  }
}

/**
 * Embeddings FAKE determinísticos (sem rede): hashing de tokens em um vetor de
 * dimensão fixa, L2-normalizado. Mesmo texto → mesmo vetor; textos parecidos
 * ficam próximos em cosseno. Serve só para exercitar contrato/ingestão/busca.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = "fake-embedding";
  constructor(private readonly dim = 8) {}

  async embed(texts: string[]): Promise<EmbeddingResult> {
    return {
      vectors: texts.map((t) => embedText(t, this.dim)),
      usage: { tokensIn: texts.reduce((s, t) => s + estimateTokens(t), 0) },
    };
  }
}

/**
 * Transcrição FAKE determinística (sem rede): devolve um texto derivado do
 * tamanho dos bytes e estima ~1s de áudio a cada ~4KB de OGG/Opus. Serve só para
 * exercitar contrato e o passo de enriquecimento do pipeline.
 */
export class FakeTranscriptionProvider implements TranscriptionProvider {
  readonly id = "fake-transcription";
  constructor(private readonly fixedText?: string) {}

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const seconds = Math.max(1, Math.round(input.data.length / 4096));
    return {
      text: this.fixedText ?? `transcrição fake (${input.data.length} bytes, ${input.mimeType})`,
      usage: { seconds },
    };
  }
}

function embedText(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    v[h % dim] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
function countTokens(req: CompletionRequest): number {
  return req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}
