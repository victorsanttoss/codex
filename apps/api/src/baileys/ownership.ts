/**
 * ATRIBUIÇÃO STICKY de número → session-worker (M13). Cada número mora num worker
 * FIXO e determinístico: `hash(número) % total === index`. Assim o socket de um
 * número vive sempre no mesmo processo, e o roteamento de envio sabe para quem ir
 * sem coordenação central. Rebalancear = mudar `total` (renumera; ver ADR/runbook).
 */

/** Hash estável (FNV-1a 32-bit) — independente de processo/seed. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Este worker (index de total) é o dono do número? */
export function ownsNumber(phoneNumberId: string, index: number, total: number): boolean {
  if (total <= 1) return true; // pool de 1 worker detém tudo
  return stableHash(phoneNumberId) % total === index;
}
