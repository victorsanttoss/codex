import { and, eq, sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { KNOWLEDGE_VECTOR_DIM, knowledgeChunks, knowledgeSources } from "./schema";

export type KnowledgeSourceKind = "faq" | "doc" | "text";

/**
 * Vetor com dimensão errada OU com elementos não-finitos é rejeitado ANTES do
 * banco (fail-closed) — NaN/Infinity estouram o parser do pgvector ou contaminam
 * a busca.
 */
export function assertVectorDim(vector: number[]): void {
  if (vector.length !== KNOWLEDGE_VECTOR_DIM) {
    throw new Error(
      `Dimensão de embedding inválida: ${vector.length} (esperado ${KNOWLEDGE_VECTOR_DIM}).`,
    );
  }
  for (const x of vector) {
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw new Error("Embedding com valor não-finito (NaN/Infinity) — rejeitado.");
    }
  }
}

export interface UpsertSourceInput {
  /** Chave estável da fonte no tenant (re-ingestão atualiza a mesma). */
  externalRef: string;
  kind: KnowledgeSourceKind;
  title: string;
  /** Hash do conteúdo normalizado — detecta "nada mudou" (idempotência). */
  contentHash: string;
  embeddingModel: string;
}

export interface UpsertSourceResult {
  sourceId: string;
  /** false = mesmo content_hash já 'ready' → NÃO precisa re-embedar (idempotente). */
  changed: boolean;
}

/**
 * Cria/atualiza a fonte do tenant ativo por (tenant, external_ref). Se o
 * content_hash não mudou e a fonte já está 'ready', retorna changed=false — o
 * chamador pula o re-embedding. Caso contrário marca 'pending' (será 'ready'
 * quando os chunks forem gravados).
 */
export async function upsertKnowledgeSource(input: UpsertSourceInput): Promise<UpsertSourceResult> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const existing = await tx
      .select()
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.tenantId, tenantId),
          eq(knowledgeSources.externalRef, input.externalRef),
        ),
      );
    const cur = existing[0];
    if (cur && cur.contentHash === input.contentHash && cur.status === "ready") {
      return { sourceId: cur.id, changed: false };
    }
    if (cur) {
      await tx
        .update(knowledgeSources)
        .set({
          kind: input.kind,
          title: input.title,
          status: "pending",
          contentHash: input.contentHash,
          embeddingModel: input.embeddingModel,
          dim: KNOWLEDGE_VECTOR_DIM,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeSources.id, cur.id));
      return { sourceId: cur.id, changed: true };
    }
    const inserted = await tx
      .insert(knowledgeSources)
      .values({
        tenantId,
        externalRef: input.externalRef,
        kind: input.kind,
        title: input.title,
        status: "pending",
        contentHash: input.contentHash,
        embeddingModel: input.embeddingModel,
        dim: KNOWLEDGE_VECTOR_DIM,
      })
      .returning({ id: knowledgeSources.id });
    return { sourceId: inserted[0]!.id, changed: true };
  });
}

export interface ChunkInput {
  ordinal: number;
  content: string;
  embedding: number[];
  tokenCount?: number;
  embeddingModel: string;
}

/**
 * SUBSTITUI os chunks de uma fonte (apaga os antigos e insere os novos) numa
 * transação e marca a fonte 'ready'. Re-ingestão não duplica — sempre troca.
 *
 * `expectedContentHash` evita corrida entre dois ingests da MESMA fonte: dentro
 * da transação, re-confere o `content_hash` atual; se outro job já o alterou,
 * ABORTA (retorna false) — os chunks só são gravados quando casam com o conteúdo
 * persistido, e a fonte nunca fica 'ready' com chunks de conteúdo velho.
 */
