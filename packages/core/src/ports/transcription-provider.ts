/**
 * PORT de TRANSCRIÇÃO (speech-to-text). O núcleo não sabe se por trás há um
 * Whisper auto-hospedado (faster-whisper/whisper.cpp atrás de uma API
 * OpenAI-compatible) ou um provedor por token — fala somente com esta interface.
 * Toda resposta carrega USO (segundos de áudio e/ou tokens) para o metering por
 * tenant. Nenhum adaptador concreto neste módulo (M12 implementa).
 */

export interface TranscriptionUsage {
  /** Duração do áudio transcrito, em segundos (base de cobrança usual de STT). */
  seconds?: number;
  /** Alguns provedores cobram por token de saída em vez de segundos. */
  tokensOut?: number;
}

export interface TranscriptionInput {
  /** Bytes do áudio (já baixados pelo canal). Sem rede dentro do núcleo. */
  data: Buffer;
  /** MIME do áudio (ex.: "audio/ogg" do WhatsApp — OGG/Opus). */
  mimeType: string;
  /** Idioma esperado (ISO-639-1, ex.: "pt"). Dica, não trava o provedor. */
  languageHint?: string;
}

export interface TranscriptionResult {
  /** Texto transcrito (pode ser vazio se o áudio não tiver fala). */
  text: string;
  usage: TranscriptionUsage;
}

export interface TranscriptionProvider {
  readonly id: string;
  /**
   * Transcreve um único áudio. DEVE devolver o texto (possivelmente vazio) e o
   * uso para metering. Erros de provedor viram `TranscriptionError`.
   */
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

/**
 * Erro de provedor de transcrição, agnóstico — espelha `EmbeddingError`/`LlmError`.
 * `transient` decide retry/fallback. A `message` é categoria segura (sem detalhe
 * cru do fornecedor); o texto bruto fica em `detail` (não enumerável), só p/ log
 * redigido — nunca cruza a borda agnóstica.
 */
export class TranscriptionError extends Error {
  readonly detail?: string;
  constructor(
    message: string,
    readonly transient: boolean,
    readonly status?: number,
    detail?: string,
  ) {
    super(message);
    this.name = "TranscriptionError";
    if (detail !== undefined) {
      Object.defineProperty(this, "detail", { value: detail, enumerable: false });
    }
  }

  static fromStatus(status: number | undefined, transient: boolean, detail?: string): TranscriptionError {
    return new TranscriptionError(transcriptionErrorCategory(status), transient, status, detail);
  }
}

/** Categoria PÚBLICA e segura a partir do status HTTP (sem body/headers/chave). */
export function transcriptionErrorCategory(status?: number): string {
  if (status === undefined) return "Transcrição: erro de rede";
  if (status === 401 || status === 403) return "Transcrição: falha de autenticação";
  if (status === 429) return "Transcrição: rate limit";
  if (status >= 500) return "Transcrição: erro do provedor";
  if (status === 400) return "Transcrição: requisição inválida";
  if (status === 413) return "Transcrição: áudio grande demais";
  return `Transcrição: erro (HTTP ${status})`;
}
