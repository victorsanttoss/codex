import Anthropic from "@anthropic-ai/sdk";
import {
  LlmError,
  type CompletionRequest,
  type CompletionResult,
  type LLMMessage,
  type LLMProvider,
  type StreamChunk,
  type ToolCall,
} from "@sdr/core";
// LlmError.fromStatus sanitiza a mensagem por categoria (sem texto cru do SDK).

export const ANTHROPIC_ADAPTER_KEY = "anthropic";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Subconjunto INJETÁVEL do SDK Anthropic — produção usa o SDK oficial; testes
// injetam um fake (sem rede real).
interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
interface AnthropicMessage {
  content: AnthropicBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}
interface AnthropicStreamEvent {
  type: string;
  delta?: { type?: string; text?: string };
}
export interface AnthropicMessageStream extends AsyncIterable<AnthropicStreamEvent> {
  finalMessage(): Promise<AnthropicMessage>;
}
export interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessage>;
    stream(params: Record<string, unknown>): AnthropicMessageStream;
  };
}

export interface AnthropicAdapterConfig {
  apiKey?: string;
  /** Cliente injetável (testes). Default: SDK oficial com a apiKey. */
  client?: AnthropicLike;
  /** Timeout do SDK por requisição (default 60s) — sem ele, socket pendurado trava o turno. */
  timeoutMs?: number;
  defaultMaxTokens?: number;
}

/** Timeout default do SDK (60s). */
export const DEFAULT_ANTHROPIC_TIMEOUT_MS = 60_000;

/** Adaptador concreto da Anthropic Messages API. Implementa LLMProvider. */
export class AnthropicLLMProvider implements LLMProvider {
  readonly id = ANTHROPIC_ADAPTER_KEY;
  private readonly client: AnthropicLike;
  private readonly defaultMaxTokens: number;

  constructor(config: AnthropicAdapterConfig = {}) {
    this.client =
      config.client ??
      (new Anthropic({
        apiKey: config.apiKey,
        // Erros de timeout do SDK chegam sem status → toLlmError os trata como transientes.
        timeout: config.timeoutMs ?? DEFAULT_ANTHROPIC_TIMEOUT_MS,
      }) as unknown as AnthropicLike);
    this.defaultMaxTokens = config.defaultMaxTokens ?? 1024;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      const msg = await this.client.messages.create(this.buildParams(req));
      return mapResult(msg);
    } catch (err) {
      throw toLlmError(err);
    }
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    try {
      const s = this.client.messages.stream(this.buildParams(req));
      for await (const ev of s) {
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          yield { type: "delta", content: ev.delta.text };
        }
      }
      const final = await s.finalMessage();
      for (const tc of extractToolCalls(final)) {
        yield { type: "tool_call", toolCall: tc };
      }
      yield {
        type: "done",
        usage: { tokensIn: final.usage.input_tokens, tokensOut: final.usage.output_tokens },
        finishReason: mapStop(final.stop_reason),
      };
    } catch (err) {
      throw toLlmError(err);
    }
  }

  private buildParams(req: CompletionRequest): Record<string, unknown> {
    const { system, messages } = mapMessages(req.messages);
    return {
      model: req.model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      messages,
      ...(system ? { system } : {}),
      ...(req.tools
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      // temperature/top_p dão 400 em Opus 4.7/4.8 e Fable — só envia onde é aceito.
      ...(samplingAllowed(req.model) && req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
    };
  }
}

function samplingAllowed(model: string): boolean {
  return !/^(claude-opus-4-(7|8)|claude-fable-5)/.test(model);
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const status = (err as { status?: number } | undefined)?.status;
  const transient = status === undefined || status === 429 || status >= 500;
  // message = categoria segura; texto cru do SDK fica só em `detail` (log redigido).
  return LlmError.fromStatus(status, transient, err instanceof Error ? err.message : undefined);
}

function mapMessages(messages: LLMMessage[]): { system?: string; messages: unknown[] } {
  const systemParts: string[] = [];
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }],
      });
    } else if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    }
  }
  return { ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}), messages: out };
}

function extractToolCalls(msg: AnthropicMessage): ToolCall[] {
  return msg.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: String(b.id ?? ""),
      name: String(b.name ?? ""),
      arguments: (b.input ?? {}) as Record<string, unknown>,
    }));
}

function mapResult(msg: AnthropicMessage): CompletionResult {
  const content = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  return {
    content,
    toolCalls: extractToolCalls(msg),
    usage: { tokensIn: msg.usage.input_tokens, tokensOut: msg.usage.output_tokens },
    finishReason: mapStop(msg.stop_reason),
  };
}

function mapStop(stop: string | null): CompletionResult["finishReason"] {
  switch (stop) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}