export async function replaceSourceChunks(
  sourceId: string,
  chunks: ChunkInput[],
  expectedContentHash?: string,
): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  for (const c of chunks) assertVectorDim(c.embedding);
  return withTenant(async (tx) => {
    if (expectedContentHash !== undefined) {
      const cur = await tx
        .select({ contentHash: knowledgeSources.contentHash })
        .from(knowledgeSources)
        .where(and(eq(knowledgeSources.tenantId, tenantId), eq(knowledgeSources.id, sourceId)));
      if (!cur[0] || cur[0].contentHash !== expectedContentHash) return false; // outra ingestão assumiu
    }
    await tx
      .delete(knowledgeChunks)
      .where(and(eq(knowledgeChunks.tenantId, tenantId), eq(knowledgeChunks.sourceId, sourceId)));
    if (chunks.length > 0) {
      await tx.insert(knowledgeChunks).values(
        chunks.map((c) => ({
          tenantId,
          sourceId,
          ordinal: c.ordinal,
          content: c.content,
          embedding: c.embedding,
          tokenCount: c.tokenCount ?? null,
          embeddingModel: c.embeddingModel,
          dim: KNOWLEDGE_VECTOR_DIM,
        })),
      );
    }
    await tx
      .update(knowledgeSources)
      .set({ status: "ready", updatedAt: new Date() })
      .where(eq(knowledgeSources.id, sourceId));
    return true;
  });
}

export interface SourceRef {
  sourceId: string;
  kind: KnowledgeSourceKind;
  title: string;
}

/** Localiza a fonte do tenant ativo por external_ref (p/ reindex). */
export async function findSourceByRef(externalRef: string): Promise<SourceRef | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({
        sourceId: knowledgeSources.id,
        kind: knowledgeSources.kind,
        title: knowledgeSources.title,
      })
      .from(knowledgeSources)
      .where(
        and(eq(knowledgeSources.tenantId, tenantId), eq(knowledgeSources.externalRef, externalRef)),
      );
    return rows[0] ?? null;
  });
}

export interface ChunkContent {
  ordinal: number;
  content: string;
}

/** Conteúdo dos chunks de uma fonte, em ordem (p/ reindex re-embedar). */
export async function listSourceChunkContents(sourceId: string): Promise<ChunkContent[]> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ ordinal: knowledgeChunks.ordinal, content: knowledgeChunks.content })
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.tenantId, tenantId), eq(knowledgeChunks.sourceId, sourceId)))
      .orderBy(knowledgeChunks.ordinal);
    return rows;
  });
}

/** Marca a fonte como falha (ingestão abortou). */
export async function markSourceFailed(sourceId: string): Promise<void> {
  await withTenant(async (tx) => {
    await tx
      .update(knowledgeSources)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(knowledgeSources.id, sourceId));
  });
}

export interface SearchOptions {
  topK: number;
  /** Similaridade de cosseno mínima (∈ [-1,1]); default -1 = sem filtro. */
  minScore?: number;
  /**
   * Texto da query p/ a perna KEYWORD da busca híbrida (FTS 'portuguese', M5). O
   * keyword é RESGATE de recall: acha o que o ANN perde (nomes próprios, códigos,
   * termos raros) e entra pontuado pelo COSSENO real (scores seguem comparáveis
   * entre fontes — ADR 0021); por ser evidência de termo exato, NÃO é filtrado
   * pelo minScore. Ausente/vazio → busca só vetorial (comportamento M5 original).
   */
  queryText?: string;
}

export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  title: string;
  externalRef: string;
  content: string;
  /** Similaridade de cosseno (1 = idêntico). */
  score: number;
}

/**
 * Busca HÍBRIDA no conhecimento do TENANT ATIVO (isolada por RLS — roda sob
 * withTenant/SET LOCAL app.tenant_id; não confiamos só no WHERE). Perna vetorial
 * (KNN cosseno, com minScore) + perna keyword opcional (FTS 'portuguese', resgate
 * de recall, sem minScore); união deduplicada, ordenada por cosseno desc.
 */
