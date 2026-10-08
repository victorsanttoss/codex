import { and, eq, inArray, sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { getDb, withCuration, withNiche, withTenant } from "./client";
import { assertVectorDim } from "./knowledge";
import { leadProfiles } from "./schema";
import {
  curationCandidates,
  nicheConfigs,
  nicheKnowledge,
  niches,
  platformUsage,
  tenantNiche,
} from "./schema";

/** Metering de PLATAFORMA (curadoria) — nunca vai para o tenant. */
export async function recordPlatformUsage(input: {
  type: string;
  tokensIn?: number;
  tokensOut?: number;
  costMicros?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await getDb()
    .insert(platformUsage)
    .values({
      type: input.type,
      tokensIn: input.tokensIn ?? null,
      tokensOut: input.tokensOut ?? null,
      costMicros: input.costMicros ?? null,
      metadata: input.metadata ?? {},
    });
}

// ── Atribuição tenant → nicho (resolvida no servidor) ─────────

/** Nicho do tenant ATIVO (ou null). RLS tenant-scoped — o tenant não forja. */
export async function getTenantNicheId(): Promise<string | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ nicheId: tenantNiche.nicheId })
      .from(tenantNiche)
      .where(eq(tenantNiche.tenantId, tenantId));
    return rows[0]?.nicheId ?? null;
  });
}

/** Atribui o tenant ativo a um nicho (caminho admin; roda no contexto do tenant). */
export async function assignTenantNiche(nicheId: string): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .insert(tenantNiche)
      .values({ tenantId, nicheId })
      .onConflictDoUpdate({ target: tenantNiche.tenantId, set: { nicheId } });
  });
}

export interface NicheRef {
  id: string;
  name: string;
  vertical: string;
  motion: string;
  guidance: string | null;
}

/** Acha um nicho por nome (idempotência do kit). */
export async function getNicheByName(name: string): Promise<NicheRef | null> {
  const rows = await getDb()
    .select({
      id: niches.id,
      name: niches.name,
      vertical: niches.vertical,
      motion: niches.motion,
      guidance: niches.guidance,
    })
    .from(niches)
    .where(eq(niches.name, name));
  return rows[0] ?? null;
}

/** Atualiza a guidance de um nicho (kit). */
export async function setNicheGuidance(nicheId: string, guidance: string): Promise<void> {
  await getDb().update(niches).set({ guidance }).where(eq(niches.id, nicheId));
}

export interface NicheConfigRow {
  qualification: unknown | null;
  kitVersion: string | null;
  config: Record<string, unknown>;
}

/** Config do nicho (schema de qualificação + versão do kit). Leitura sob withNiche. */
export async function getNicheConfig(nicheId: string): Promise<NicheConfigRow | null> {
  return withNiche(nicheId, async (tx) => {
    const rows = await tx
      .select({
        qualification: nicheConfigs.qualification,
        kitVersion: nicheConfigs.kitVersion,
        config: nicheConfigs.config,
      })
      .from(nicheConfigs)
      .where(eq(nicheConfigs.nicheId, nicheId));
    const r = rows[0];
    if (!r) return null;
    return {
      qualification: r.qualification ?? null,
      kitVersion: r.kitVersion ?? null,
      config: (r.config as Record<string, unknown>) ?? {},
    };
  });
}

/** Upsert da config do nicho (curadoria). */
export async function upsertNicheConfig(
  nicheId: string,
  input: { qualification?: unknown; kitVersion?: string; config?: Record<string, unknown> },
): Promise<void> {
  await withCuration(nicheId, async (tx) => {
    await tx
      .insert(nicheConfigs)
      .values({
        nicheId,
        qualification: input.qualification ?? null,
        kitVersion: input.kitVersion ?? null,
        config: input.config ?? {},
      })
      .onConflictDoUpdate({
        target: nicheConfigs.nicheId,
        set: {
          qualification: input.qualification ?? null,
          kitVersion: input.kitVersion ?? null,
          config: input.config ?? {},
          updatedAt: new Date(),
        },
      });
  });
}

/** Aposenta o conhecimento de plataforma (kit) ativo do nicho — p/ reaplicar versão. */
export async function retirePlatformAuthoredKnowledge(nicheId: string): Promise<void> {
  await withCuration(nicheId, async (tx) => {
    await tx
      .update(nicheKnowledge)
      .set({ status: "retired" })
      .where(
        and(
          eq(nicheKnowledge.nicheId, nicheId),
          eq(nicheKnowledge.sourceKind, "platform_authored"),
          eq(nicheKnowledge.status, "active"),
        ),
      );
  });
}

/** Lê o nicho (tabela de referência, sem RLS de tenant). */
export async function getNiche(nicheId: string): Promise<NicheRef | null> {
  const rows = await getDb()
    .select({
      id: niches.id,
      name: niches.name,
      vertical: niches.vertical,
      motion: niches.motion,
      guidance: niches.guidance,
    })
    .from(niches)
    .where(eq(niches.id, nicheId));
  return rows[0] ?? null;
}

