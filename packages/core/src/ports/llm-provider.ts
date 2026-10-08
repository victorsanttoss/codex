/**
 * PORT de LLM. O núcleo não sabe se por trás há um modelo aberto auto-hospedado
 * ou um provedor por token — fala somente com esta interface. Toda resposta
 * carrega USO (tokens in/out) para alimentar o metering por tenant.
 * Nenhum adaptador concreto neste módulo (M4 implementa).
 */

export type LLMRole = "system" | "user" | "assistant" | "tool";

/**
 * Mensagem do diálogo — UNIÃO DISCRIMINADA por `role`. Garante em nível de tipo
 * que uma mensagem `tool` carrega o `toolCallId` que está respondendo e que só o
 * `assistant` emite `toolCalls` (fecha o ciclo de tool-calling sem `""` mágico).
 */
export type LLMMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; name?: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name?: string };

/** Helper: monta a mensagem de resultado de uma tool (exige toolCallId). */
export function toolResultMessage(toolCallId: string, content: string, name?: string): LLMMessage {
  return { role: "tool", toolCallId, content, ...(name ? { name } : {}) };
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema dos parâmetros. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Argumentos como objeto já parseado. */
  arguments: Record<string, unknown>;
}

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface CompletionRequest {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: "stop" | "length" | "tool_calls" | "content_filter";
}

export type StreamChunk =
  | { type: "delta"; content: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "done"; usage: TokenUsage; finishReason: CompletionResult["finishReason"] };

export interface LLMProvider {
  readonly id: string;

  complete(req: CompletionRequest): Promise<CompletionResult>;
  stream(req: CompletionRequest): AsyncIterable<StreamChunk>;
}

/** Auth/credencial (401/403): não adianta repetir com a MESMA chave. */
export function isCredentialStatus(status?: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Categoria PÚBLICA e segura do erro de LLM a partir do status HTTP. Nunca
 * carrega body/headers/chave do provedor — a mensagem crua do fornecedor não
 * cruza a borda agnóstica (evita vazar segredo/PII em log ou resposta).
 */
export function llmErrorCategory(status?: number): string {
  if (status === undefined) return "LLM: erro de rede";
  if (status === 401 || status === 403) return "LLM: falha de autenticação";
  if (status === 429) return "LLM: rate limit";
  if (status >= 500) return "LLM: erro do provedor";
  if (status === 400) return "LLM: requisição inválida";
  return `LLM: erro (HTTP ${status})`;
}

/**
 * Erro de provedor de LLM, agnóstico. `transient` decide retry/fallback:
 * transiente (rede/429/5xx) → retry/backoff e depois próximo provedor;
 * permanente (auth/quota/400) → próximo provedor sem retry-storm.
 *
 * A `message` é uma CATEGORIA segura (sem detalhe cru do fornecedor). O texto
 * bruto fica em `detail` (não enumerável) só para log redigido — nunca é
 * concatenado em mensagens que chegam ao usuário/borda agnóstica.
 */
export class LlmError extends Error {
  readonly detail?: string;
  constructor(
    message: string,
    readonly transient: boolean,
    readonly status?: number,
    detail?: string,
  ) {
    super(message);
    this.name = "LlmError";
    if (detail !== undefined) {
      Object.defineProperty(this, "detail", { value: detail, enumerable: false });
    }
  }

  /** Constrói a partir de um status, com mensagem sanitizada por categoria. */
  static fromStatus(status: number | undefined, transient: boolean, detail?: string): LlmError {
    return new LlmError(llmErrorCategory(status), transient, status, detail);
  }
}