export async function searchKnowledgeChunks(
  queryVector: number[],
  opts: SearchOptions,
): Promise<RetrievedChunk[]> {
  assertVectorDim(queryVector);
  const topK = Math.max(1, Math.floor(opts.topK));
  const minScore = opts.minScore ?? -1;
  const literal = `[${queryVector.join(",")}]`;
  const queryText = opts.queryText?.trim();
  return withTenant(async (tx) => {
    const vectorLeg = sql`
      SELECT c.id AS chunk_id, c.source_id, c.content,
             s.title, s.external_ref,
             (1 - (c.embedding <=> ${literal}::vector))::float8 AS score
      FROM knowledge_chunks c
      JOIN knowledge_sources s ON s.id = c.source_id
      WHERE (1 - (c.embedding <=> ${literal}::vector)) >= ${minScore}
      ORDER BY c.embedding <=> ${literal}::vector ASC
      LIMIT ${topK}`;
    // websearch_to_tsquery aceita texto de usuário arbitrário sem erro de sintaxe.
    // Perna keyword com OVERSAMPLING (topK*4): o corte dela é por ts_rank, mas a
    // ordenação final é por cosseno — sem folga, um hit lexical de cosseno alto
    // poderia ser descartado pelo rank (revisão Codex). Dedup explícito por
    // chunk_id (UNION ALL + DISTINCT ON), não pela linha inteira.
    const query = queryText
      ? sql`
        SELECT * FROM (
          SELECT DISTINCT ON (chunk_id) * FROM (
            (${vectorLeg})
            UNION ALL
            (SELECT c.id AS chunk_id, c.source_id, c.content,
                    s.title, s.external_ref,
                    (1 - (c.embedding <=> ${literal}::vector))::float8 AS score
             FROM knowledge_chunks c
             JOIN knowledge_sources s ON s.id = c.source_id
             WHERE to_tsvector('portuguese', c.content)
                   @@ websearch_to_tsquery('portuguese', ${queryText})
             ORDER BY ts_rank(to_tsvector('portuguese', c.content),
                              websearch_to_tsquery('portuguese', ${queryText})) DESC
             LIMIT ${topK * 4})
          ) raw
          ORDER BY chunk_id, score DESC
        ) u
        ORDER BY u.score DESC
        LIMIT ${topK}`
      : vectorLeg;
    const rows = (await tx.execute(query)) as unknown as Array<{
      chunk_id: string;
      source_id: string;
      content: string;
      title: string;
      external_ref: string;
      score: number;
    }>;
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      sourceId: r.source_id,
      title: r.title,
      externalRef: r.external_ref,
      content: r.content,
      score: Number(r.score),
    }));
  });
}

export interface KnowledgeSourceRow {
  externalRef: string;
  kind: string;
  title: string;
  /** pending | ready | failed (a ingestão é assíncrona). */
  status: string;
  chunkCount: number;
  updatedAt: Date;
}

/** Lista as fontes de conhecimento do tenant com contagem de chunks (painel/wizard). */
export async function listKnowledgeSources(): Promise<KnowledgeSourceRow[]> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    // Duas queries simples (fontes + counts agrupados) — um subquery correlacionado
    // via sql`` renderizava errado no drizzle e devolvia 0 silenciosamente.
    const rows = await tx
      .select({
        id: knowledgeSources.id,
        externalRef: knowledgeSources.externalRef,
        kind: knowledgeSources.kind,
        title: knowledgeSources.title,
        status: knowledgeSources.status,
        updatedAt: knowledgeSources.updatedAt,
      })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.tenantId, tenantId))
      .orderBy(knowledgeSources.updatedAt);
    const counts = await tx
      .select({ sourceId: knowledgeChunks.sourceId, n: sql<number>`count(*)::int` })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.tenantId, tenantId))
      .groupBy(knowledgeChunks.sourceId);
    const bySource = new Map(counts.map((c) => [c.sourceId, c.n]));
    return rows.map(({ id, ...rest }) => ({ ...rest, chunkCount: bySource.get(id) ?? 0 }));
  });
}

/**
 * Exclui uma fonte de conhecimento e TODOS os seus chunks (tx). Retorna se a
 * fonte existia. O RAG deixa de ver o conteúdo imediatamente.
 */
export async function deleteKnowledgeSource(externalRef: string): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.tenantId, tenantId), eq(knowledgeSources.externalRef, externalRef)))
      .limit(1);
    const cur = rows[0];
    if (!cur) return false;
    await tx
      .delete(knowledgeChunks)
      .where(and(eq(knowledgeChunks.tenantId, tenantId), eq(knowledgeChunks.sourceId, cur.id)));
    await tx.delete(knowledgeSources).where(eq(knowledgeSources.id, cur.id));
    return true;
  });
}