// ── Busca no conhecimento de nicho (read-only, RLS por app.niche_id) ──

export interface NicheChunk {
  id: string;
  content: string;
  score: number;
}

export async function searchNicheKnowledge(
  nicheId: string,
  queryVector: number[],
  topK: number,
  minScore: number,
  queryText?: string,
): Promise<NicheChunk[]> {
  assertVectorDim(queryVector);
  const literal = `[${queryVector.join(",")}]`;
  const k = Math.max(1, Math.floor(topK));
  const text = queryText?.trim();
  return withNiche(nicheId, async (tx) => {
    const vectorLeg = sql`
      SELECT id, content, (1 - (embedding <=> ${literal}::vector))::float8 AS score
      FROM niche_knowledge
      WHERE status = 'active' AND (1 - (embedding <=> ${literal}::vector)) >= ${minScore}
      ORDER BY embedding <=> ${literal}::vector ASC
      LIMIT ${k}`;
    // Perna keyword (busca híbrida M5, paridade com o conhecimento do tenant):
    // resgate de recall com score = cosseno real, sem minScore. Oversampling
    // (k*4) no corte por ts_rank + dedup explícito por id (revisão Codex).
    const query = text
      ? sql`
        SELECT * FROM (
          SELECT DISTINCT ON (id) * FROM (
            (${vectorLeg})
            UNION ALL
            (SELECT id, content, (1 - (embedding <=> ${literal}::vector))::float8 AS score
             FROM niche_knowledge
             WHERE status = 'active'
               AND to_tsvector('portuguese', content) @@ websearch_to_tsquery('portuguese', ${text})
             ORDER BY ts_rank(to_tsvector('portuguese', content),
                              websearch_to_tsquery('portuguese', ${text})) DESC
             LIMIT ${k * 4})
          ) raw
          ORDER BY id, score DESC
        ) u
        ORDER BY u.score DESC
        LIMIT ${k}`
      : vectorLeg;
    const rows = (await tx.execute(query)) as unknown as Array<{ id: string; content: string; score: number }>;
    return rows.map((r) => ({ id: r.id, content: r.content, score: Number(r.score) }));
  });
}

// ── Curadoria (caminho de plataforma, app.curation) ───────────

export interface CandidateInput {
  candidateType: string;
  content: string;
  evidenceCount?: number;
  sourceTenantId?: string;
  sourceRefs?: unknown[];
  redactionChecked: boolean;
}

export interface CandidateRow {
  id: string;
  nicheId: string;
  candidateType: string;
  content: string;
  status: string;
  redactionChecked: boolean;
  evidenceCount: number;
}

export async function createCandidate(nicheId: string, input: CandidateInput): Promise<{ id: string }> {
  return withCuration(nicheId, async (tx) => {
    const rows = await tx
      .insert(curationCandidates)
      .values({
        nicheId,
        candidateType: input.candidateType,
        content: input.content,
        evidenceCount: input.evidenceCount ?? 1,
        sourceTenantId: input.sourceTenantId ?? null,
        sourceRefs: input.sourceRefs ?? [],
        redactionChecked: input.redactionChecked,
      })
      .returning({ id: curationCandidates.id });
    return { id: rows[0]!.id };
  });
}

export async function listCandidates(nicheId: string, status?: string): Promise<CandidateRow[]> {
  return withCuration(nicheId, async (tx) => {
    const where = status
      ? and(eq(curationCandidates.nicheId, nicheId), eq(curationCandidates.status, status))
      : eq(curationCandidates.nicheId, nicheId);
    const rows = await tx
      .select({
        id: curationCandidates.id,
        nicheId: curationCandidates.nicheId,
        candidateType: curationCandidates.candidateType,
        content: curationCandidates.content,
        status: curationCandidates.status,
        redactionChecked: curationCandidates.redactionChecked,
        evidenceCount: curationCandidates.evidenceCount,
      })
      .from(curationCandidates)
      .where(where);
    return rows;
  });
}

export async function getCandidate(nicheId: string, id: string): Promise<CandidateRow | null> {
  return withCuration(nicheId, async (tx) => {
    const rows = await tx
      .select({
        id: curationCandidates.id,
        nicheId: curationCandidates.nicheId,
        candidateType: curationCandidates.candidateType,
        content: curationCandidates.content,
        status: curationCandidates.status,
        redactionChecked: curationCandidates.redactionChecked,
        evidenceCount: curationCandidates.evidenceCount,
      })
      .from(curationCandidates)
      .where(and(eq(curationCandidates.nicheId, nicheId), eq(curationCandidates.id, id)));
    return rows[0] ?? null;
  });
}

