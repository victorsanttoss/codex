import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient, withTenant } from "./client";
import {
  replaceSourceChunks,
  searchKnowledgeChunks,
  upsertKnowledgeSource,
} from "./knowledge";
import { KNOWLEDGE_VECTOR_DIM, knowledgeChunks } from "./schema";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

/** Vetor unitário de dimensão N com 1.0 na posição i (base canônica). */
function basis(i: number): number[] {
  const v = new Array<number>(KNOWLEDGE_VECTOR_DIM).fill(0);
  v[i] = 1;
  return v;
}

describe.skipIf(!dbConfigured)("conhecimento / RAG (pgvector + RLS)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('KA', ${"ka-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('KB', ${"kb-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  async function ingestA() {
    return runWithTenant({ tenantId: tenantA }, async () => {
      const { sourceId } = await upsertKnowledgeSource({
        externalRef: "faq-1",
        kind: "faq",
        title: "FAQ",
        contentHash: "h1",
        embeddingModel: "bge-m3",
      });
      await replaceSourceChunks(sourceId, [
        { ordinal: 0, content: "sobre gatos", embedding: basis(0), embeddingModel: "bge-m3" },
        { ordinal: 1, content: "sobre cães", embedding: basis(1), embeddingModel: "bge-m3" },
      ]);
      return sourceId;
    });
  }

  it("busca KNN retorna o chunk mais similar à query", async () => {
    await ingestA();
    const hits = await runWithTenant({ tenantId: tenantA }, () =>
      searchKnowledgeChunks(basis(0), { topK: 1 }),
    );
    expect(hits.length).toBe(1);
    expect(hits[0]!.content).toBe("sobre gatos");
    expect(hits[0]!.score).toBeGreaterThan(0.99); // cosseno ~1
    expect(hits[0]!.title).toBe("FAQ");
  });

  it("HÍBRIDA: keyword RESGATA termo exato que o vetor perde (sem minScore)", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const { sourceId } = await upsertKnowledgeSource({
        externalRef: "fin-1",
        kind: "doc",
        title: "Financiamento",
        contentHash: "hf",
        embeddingModel: "bge-m3",
      });
      // Chunk com termo raro; embedding ORTOGONAL à query (cosseno ~0 → o vetor
      // com minScore alto jamais o retornaria).
      await replaceSourceChunks(sourceId, [
        { ordinal: 0, content: "financiamento via linha Finame com carência", embedding: basis(7), embeddingModel: "bge-m3" },
      ]);

      // Só vetor (M5 original): minScore 0.5 filtra o chunk (cosseno 0).
      const vectorOnly = await searchKnowledgeChunks(basis(0), { topK: 5, minScore: 0.5 });
      expect(vectorOnly.some((h) => h.content.includes("Finame"))).toBe(false);

      // Híbrida: a perna keyword acha "Finame" (FTS pt) e entra apesar do minScore.
      const hybrid = await searchKnowledgeChunks(basis(0), { topK: 5, minScore: 0.5, queryText: "Finame" });
      const hit = hybrid.find((h) => h.content.includes("Finame"));
      expect(hit).toBeDefined();
      expect(hit!.score).toBeLessThan(0.5); // score segue sendo o cosseno REAL

      // Sem match de keyword nem de vetor → híbrida não inventa nada.
      const none = await searchKnowledgeChunks(basis(0), { topK: 5, minScore: 0.5, queryText: "inexistente xyzzy" });
      expect(none.some((h) => h.content.includes("Finame"))).toBe(false);
    });
    // Limpa a fonte deste teste (testes vizinhos contam os chunks do tenant).
    await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
      await tx`DELETE FROM knowledge_sources WHERE tenant_id = ${tenantA} AND external_ref = 'fin-1'`;
    });
  });

  it("idempotência: mesmo content_hash já 'ready' não re-embeda; hash novo sim", async () => {
    await ingestA();
    const again = await runWithTenant({ tenantId: tenantA }, () =>
      upsertKnowledgeSource({
        externalRef: "faq-1",
        kind: "faq",
        title: "FAQ",
        contentHash: "h1",
        embeddingModel: "bge-m3",
      }),
    );
    expect(again.changed).toBe(false);
    const changed = await runWithTenant({ tenantId: tenantA }, () =>
      upsertKnowledgeSource({
        externalRef: "faq-1",
        kind: "faq",
        title: "FAQ",
        contentHash: "h2",
        embeddingModel: "bge-m3",
      }),
    );
    expect(changed.changed).toBe(true);
  });

  it("re-ingestão SUBSTITUI os chunks (não duplica)", async () => {
    const sourceId = await ingestA(); // 2 chunks
    await runWithTenant({ tenantId: tenantA }, () =>
      replaceSourceChunks(sourceId, [
        { ordinal: 0, content: "único", embedding: basis(2), embeddingModel: "bge-m3" },
      ]),
    );
    const all = await runWithTenant({ tenantId: tenantA }, () =>
      withTenant((tx) => tx.select().from(knowledgeChunks)),
    );
    expect(all.length).toBe(1);
    expect(all[0]!.content).toBe("único");
  });

  it("ISOLAMENTO CRÍTICO: tenant B não recupera chunk do tenant A", async () => {
    await ingestA();
    // tenant B busca a MESMA query — não pode ver nada do A (RLS, não WHERE).
    const hitsB = await runWithTenant({ tenantId: tenantB }, () =>
      searchKnowledgeChunks(basis(0), { topK: 10 }),
    );
    expect(hitsB).toHaveLength(0);
    // e B não enxerga os chunks do A nem em SELECT direto sem filtro
    const rowsB = await runWithTenant({ tenantId: tenantB }, () =>
      withTenant((tx) => tx.select().from(knowledgeChunks)),
    );
    expect(rowsB).toHaveLength(0);
  });

  it("fail-closed: vetor com dimensão errada lança (não vai ao banco)", async () => {
    await expect(
      runWithTenant({ tenantId: tenantA }, () => searchKnowledgeChunks([1, 2, 3], { topK: 1 })),
    ).rejects.toThrow(/dimensão/i);
  });

  it("fail-closed: vetor com valor não-finito (NaN) lança", async () => {
    const bad = basis(0);
    bad[5] = NaN;
    await expect(
      runWithTenant({ tenantId: tenantA }, () => searchKnowledgeChunks(bad, { topK: 1 })),
    ).rejects.toThrow(/não-finito/i);
  });

  it("guarda de corrida: replaceSourceChunks aborta se o content_hash mudou", async () => {
    const sourceId = await ingestA();
    const applied = await runWithTenant({ tenantId: tenantA }, () =>
      replaceSourceChunks(
        sourceId,
        [{ ordinal: 0, content: "novo", embedding: basis(3), embeddingModel: "bge-m3" }],
        "hash-que-nao-existe-mais",
      ),
    );
    expect(applied).toBe(false); // outra ingestão "assumiu" a fonte
  });
});
