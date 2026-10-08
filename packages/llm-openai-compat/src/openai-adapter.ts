import {
  LlmError,
  type CompletionRequest,
  type CompletionResult,
  type LLMMessage,
  type LLMProvider,
  type StreamChunk,
  type ToolCall,
  type ToolDefinition,
} from "@sdr/core";
import { makeFetchOpenAiHttp, type OpenAiHttp } from "./http";

export const OPENAI_COMPAT_ADAPTER_KEY = "openai_compat";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OpenAiCompatConfig {
  /** baseURL do endpoint compatível (self-hosted vLLM/Ollama OU provedor por token). */
  baseURL: string;
  apiKey?: string;
  http?: OpenAiHttp;
  /** Timeout de rede por requisição (default 60s) — usado quando `http` não é injetado. */
  timeoutMs?: number;
  defaultMaxTokens?: number;
  /** id do provedor (default openai_compat) — útil p/ distinguir registros. */
  id?: string;
}

/**
 * Adaptador para qualquer API compatível com OpenAI Chat Completions.
 * O `baseURL` configurável cobre modelo aberto auto-hospedado (vLLM/Ollama) e
 * provedores por token (DeepSeek/Together/Groq/OpenRouter). Função-calling +
 * streaming SSE. Cliente HTTP injetável (testes sem rede real).
 */
export class OpenAiCompatProvider implements LLMProvider {
  readonly id: string;
  private readonly base: string;
  private readonly http: OpenAiHttp;
  private readonly defaultMaxTokens: number;

  constructor(private readonly config: OpenAiCompatConfig) {
    this.id = config.id ?? OPENAI_COMPAT_ADAPTER_KEY;
    this.base = config.baseURL.replace(/\/$/, "");
    this.http = config.http ?? makeFetchOpenAiHttp(config.timeoutMs);
    this.defaultMaxTokens = config.defaultMaxTokens ?? 1024;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      const res = await this.http.complete(this.url(), this.headers(), this.body(req));
      if (res.status < 200 || res.status >= 300) throw mapHttpError(res.status, res.json);
      return mapResponse(res.json);
    } catch (err) {
      throw toLlmError(err);
    }
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const tools: Record<number, { id: string; name: string; args: string }> = {};
    let usage = { tokensIn: 0, tokensOut: 0 };
    let finish: CompletionResult["finishReason"] = "stop";
    try {
      for await (const data of this.http.stream(this.url(), this.headers(), this.body(req))) {
        const chunk = safeJson(data) as any;
        if (!chunk) continue;
        if (chunk.usage) {
          usage = {
            tokensIn: chunk.usage.prompt_tokens ?? 0,
            tokensOut: chunk.usage.completion_tokens ?? 0,
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = mapFinish(choice.finish_reason);
        const delta = choice.delta ?? {};
        if (delta.content) yield { type: "delta", content: String(delta.content) };
        for (const t of delta.tool_calls ?? []) {
          const i = t.index ?? 0;
          const cur = (tools[i] ??= { id: "", name: "", args: "" });
          if (t.id) cur.id = t.id;
          if (t.function?.name) cur.name = t.function.name;
          if (t.function?.arguments) cur.args += t.function.arguments;
        }
      }
      for (const t of Object.values(tools)) {
        yield { type: "tool_call", toolCall: { id: t.id, name: t.name, arguments: parseToolArgs(t.args, t.name) } };
      }
      yield { type: "done", usage, finishReason: finish };
    } catch (err) {
      throw toLlmError(err);
    }
  }

  private url(): string {
    return `${this.base}/chat/completions`;
  }
  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }
  private body(req: CompletionRequest): Record<string, unknown> {
    // Família reasoning da OpenAI (gpt-5*, o1/o3/o4…) exige max_completion_tokens
    // e rejeita temperature custom; o resto (gpt-4*, self-hosted Ollama/vLLM)
    // segue no max_tokens clássico.
    const reasoning = /^(gpt-5([.-]|$)|o\d)/i.test(req.model);
    const maxTokens = req.maxTokens ?? this.defaultMaxTokens;
    return {
      model: req.model,
      ...(reasoning ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      messages: mapMessages(req.messages),
      ...(req.tools ? { tools: mapTools(req.tools) } : {}),
      ...(req.temperature !== undefined && !reasoning ? { temperature: req.temperature } : {}),
    };
  }
}

function mapMessages(messages: LLMMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function mapTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function mapResponse(json: unknown): CompletionResult {
  const j = json as any;
  const choice = j?.choices?.[0];
  const message = choice?.message ?? {};
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any) => ({
    id: String(tc.id ?? ""),
    name: String(tc.function?.name ?? ""),
    arguments: parseToolArgs(tc.function?.arguments, String(tc.function?.name ?? "")),
  }));
  return {
    content: message.content ?? "",
    toolCalls,
    usage: { tokensIn: j?.usage?.prompt_tokens ?? 0, tokensOut: j?.usage?.completion_tokens ?? 0 },
    finishReason: mapFinish(choice?.finish_reason),
  };
}

function mapFinish(reason: unknown): CompletionResult["finishReason"] {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

function mapHttpError(status: number, body: unknown): LlmError {
  // detalhe cru do provedor fica só em `detail` (log redigido); message é categoria segura.
  const detail = (body as { error?: { message?: string } } | null)?.error?.message;
  return LlmError.fromStatus(status, status === 429 || status >= 500, detail);
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const status = (err as { status?: number } | undefined)?.status;
  const transient = status === undefined || status === 429 || status >= 500;
  return LlmError.fromStatus(status, transient, err instanceof Error ? err.message : undefined);
}

/**
 * Parseia `function.arguments` (string JSON do protocolo OpenAI). Vazio/ausente →
 * `{}` (tool sem parâmetros). JSON inválido NÃO é silenciado: lança LlmError
 * PERMANENTE — executar tool com args vazios/errados é pior que falhar.
 */
function parseToolArgs(raw: unknown, toolName: string): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("não é objeto");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new LlmError(`LLM: argumentos de tool inválidos (${toolName})`, false, 400);
  }
}

function safeJson(s: unknown): Record<string, unknown> | undefined {
  if (typeof s !== "string" || !s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
