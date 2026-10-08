/** HTTP injetável para o endpoint /chat/completions (testes mockam; prod usa fetch). */
export interface OpenAiHttp {
  complete(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown }>;
  /** Emite os payloads `data:` do SSE (sem o prefixo, sem `[DONE]`). */
  stream(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): AsyncIterable<string>;
}

/** Timeout default (60s): cobre modelos locais lentos sem pendurar o turno p/ sempre. */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** Aborto por timeout → Error SEM status (o adaptador classifica como transiente/retry). */
function mapTimeout(err: unknown, timeoutMs: number): unknown {
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new Error(`LLM: timeout de rede após ${timeoutMs}ms`);
  }
  return err;
}

/**
 * Fábrica do cliente fetch com TIMEOUT (AbortSignal.timeout): sem ele, um socket
 * pendurado do provedor trava o worker indefinidamente. No stream, o signal cobre
 * a conexão E as leituras — stream estagnado também aborta.
 */
export function makeFetchOpenAiHttp(timeoutMs: number = DEFAULT_LLM_TIMEOUT_MS): OpenAiHttp {
  return {
    async complete(url, headers, body) {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err) => {
        throw mapTimeout(err, timeoutMs);
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    async *stream(url, headers, body) {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
        signal,
      }).catch((err) => {
        throw mapTimeout(err, timeoutMs);
      });
      if (!res.ok || !res.body) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const emit = function* (chunk: string): Generator<string> {
        // SSE: cada linha `data:` é um evento; trim() já cobre CRLF (\r\n).
        for (const line of chunk.split("\n")) {
          const l = line.trim();
          if (l.startsWith("data:")) {
            const data = l.slice(5).trim();
            if (data && data !== "[DONE]") yield data;
          }
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const nl = buf.lastIndexOf("\n");
          if (nl < 0) continue;
          yield* emit(buf.slice(0, nl)); // processa linhas completas; guarda o resto parcial
          buf = buf.slice(nl + 1);
        }
      } catch (err) {
        throw mapTimeout(err, timeoutMs);
      }
      buf += decoder.decode(); // flush do decoder
      if (buf.trim()) yield* emit(buf); // não perde o último evento sem newline final
    },
  };
}

export const fetchOpenAiHttp: OpenAiHttp = makeFetchOpenAiHttp();
