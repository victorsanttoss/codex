/**
 * Catálogo de preços de TRANSCRIÇÃO/STT (plataforma). STT cobra por DURAÇÃO de
 * áudio (USD por minuto). Dado de plataforma, NÃO tenant-scoped — fica em
 * código/config, atualizável; nunca vira tabela com RLS de tenant.
 *
 * Whisper auto-hospedado entra com `{ perMinute: 0 }` EXPLÍCITO (grátis
 * intencional — custa infra, não por-minuto). Valores conferir na doc do provedor.
 */
export interface TranscriptionPrice {
  /** USD por minuto de áudio. */
  perMinute: number;
}

export const DEFAULT_TRANSCRIPTION_PRICING: Record<string, TranscriptionPrice> = {
  // self-hosted (faster-whisper/whisper.cpp atrás de API OpenAI-compatible)
  "whisper-selfhosted": { perMinute: 0 },
  // provedores por token/minuto
  "whisper-1": { perMinute: 0.006 },
  "gpt-4o-transcribe": { perMinute: 0.006 },
  "gpt-4o-mini-transcribe": { perMinute: 0.003 },
};

export type TranscriptionPricing = Record<string, TranscriptionPrice>;

/** Há preço cadastrado para o modelo de transcrição? */
export function hasTranscriptionPrice(model: string, pricing: TranscriptionPricing): boolean {
  return pricing[model] !== undefined;
}

/**
 * Custo em MICROS (millionésimos de USD) a partir da DURAÇÃO em segundos.
 * FAIL-CLOSED: modelo sem preço LANÇA (custo 0 silencioso vira subcobrança).
 * Self-hosted/grátis deve entrar no catálogo com `{ perMinute: 0 }` explícito.
 */
export function transcriptionCostMicros(
  model: string,
  seconds: number,
  pricing: TranscriptionPricing,
): number {
  const p = pricing[model];
  if (!p) {
    throw new Error(
      `Sem preço cadastrado para o modelo de transcrição "${model}". Adicione ao catálogo (use { perMinute: 0 } para grátis/self-hosted).`,
    );
  }
  return Math.round((Math.max(0, seconds) / 60) * p.perMinute * 1_000_000);
}
