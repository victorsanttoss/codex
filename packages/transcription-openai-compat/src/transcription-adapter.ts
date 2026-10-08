import {
  TranscriptionError,
  type TranscriptionInput,
  type TranscriptionProvider,
  type TranscriptionResult,
} from "@sdr/core";
import { makeFetchTranscriptionHttp, type TranscriptionHttp } from "./http";

export const OPENAI_COMPAT_TRANSCRIPTION_KEY = "openai_compat";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OpenAiCompatTranscriptionConfig {
  /** baseURL do endpoint compatível (Whisper self-hosted OU provedor por token). */
  baseURL: string;
  /** Modelo de STT (ex.: whisper-1, gpt-4o-transcribe, whisper-selfhosted). */
  model: string;
  apiKey?: string;
  http?: TranscriptionHttp;
  /** Timeout de rede por requisição (default 60s) — usado quando `http` não é injetado. */
  timeoutMs?: number;
  /** id do provedor (default openai_compat). */
  id?: string;
  /** Idioma default (ISO-639-1) quando o input não trouxer `languageHint`. */
  defaultLanguage?: string;
  /** Tentativas em erro transiente (rede/429/5xx). */
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** MIME → extensão de arquivo (Whisper detecta o formato pela extensão). */
const MIME_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/oga": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/amr": "amr",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

function extFor(mimeType: string): string {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  return MIME_EXT[base] ?? "ogg"; // WhatsApp manda OGG/Opus por padrão
}

/**
 * Adaptador de transcrição para qualquer API compatível com OpenAI
 * `/audio/transcriptions`. O `baseURL` configurável cobre Whisper auto-hospedado
 * (faster-whisper/whisper.cpp) e provedores por token. Lida com OGG/Opus do
 * WhatsApp, manda a dica de idioma (PT default), pede `verbose_json` p/ ler a
 * duração (metering), faz retry/backoff em transiente. Cliente HTTP injetável.
 */
export class OpenAiCompatTranscriptionProvider implements TranscriptionProvider {
  readonly id: string;
  private readonly base: string;
  private readonly http: TranscriptionHttp;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: OpenAiCompatTranscriptionConfig) {
    if (!config.model) throw new Error("OpenAiCompatTranscriptionProvider: 'model' é obrigatório.");
    if (!config.baseURL) throw new Error("OpenAiCompatTranscriptionProvider: 'baseURL' é obrigatório.");
    this.id = config.id ?? OPENAI_COMPAT_TRANSCRIPTION_KEY;
    this.base = config.baseURL.replace(/\/$/, "");
    this.http = config.http ?? makeFetchTranscriptionHttp(config.timeoutMs);
    this.maxAttempts = Math.max(1, config.maxAttempts ?? 3);
    this.baseDelayMs = Math.max(0, config.baseDelayMs ?? 200);
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const language = input.languageHint ?? this.config.defaultLanguage;
    const fields: Record<string, string> = {
      model: this.config.model,
      response_format: "verbose_json",
      ...(language ? { language } : {}),
    };
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const res = await this.http.post(this.url(), this.headers(), {
          file: input.data,
          filename: `audio.${extFor(input.mimeType)}`,
          contentType: input.mimeType,
          fields,
        });
        if (res.status < 200 || res.status >= 300) throw mapHttpError(res.status, res.json);
        return parseResponse(res.json);
      } catch (err) {
        const e = toTranscriptionError(err);
        if (!e.transient || attempt >= this.maxAttempts) throw e;
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  private url(): string {
    return `${this.base}/audio/transcriptions`;
  }
  private headers(): Record<string, string> {
    // SEM content-type: o multipart define o boundary. Só auth.
    return this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {};
  }
}

function parseResponse(json: unknown): TranscriptionResult {
  const j = json as any;
  if (j == null || typeof j.text !== "string") {
    throw new TranscriptionError("Transcrição: resposta sem 'text'", false, 502);
  }
  const seconds = Number(j.duration);
  return {
    text: j.text,
    usage: Number.isFinite(seconds) && seconds >= 0 ? { seconds } : {},
  };
}

function mapHttpError(status: number, body: unknown): TranscriptionError {
  const detail = (body as { error?: { message?: string } } | null)?.error?.message;
  return TranscriptionError.fromStatus(status, status === 429 || status >= 500, detail);
}

function toTranscriptionError(err: unknown): TranscriptionError {
  if (err instanceof TranscriptionError) return err;
  const status = (err as { status?: number } | undefined)?.status;
  const transient = status === undefined || status === 429 || status >= 500;
  return TranscriptionError.fromStatus(status, transient, err instanceof Error ? err.message : undefined);
}
