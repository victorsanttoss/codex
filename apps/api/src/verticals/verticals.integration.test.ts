import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@sdr/config";
import { ProviderRegistry, runWithTenant, type EmbeddingProvider, type EmbeddingResult } from "@sdr/core";
import { assignTenantNiche, closeDb, getNicheByName, makeMigrationClient } from "@sdr/db";
import { KitApplierService } from "./kit-applier.service";
import { SOLAR_KIT, ODONTO_KIT } from "./kits";
import { AgentConfigService } from "../agent/agent-config";
import { EmbeddingService } from "../knowledge/embedding.service";
import { KnowledgeRetriever } from "../knowledge/knowledge-retriever.service";
import { NicheService } from "../niche/niche.service";
import { NicheKnowledgeSource } from "../niche/niche-knowledge.source";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

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

describe.skipIf(!dbConfigured)("M10 — verticais (kit aplicado ponta a ponta)", () => {
  const cfg = loadConfig();
  let mig: ReturnType<typeof makeMigrationClient>;
  let applier: KitApplierService;
  let retriever: KnowledgeRetriever;
  const agentConfig = new AgentConfigService();
  const niche = new NicheService();
  let solarNicheId = "";
  let odontoNicheId = "";
  let tenantSolar = "";
  let tenantOdonto = "";
  const createdNiches: string[] = [];

  beforeAll(async () => {
    mig = makeMigrationClient();
    const registry = new ProviderRegistry();
    registry.registerEmbedding("openai_compat", () => fakeEmbeddingProvider(cfg.embeddings.dim));
    applier = new KitApplierService(registry, cfg);
    const embeddings = new EmbeddingService(registry, cfg);
    retriever = new KnowledgeRetriever(embeddings, [new NicheKnowledgeSource(niche)]);

    // usa nomes únicos p/ não colidir com outras execuções
    const solarKit = { ...SOLAR_KIT, niche: { ...SOLAR_KIT.niche, name: "solar-" + randomUUID() } };
    const odontoKit = { ...ODONTO_KIT, niche: { ...ODONTO_KIT.niche, name: "odonto-" + randomUUID() } };
    solarNicheId = (await applier.apply(solarKit)).nicheId;
    odontoNicheId = (await applier.apply(odontoKit)).nicheId;
    createdNiches.push(solarNicheId, odontoNicheId);
    // re-aplica solar p/ idempotência (será no-op)
    const re = await applier.apply(solarKit);
    expect(re.applied).toBe(false);

    const [ts] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('TS', ${"ts-" + randomUUID()}) RETURNING id`;
    const [to] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('TO', ${"to-" + randomUUID()}) RETURNING id`;
    tenantSolar = ts!.id;
    tenantOdonto = to!.id;
    await runWithTenant({ tenantId: tenantSolar }, () => assignTenantNiche(solarNicheId));
    await runWithTenant({ tenantId: tenantOdonto }, () => assignTenantNiche(odontoNicheId));
    void getNicheByName;
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantSolar}, ${tenantOdonto})`;
    for (const n of createdNiches) await mig.sql`DELETE FROM niches WHERE id = ${n}`;
    await mig.sql.end();
    await closeDb();
  });

  it("SCHEMA por nicho: tenant do nicho solar herda o schema de qualificação solar", async () => {
    const c = await runWithTenant({ tenantId: tenantSolar }, () => agentConfig.forTenant());
    expect(c.qualification.fields.some((f) => f.key === "valor_conta_luz")).toBe(true);
    // tenant do odonto herda o schema de odonto (não o de solar)
    const co = await runWithTenant({ tenantId: tenantOdonto }, () => agentConfig.forTenant());
    expect(co.qualification.fields.some((f) => f.key === "procedimento_interesse")).toBe(true);
    expect(co.qualification.fields.some((f) => f.key === "valor_conta_luz")).toBe(false);
  });

  it("GUIDANCE + conhecimento de solar chegam ao tenant solar", async () => {
    const g = await runWithTenant({ tenantId: tenantSolar }, () => niche.getGuidance());
    expect(g).toContain("solar");
    const hits = await runWithTenant({ tenantId: tenantSolar }, () =>
      retriever.search("quanto fica minha conta de luz?", { topK: 3 }),
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.externalRef === "niche")).toBe(true);
  });

  it("ISOLAMENTO: tenant solar NÃO recebe guidance/conhecimento de odonto", async () => {
    const g = await runWithTenant({ tenantId: tenantSolar }, () => niche.getGuidance());
    expect(g).not.toContain("odontológica");
    const hits = await runWithTenant({ tenantId: tenantSolar }, () =>
      retriever.search("convênio ou particular?", { topK: 5 }),
    );
    expect(hits.some((h) => h.content.toLowerCase().includes("convênio"))).toBe(false);
  });
});
