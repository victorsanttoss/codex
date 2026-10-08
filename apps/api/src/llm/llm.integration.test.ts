import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@sdr/config";
import {
  ProviderRegistry,
  runWithTenant,
  type CompletionRequest,
  type CompletionResult,
  type LLMProvider,
} from "@sdr/core";
import { closeDb, makeMigrationClient } from "@sdr/db";
import { LlmService } from "./llm.service";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

/** Provedor fake (sem rede): usa 1000 in / 500 out tokens. */
function fakeProvider(): LLMProvider {
  return {
    id: "anthropic",
    async complete(_req: CompletionRequest): Promise<CompletionResult> {
      return { content: "oi", toolCalls: [], usage: { tokensIn: 1000, tokensOut: 500 }, finishReason: "stop" };
    },
    async *stream() {
      yield { type: "done" as const, usage: { tokensIn: 0, tokensOut: 0 }, finishReason: "stop" as const };
    },
  };
}

describe.skipIf(!dbConfigured)("M4 — LlmService (integração ao vivo)", () => {
  const cfg = loadConfig();
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId = "";
  let svc: LlmService;

  function asTenant<T>(fn: (tx: typeof mig.sql) => Promise<T>): Promise<T> {
    return mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as typeof mig.sql);
    }) as Promise<T>;
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('LLM', ${"llm-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
    // registry com factory FAKE p/ anthropic (sem rede real)
    const registry = new ProviderRegistry();
    registry.registerLLM("anthropic", () => fakeProvider());
    registry.registerLLM("openai_compat", () => fakeProvider());
    svc = new LlmService(registry, cfg);
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await closeDb();
  });

  it("roteia (mais barato), completa e grava recordUsage com costMicros", async () => {
    const out = await runWithTenant({ tenantId }, () =>
      svc.complete({ messages: [{ role: "user", content: "olá" }] }),
    );
    // cadeia default: haiku é o mais barato -> escolhido
    expect(out.model).toBe("claude-haiku-4-5");
    expect(out.costMicros).toBe(1000 * 1 + 500 * 5); // 3500 micros

    // metering é fire-and-forget (fora do caminho crítico) → poll até a linha aparecer.
    const deadline = Date.now() + 2_000;
    let rows: { type: string; model: string | null; cost_micros: number | null }[] = [];
    while (Date.now() < deadline && rows.length === 0) {
      rows = await asTenant(
        (tx) => tx<{ type: string; model: string | null; cost_micros: number | null }[]>`
          SELECT type, model, cost_micros::int AS cost_micros FROM usage_events WHERE type = 'llm_call'`,
      );
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ type: "llm_call", model: "claude-haiku-4-5", cost_micros: 3500 });
  });
});