export async function setCandidateStatus(
  nicheId: string,
  id: string,
  status: string,
  curatorId?: string,
  content?: string,
): Promise<void> {
  await withCuration(nicheId, async (tx) => {
    const rows = await tx
      .update(curationCandidates)
      .set({
        status,
        ...(curatorId ? { curatorId } : {}),
        ...(content !== undefined ? { content } : {}),
        reviewedAt: new Date(),
      })
      .where(and(eq(curationCandidates.nicheId, nicheId), eq(curationCandidates.id, id)))
      .returning({ id: curationCandidates.id });
    if (rows.length === 0) throw new Error(`Candidato ${id} não encontrado no nicho.`);
  });
}

/**
 * PROMOÇÃO ATÔMICA: numa única transação de curadoria, re-valida que o candidato
 * está `approved`, insere o conhecimento (versionado) e marca `promoted`. Fecha o
 * bypass do gate humano (a checagem e a escrita acontecem juntas).
 */
export async function promoteCandidate(
  nicheId: string,
  candidateId: string,
  embedding: number[],
): Promise<{ knowledgeId: string }> {
  assertVectorDim(embedding);
  return withCuration(nicheId, async (tx) => {
    const cand = await tx
      .select({ content: curationCandidates.content, status: curationCandidates.status })
      .from(curationCandidates)
      .where(and(eq(curationCandidates.nicheId, nicheId), eq(curationCandidates.id, candidateId)));
    const c = cand[0];
    if (!c) throw new Error("Candidato não encontrado.");
    if (c.status !== "approved") throw new Error(`Só candidato 'approved' promove (atual: ${c.status}).`);
    const verRows = (await tx.execute(sql`
      SELECT coalesce(max(version), 0)::int AS v FROM niche_knowledge WHERE niche_id = ${nicheId}
    `)) as unknown as Array<{ v: number }>;
    const version = Number(verRows[0]?.v ?? 0) + 1;
    const ins = await tx
      .insert(nicheKnowledge)
      .values({ nicheId, content: c.content, embedding, version, sourceKind: "curation", status: "active" })
      .returning({ id: nicheKnowledge.id });
    await tx
      .update(curationCandidates)
      .set({ status: "promoted", reviewedAt: new Date() })
      .where(and(eq(curationCandidates.nicheId, nicheId), eq(curationCandidates.id, candidateId)));
    return { knowledgeId: ins[0]!.id };
  });
}

/**
 * Insere conhecimento de nicho de PLATAFORMA (kit/seed). Exige app.curation. O
 * `sourceKind` NÃO aceita `'curation'` — conteúdo minerado de tenant só entra por
 * `promoteCandidate` (gate humano). Reforça a distinção platform_authored × mined.
 */
export async function insertNicheKnowledge(
  nicheId: string,
  content: string,
  embedding: number[],
  sourceKind: "platform_authored" | "manual",
): Promise<{ id: string }> {
  assertVectorDim(embedding);
  return withCuration(nicheId, async (tx) => {
    const verRows = (await tx.execute(sql`
      SELECT coalesce(max(version), 0)::int AS v FROM niche_knowledge WHERE niche_id = ${nicheId}
    `)) as unknown as Array<{ v: number }>;
    const version = Number(verRows[0]?.v ?? 0) + 1;
    const rows = await tx
      .insert(nicheKnowledge)
      .values({ nicheId, content, embedding, version, sourceKind, status: "active" })
      .returning({ id: nicheKnowledge.id });
    return { id: rows[0]!.id };
  });
}

/** Rollback: aposenta um item de conhecimento de nicho. */
export async function retireNicheKnowledge(nicheId: string, id: string): Promise<void> {
  await withCuration(nicheId, async (tx) => {
    await tx
      .update(nicheKnowledge)
      .set({ status: "retired" })
      .where(and(eq(nicheKnowledge.nicheId, nicheId), eq(nicheKnowledge.id, id)));
  });
}

/** Conversas que CONVERTERAM (qualified/handoff) do tenant ativo — matéria-prima da mineração. */
export async function listConvertedConversationIds(limit = 50): Promise<string[]> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ id: leadProfiles.conversationId })
      .from(leadProfiles)
      .where(and(eq(leadProfiles.tenantId, tenantId), inArray(leadProfiles.status, ["qualified", "handoff"])))
      .limit(Math.max(1, limit));
    return rows.map((r) => r.id);
  });
}

/** Cria um nicho (plataforma). */
export async function createNiche(input: {
  name: string;
  vertical: string;
  motion: string;
  guidance?: string;
}): Promise<{ id: string }> {
  const rows = await getDb()
    .insert(niches)
    .values({
      name: input.name,
      vertical: input.vertical,
      motion: input.motion,
      guidance: input.guidance ?? null,
    })
    .returning({ id: niches.id });
  return { id: rows[0]!.id };
}
