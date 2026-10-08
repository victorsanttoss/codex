import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant, type EmbeddingProvider, type EmbeddingResult, ProviderRegistry } from "@sdr/core";
import {
  assignTenantNiche,
  closeDb,
  createNiche,
  insertNicheKnowledge,
  makeMigrationClient,
} from "@sdr/db";
import { EmbeddingService } from "../knowledge/embedding.service";
import { KnowledgeRetriever } from "../knowledge/knowledge-retriever.service";
import { NicheService } from "./niche.service";
import { NicheKnowledgeSource } from "./niche-knowledge.source";
import { loadConfig } from "@sdr/config";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

/** Embedding fake determinístico dim 1024 (hashing L2-normalizado), igual ao M5. */
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
      return { vectors, usage: { tokensIn: 1 } };
    },
  };
}

describe.skipIf(!dbConfigured)("M9 — retriever mescla nicho (integração)", () => {
  const cfg = loadConfig();
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId = "";
  let nicheId = "";
  let retriever: KnowledgeRetriever;

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('NI', ${"ni-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
    nicheId = (await createNiche({ name: "ni-" + randomUUID(), vertical: "solar", motion: "inbound", guidance: "ancore no payback" })).id;
    await runWithTenant({ tenantId }, () => assignTenantNiche(nicheId));

    const registry = new ProviderRegistry();
    registry.registerEmbedding("openai_compat", () => fakeEmbeddingProvider(cfg.embeddings.dim));
    const embeddings = new EmbeddingService(registry, cfg);
    // grava conhecimento de nicho com o vetor do termo "payback" (mesmo embedding)
    const vec = (await runWithTenant({ tenantId }, () => embeddings.embed(["payback solar"]))).vectors[0]!;
    await insertNicheKnowledge(nicheId, "Em solar, o payback costuma ser de 4 anos.", vec, "manual");

    const niche = new NicheKnowledgeSource(new NicheService());
    retriever = new KnowledgeRetriever(embeddings, [niche]);
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql`DELETE FROM niches WHERE id = ${nicheId}`;
    await mig.sql.end();
    await closeDb();
  });

  it("recupera o conhecimento de NICHO via retriever (sem conhecimento de tenant)", async () => {
    const hits = await runWithTenant({ tenantId }, () => retriever.search("qual o payback solar?", { topK: 3 }));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.content.toLowerCase()).toContain("payback");
    expect(hits[0]!.externalRef).toBe("niche"); // veio da fonte de nicho
  });

  it("tenant SEM nicho atribuído → fonte de nicho retorna vazio (não quebra)", async () => {
    const [t2] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('NX', ${"nx-" + randomUUID()}) RETURNING id`;
    const hits = await runWithTenant({ tenantId: t2!.id }, () => retriever.search("payback?", { topK: 3 }));
    expect(hits).toHaveLength(0);
    await mig.sql`DELETE FROM tenants WHERE id = ${t2!.id}`;
  });
});
