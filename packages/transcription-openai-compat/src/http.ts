/**
 * HTTP injetável para o endpoint /audio/transcriptions (multipart). Testes
 * mockam; produção usa `fetch` + FormData/Blob nativos do Node. O áudio vai como
 * campo `file`; os demais campos (model, language, response_format) como texto.
 */
export interface TranscriptionMultipart {
  /** Bytes do áudio. */
  file: Buffer;
  /** Nome do arquivo COM extensão (Whisper usa a extensão p/ detectar o formato). */
  filename: string;
  /** MIME do áudio. */
  contentType: string;
  /** Campos de texto do form (model, language, response_format, ...). */
  fields: Record<string, string>;
}

export interface TranscriptionHttp {
  post(
    url: string,
    headers: Record<string, string>,
    body: TranscriptionMultipart,
  ): Promise<{ status: number; json: unknown }>;
}

/** Timeout default (60s): Whisper local pode demorar em áudios longos. */
export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 60_000;

/**
 * Fábrica do cliente fetch com TIMEOUT (AbortSignal): sem ele, um Whisper travado
 * pendura o worker de mídia para sempre. Timeout vira Error SEM status — o
 * adaptador o classifica como TranscriptionError transiente (retry/backoff).
 */
export function makeFetchTranscriptionHttp(
  timeoutMs: number = DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
): TranscriptionHttp {
  return {
    async post(url, headers, body) {
      const form = new FormData();
      // Blob copia os bytes — sem reter referência ao Buffer original.
      const blob = new Blob([body.file], { type: body.contentType });
      form.append("file", blob, body.filename);
      for (const [k, v] of Object.entries(body.fields)) form.append(k, v);
      // NÃO definir content-type manualmente: o fetch monta o boundary do multipart.
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err) => {
        const name = (err as { name?: string } | null)?.name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new Error(`Transcrição: timeout de rede após ${timeoutMs}ms`);
        }
        throw err;
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
  };
}

export const fetchTranscriptionHttp: TranscriptionHttp = makeFetchTranscriptionHttp();
