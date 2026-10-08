/** Cliente HTTP mínimo e INJETÁVEL (testes mockam; produção usa fetch). */
export interface HttpResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /**
   * Lê um header da resposta (case-insensitive). OPCIONAL para não quebrar mocks
   * antigos — usado, p.ex., para checar Content-Length ANTES de materializar o
   * corpo (guard anti-DoS de download de mídia).
   */
  header?(name: string): string | null;
}

export interface HttpClient {
  post(url: string, opts: { headers: Record<string, string>; body: string }): Promise<HttpResponse>;
  get(url: string, opts: { headers: Record<string, string> }): Promise<HttpResponse>;
}

/** Timeout default de rede (Graph API responde em segundos; 20s cobre picos). */
export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

/**
 * Fábrica do cliente fetch com TIMEOUT (AbortSignal): sem ele, um socket pendurado
 * trava o worker para sempre. O timeout vira um Error de rede comum — o adaptador
 * o converte em ChannelSendError TRANSIENTE (retry com backoff).
 */
export function makeFetchHttpClient(timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS): HttpClient {
  return {
    async post(url, opts) {
      const res = await fetch(url, {
        method: "POST",
        headers: opts.headers,
        body: opts.body,
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err) => {
        throw mapTimeout(err, timeoutMs);
      });
      return wrap(res);
    },
    async get(url, opts) {
      const res = await fetch(url, {
        method: "GET",
        headers: opts.headers,
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err) => {
        throw mapTimeout(err, timeoutMs);
      });
      return wrap(res);
    },
  };
}

export const fetchHttpClient: HttpClient = makeFetchHttpClient();

/** Aborto por timeout → Error com mensagem clara (o caller decide retry). */
export function mapTimeout(err: unknown, timeoutMs: number): unknown {
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new Error(`timeout de rede após ${timeoutMs}ms`);
  }
  return err;
}

function wrap(res: Response): HttpResponse {
  return {
    status: res.status,
    json: () => res.json(),
    text: () => res.text(),
    arrayBuffer: () => res.arrayBuffer(),
    header: (name: string) => res.headers.get(name),
  };
}
