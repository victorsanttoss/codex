import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@sdr/config";
import {
  ProviderRegistry,
  runWithTenant,
  type EmbeddingProvider,
  type EmbeddingResult,
} from "@sdr/core";
import { closeDb, makeMigrationClient } from "@sdr/db";
import { EmbeddingService } from "./embedding.service";
import { KnowledgeIngestService } from "./knowledge-ingest.service";
import { KnowledgeRetriever } from "./knowledge-retriever.service";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

/**
 * Embedding fake DETERMINÍSTICO de dimensão 1024 (sem rede): hashing de tokens
 * em buckets, L2-normalizado. Mesmo texto → mesmo vetor; textos com palavras em
 * comum ficam próximos em cosseno.
 */
function fakeEmbeddingProvider(dim = 1024): EmbeddingProvider {
  return {
    id: "openai_compat",
    async embed(texts: string[]): Promise<EmbeddingResult> {
      const vectors = texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        for (const tok of t.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0;
          for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
          v[h % dim]! += 1;
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
      return { vectors, usage: { tokensIn: texts.reduce((s, t) => s + t.length, 0) } };
    },
  };
}

describe.skipIf(!dbConfigured)("M5 — conhecimento (integração ao vivo)", () => {
  const cfg = loadConfig();
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";
  let ingest: KnowledgeIngestService;
  let retriever: KnowledgeRetriever;

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('KIA', ${"kia-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('KIB', ${"kib-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
    const registry = new ProviderRegistry();
    registry.registerEmbedding("openai_compat", () => fakeEmbeddingProvider(cfg.embeddings.dim));
    const embeddings = new EmbeddingService(registry, cfg);
    ingest = new KnowledgeIngestService(embeddings);
    retriever = new KnowledgeRetriever(embeddings);
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  it("ingere e recupera por similaridade; grava metering de embedding", async () => {
    const r = await ingest.ingest({
      tenantId: tenantA,
      externalRef: "faq",
      kind: "faq",
      title: "FAQ",
      content: "Como cancelar o plano. Para falar com humano digite atendente.",
    });
    expect(r.ingested).toBe(true);

    const hits = await runWithTenant({ tenantId: tenantA }, () =>
      retriever.search("quero cancelar meu plano", { topK: 3 }),
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.content.toLowerCase()).toContain("cancelar");

    // metering: ao menos 1 evento type 'embedding' p/ o tenant A (sob RLS).
    // recordUsage é fire-and-forget (fora do caminho crítico) → poll curto.
    const deadline = Date.now() + 2_000;
    let n = 0;
    while (Date.now() < deadline && n === 0) {
      const rows = await mig.sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        return tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM usage_events WHERE type = 'embedding'`;
      });
      n = (rows as unknown as { n: number }[])[0]!.n;
      if (n === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("idempotência: re-ingerir o mesmo conteúdo não re-embeda", async () => {
    const job = {
      tenantId: tenantA,
      externalRef: "doc-idem",
      kind: "doc" as const,
      title: "Doc",
      content: "conteúdo estável para idempotência",
    };
    const first = await ingest.ingest(job);
    const second = await ingest.ingest(job);
    expect(first.ingested).toBe(true);
    expect(second.ingested).toBe(false);
  });

  it("ISOLAMENTO: busca do tenant B não retorna conhecimento do tenant A", async () => {
    await ingest.ingest({
      tenantId: tenantA,
      externalRef: "secreto",
      kind: "text",
      title: "Secreto",
      content: "segredo do tenant A sobre precificação interna",
    });
    const hitsB = await runWithTenant({ tenantId: tenantB }, () =>
      retriever.search("precificação interna", { topK: 10 }),
    );
    expect(hitsB).toHaveLength(0);
  });
});
