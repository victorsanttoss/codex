import { createHash } from "node:crypto";

export interface ChunkOptions {
  /** Tamanho-alvo do chunk em caracteres (~4 chars/token). */
  maxChars?: number;
  /** Sobreposição entre chunks consecutivos (preserva contexto nas bordas). */
  overlapChars?: number;
}

const DEFAULT_MAX = 2400; // ~600 tokens
const DEFAULT_OVERLAP = 300; // ~12%

/** Normaliza espaços/quebras p/ hashing e chunking estáveis. */
export function normalizeContent(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function contentHash(text: string): string {
  return createHash("sha256").update(normalizeContent(text), "utf8").digest("hex");
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Quebra o texto em janelas com sobreposição, tentando cortar em fronteira de
 * espaço para não partir palavras. Determinístico (mesma entrada → mesmos
 * chunks), o que mantém a re-ingestão idempotente.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX);
  const overlap = Math.min(Math.max(0, opts.overlapChars ?? DEFAULT_OVERLAP), maxChars - 1);
  const norm = normalizeContent(text);
  if (norm.length === 0) return [];
  if (norm.length <= maxChars) return [norm];

  const chunks: string[] = [];
  let start = 0;
  while (start < norm.length) {
    let end = Math.min(start + maxChars, norm.length);
    if (end < norm.length) {
      const lastSpace = norm.lastIndexOf(" ", end);
      if (lastSpace > start + Math.floor(maxChars / 2)) end = lastSpace;
    }
    const piece = norm.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= norm.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
