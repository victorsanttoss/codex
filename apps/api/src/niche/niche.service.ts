import { Injectable } from "@nestjs/common";
import { requireTenantContext } from "@sdr/core";
import {
  getNiche,
  getTenantNicheId,
  searchNicheKnowledge,
  type NicheRef,
  type RetrievedChunk,
} from "@sdr/db";

/**
 * Cache in-process do NICHO por tenant (nicheId + ref), com TTL curto. Motivo
 * (perf): `getTenantNicheId` chegava a rodar 3× por turno (config, guidance e
 * busca). Atribuição de nicho é operação administrativa RARA — a invalidação
 * explícita cobre o processo local e o TTL cobre as demais instâncias.
 */
const NICHE_CACHE_TTL_MS = 30_000;
const nicheCache = new Map<string, { nicheId: string | null; ref: NicheRef | null; expiresAt: number }>();

/** Invalida o cache de nicho (chamar ao atribuir nicho a um tenant). */
export function invalidateNicheCache(tenantId?: string): void {
  if (tenantId) nicheCache.delete(tenantId);
  else nicheCache.clear();
}

/**
 * Camada de NICHO no consumo. Resolve o nicho do tenant ATIVO no servidor
 * (`getTenantNicheId` — o tenant não escolhe) e busca o conhecimento de nicho
 * (read-only, isolado por RLS de nicho). Sem nicho atribuído → silenciosamente
 * vazio (o agente segue só com o conhecimento do tenant).
 */
@Injectable()
export class NicheService {
  /** nicheId do tenant ativo, com cache TTL (resolvido no máx. 1×/turno). */
  async getNicheId(): Promise<string | null> {
    const { tenantId } = requireTenantContext();
    const hit = nicheCache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.nicheId;
    const nicheId = await getTenantNicheId();
    const ref = nicheId ? await getNiche(nicheId) : null;
    nicheCache.set(tenantId, { nicheId, ref, expiresAt: Date.now() + NICHE_CACHE_TTL_MS });
    return nicheId;
  }

  async getNicheRef(): Promise<NicheRef | null> {
    const { tenantId } = requireTenantContext();
    const hit = nicheCache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.ref;
    await this.getNicheId(); // popula o cache (nicheId + ref juntos)
    return nicheCache.get(tenantId)?.ref ?? null;
  }

  /** Orientação de nicho p/ o prompt (nicheLayer). */
  async getGuidance(): Promise<string | null> {
    const ref = await this.getNicheRef();
    return ref?.guidance ?? null;
  }

  /** Busca vetorial no conhecimento do nicho do tenant → formato RetrievedChunk. */
  async search(queryVector: number[], topK: number, minScore: number, queryText?: string): Promise<RetrievedChunk[]> {
    const nicheId = await this.getNicheId();
    if (!nicheId) return [];
    const hits = await searchNicheKnowledge(nicheId, queryVector, topK, minScore, queryText);
    return hits.map((h) => ({
      chunkId: h.id,
      sourceId: h.id,
      title: "nicho",
      externalRef: "niche",
      content: h.content,
      score: h.score,
    }));
  }
}
