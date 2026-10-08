import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "@sdr/config";
import { ProviderRegistry, runWithTenant, type EmbeddingProvider, type EmbeddingResult } from "@sdr/core";
import {
  assignTenantNiche,
  closeDb,
  createNiche,
  getCandidate,
  makeMigrationClient,
  schema,
  searchNicheKnowledge,
  withCuration,
} from "@sdr/db";
import { AnonymizationService } from "./anonymization.service";
import { CurationService } from "./curation.service";
import { CurationMiningService, type InsightExtractor } from "./mining.service";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

function fakeEmbeddingProvider(dim = 1024): EmbeddingProvider {
  return {
    id: "openai_compat",
    async embed(texts: string[]): Promise<EmbeddingResult> {
      const v = new Array<number>(dim).fill(0);
      v[3] = 1;
      return { vectors: texts.map(() => v.slice()), usage: { tokensIn: 5 } };
    },
  };
}

describe.skipIf(!dbConfigured)("M9 — curadoria (humano + zero PII + plataforma)", () => {
  const cfg = loadConfig();
  let mig: ReturnType<typeof makeMigrationClient>;
  let nicheId = "";
  let curation: CurationService;

  beforeAll(async () => {
    mig = makeMigrationClient();
    nicheId = (await createNiche({ name: "cur-" + randomUUID(), vertical: "solar", motion: "inbound" })).id;
    const registry = new ProviderRegistry();
    registry.registerEmbedding("openai_compat", () => fakeEmbeddingProvider(cfg.embeddings.dim));
    curation = new CurationService(registry, cfg, new AnonymizationService());
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM niches WHERE id = ${nicheId}`;
    await mig.sql.end();
    await closeDb();
  });

  it("createCandidate ANONIMIZA (zero PII gravado)", async () => {
    const { id } = await curation.createCandidate(nicheId, {
      candidateType: "objection_handling",
      content: "Cliente joao@x.com fechou por R$ 9.000 quando focamos no payback",
    });
    const c = await getCandidate(nicheId, id);
    expect(c!.content).not.toContain("joao@x.com");
    expect(c!.content).not.toContain("9.000");
    expect(c!.content).toContain("payback"); // padrão preservado
  });

  it("CURADORIA HUMANA obrigatória: candidato PENDING não promove", async () => {
    const { id } = await curation.createCandidate(nicheId, { candidateType: "faq", content: "padrão genérico" });
    await expect(curation.promote(nicheId, id)).rejects.toThrow(/approved/i);
  });

  it("approve → promote versiona o conhecimento de nicho + metering de PLATAFORMA", async () => {
    const { id } = await curation.createCandidate(nicheId, {
      candidateType: "vocabulary",
      content: "no segmento, chamamos a conta de luz de fatura",
    });
    await curation.approve(nicheId, id, "curador-1");
    const { knowledgeId } = await curation.promote(nicheId, id);
    expect(knowledgeId).toBeTruthy();

    // virou conhecimento ativo do nicho (o fake embedda no eixo 3)
    const qv = new Array(1024).fill(0).map((_, i) => (i === 3 ? 1 : 0));
    const hits = await searchNicheKnowledge(nicheId, qv, 5, -1);
    expect(hits.some((h) => h.id === knowledgeId)).toBe(true);
    // candidato marcado promoted
    expect((await getCandidate(nicheId, id))!.status).toBe("promoted");
    // metering foi para a PLATAFORMA, não para tenant nenhum
    const pu = await mig.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM platform_usage WHERE type = 'curation_embedding'`;
    expect(pu[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it("mineração: extractor gera candidato anonimizado; NUNCA promove sozinho", async () => {
    const fakeExtractor: InsightExtractor = {
      async extract() {
        return { candidateType: "qualifying_question", content: "pergunte sobre o consumo médio mensal (kWh)" };
      },
    };
    const mining = new CurationMiningService(curation, fakeExtractor);
    // tenant com uma conversa convertida
    const [t] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('MT', ${"mt-" + randomUUID()}) RETURNING id`;
    const tenantId = t!.id;
    const convId = await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const [c] = await tx<{ id: string }[]>`INSERT INTO contacts (tenant_id, wa_id) VALUES (${tenantId}, ${"wa-" + randomUUID()}) RETURNING id`;
      const [cv] = await tx<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, conversation_key) VALUES (${tenantId}, ${c!.id}, ${"ck-" + randomUUID()}) RETURNING id`;
      await tx`INSERT INTO messages (tenant_id, conversation_id, direction, type, content, status) VALUES (${tenantId}, ${cv!.id}, 'inbound', 'text', ${'{"text":"quero economizar na conta de luz"}'}::jsonb, 'received')`;
      await tx`INSERT INTO lead_profiles (tenant_id, conversation_id, status, stage) VALUES (${tenantId}, ${cv!.id}, 'qualified', 'qualified')`;
      return cv!.id;
    });
    await runWithTenant({ tenantId }, () => assignTenantNiche(nicheId)); // tenant PERTENCE ao nicho

    const r = await mining.mineTenant(nicheId, tenantId);
    expect(r.created).toBe(1);
    // o candidato existe como PENDING (revisão humana), não promovido
    const pend = await withCuration(nicheId, (tx) =>
      tx.select().from(schema.curationCandidates).where(eq(schema.curationCandidates.status, "pending")),
    );
    const mined = pend.find((c) => c.sourceTenantId === tenantId);
    expect(mined).toBeDefined();
    expect(mined!.status).toBe("pending"); // mineração NÃO auto-promove
    void convId;
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
  });

  it("GUARDA cross-nicho: minerar tenant que NÃO pertence ao nicho lança", async () => {
    const fakeExtractor: InsightExtractor = { async extract() { return null; } };
    const mining = new CurationMiningService(curation, fakeExtractor);
    const [t] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('MX', ${"mx-" + randomUUID()}) RETURNING id`;
    // t SEM nicho atribuído (ou de outro nicho) → mineração para este nicho deve falhar
    await expect(mining.mineTenant(nicheId, t!.id)).rejects.toThrow(/não pertence ao nicho/i);
    await mig.sql`DELETE FROM tenants WHERE id = ${t!.id}`;
  });
});
