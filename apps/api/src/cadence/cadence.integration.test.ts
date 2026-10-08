import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import {
  applyLeadDecision,
  armCadence,
  claimDueOutbox,
  closeDb,
  getCadenceState,
  getOrCreateLeadProfile,
  makeMigrationClient,
  enqueueOutbox,
  markContactOptedOut,
  markOutboxSent,
  putAgentConfig,
  schema,
  setHumanTakeover,
  upsertMessageTemplate,
  withTenant,
} from "@sdr/db";
import { CadenceService } from "./cadence.service";
import { CadenceConfigService } from "./cadence-config.service";
import { TemplateService } from "./template.service";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

const ALL_DAY = { startHour: 0, endHour: 24, days: [0, 1, 2, 3, 4, 5, 6] };
const STEP = { delayMinutes: 5, templateName: "followup_1", languageCode: "pt_BR" };

describe.skipIf(!dbConfigured)("M8 — cadência: guardrails de compliance (ao vivo)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId = "";
  let waId = "";
  let convId = "";
  const cadence = new CadenceService(new CadenceConfigService(), new TemplateService());

  async function seedConv(): Promise<{ conv: string; wa: string }> {
    const wa = "wa-" + randomUUID();
    const conv = await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO contacts (tenant_id, wa_id, phone) VALUES (${tenantId}, ${wa}, '+5511999') RETURNING id`;
      const [cv] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, contact_id, conversation_key)
        VALUES (${tenantId}, ${c!.id}, ${"ck-" + randomUUID()}) RETURNING id`;
      return cv!.id;
    });
    return { conv: conv as string, wa };
  }

  async function setCadence(over: Record<string, unknown> = {}) {
    await runWithTenant({ tenantId }, () =>
      putAgentConfig({
        cadence: { enabled: true, steps: [STEP], businessHours: ALL_DAY, frequencyCap: 5, ...over },
      }),
    );
  }

  async function outboxRows() {
    return runWithTenant({ tenantId }, () => withTenant((tx) => tx.select().from(schema.outboxMessages)));
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('CAD', ${"cad-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
    await runWithTenant({ tenantId }, () => upsertMessageTemplate({ name: "followup_1", languageCode: "pt_BR" }));
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await closeDb();
  });

  beforeEach(async () => {
    const s = await seedConv();
    convId = s.conv;
    waId = s.wa;
  });

  /** Arma o passo 0 já VENCIDO (next_step_at no passado) p/ o scan pegar. */
  async function armDue() {
    await runWithTenant({ tenantId }, () => armCadence(convId, 0, new Date(Date.now() - 1000)));
  }

  it("happy path: dispara o template no outbox (idempotente por passo)", async () => {
    await setCadence();
    await armDue();
    const n = await runWithTenant({ tenantId }, () => cadence.scanAndDispatch());
    expect(n).toBe(1);
    const rows = (await outboxRows()).filter((r) => r.conversationId === convId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("template");
    expect(rows[0]!.billing).toBe("template");
    // re-scan não duplica (idempotency_key cadence:conv:step)
    await armDue();
    await runWithTenant({ tenantId }, () => cadence.scanAndDispatch());
    expect((await outboxRows()).filter((r) => r.conversationId === convId)).toHaveLength(1);
  });

  it("GUARDRAIL opt-out: contato opted-out → não dispara, cadência parada", async () => {
    await setCadence();
    await runWithTenant({ tenantId }, () => markContactOptedOut(waId));
    await armDue();
    expect(await runWithTenant({ tenantId }, () => cadence.scanAndDispatch())).toBe(0);
    expect((await runWithTenant({ tenantId }, () => getCadenceState(convId)))?.status).toBe("stopped");
  });

  it("GUARDRAIL takeover humano: humano assumiu → para, não dispara follow-up", async () => {
    await setCadence();
    await runWithTenant({ tenantId }, () => setHumanTakeover(convId, true));
    await armDue();
    expect(await runWithTenant({ tenantId }, () => cadence.scanAndDispatch())).toBe(0);
    expect((await runWithTenant({ tenantId }, () => getCadenceState(convId)))?.status).toBe("stopped");
    expect((await outboxRows()).filter((r) => r.conversationId === convId)).toHaveLength(0);
  });

  it("RECUPERAÇÃO: enqueue idempotente (created=false) ainda AVANÇA o passo (cadência não congela)", async () => {
    await setCadence();
    await armDue();
    // Simula o scheduler que MORREU entre o enqueueOutbox e o avanço do passo:
    // o outbox do passo 0 já existe com a idempotency_key canônica.
    const key = `cadence:${convId}:0`;
    await runWithTenant({ tenantId }, () =>
      enqueueOutbox({
        conversationId: convId,
        toPhone: "+5511999",
        kind: "template",
        payload: { templateName: "followup_1", languageCode: "pt_BR" },
        idempotencyKey: key,
        clientMessageId: key,
        billing: "template",
      }),
    );
    // O scan encontra a cadência vencida; o enqueue devolve created=false, mas o
    // passo avança mesmo assim (1 passo só → completa). dispatched = 0 (não criou).
    expect(await runWithTenant({ tenantId }, () => cadence.scanAndDispatch())).toBe(0);
    expect((await runWithTenant({ tenantId }, () => getCadenceState(convId)))?.status).toBe("completed");
    // sem duplicata no outbox (envio único garantido pela idempotency_key).
    expect((await outboxRows()).filter((r) => r.conversationId === convId)).toHaveLength(1);
  });

  it("GUARDRAIL resolvido: lead qualified → para, não dispara", async () => {
    await setCadence();
    await runWithTenant({ tenantId }, async () => {
      await getOrCreateLeadProfile(convId);
      await applyLeadDecision(convId, { status: "qualified", stage: "qualified" });
    });
    await armDue();
    expect(await runWithTenant({ tenantId }, () => cadence.scanAndDispatch())).toBe(0);
    expect((await runWithTenant({ tenantId }, () => getCadenceState(convId)))?.status).toBe("stopped");
  });

  it("GUARDRAIL horário comercial: fora da janela → ADIA (continua ativa, não dispara)", async () => {
    await setCadence({ businessHours: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] } });
    await armDue();
    const madrugada = new Date("2026-06-17T06:00:00Z"); // 03:00 BRT
    expect(await runWithTenant({ tenantId }, () => cadence.scanAndDispatch(madrugada))).toBe(0);
    expect((await runWithTenant({ tenantId }, () => getCadenceState(convId)))?.status).toBe("active"); // não parou
    expect((await outboxRows()).filter((r) => r.conversationId === convId)).toHaveLength(0);
  });

  it("GUARDRAIL teto de frequência: já enviou no período → ADIA", async () => {
    await setCadence({ frequencyCap: 1 });
    // simula 1 envio recente ao mesmo telefone
    await runWithTenant({ tenantId }, async () => {
      const { outboxId } = await import("@sdr/db").then((m) =>
        m.enqueueOutbox({
          toPhone: "+5511999",
          kind: "template",
          payload: {},
          idempotencyKey: "prev-" + randomUUID(),
          clientMessageId: "prev",
          billing: "template",
        }),
      );
      await claimDueOutbox(10);
      await markOutboxSent(outboxId, "ext-prev-" + randomUUID());
    });
    await armDue();
    expect(await runWithTenant({ tenantId }, () => cadence.scanAndDispatch())).toBe(0);
    expect((await outboxRows()).filter((r) => r.conversationId === convId)).toHaveLength(0);
  });

  it("GUARDRAIL template não aprovado: para a cadência", async () => {
    await setCadence({ steps: [{ delayMinutes: 5, templateName: "inexistente", languageCode: "pt_BR" }] });
    await armDue();
    expect(await runWithTenant({ tenantId }, () => cadence.scanAndDispatch())).toBe(0);
    expect((await runWithTenant({ tenantId }, () => getCadenceState(convId)))?.status).toBe("stopped");
  });

  it("desabilitado (default opt-in): scan não faz nada", async () => {
    await runWithTenant({ tenantId }, () => putAgentConfig({}));
    await armDue();
    expect(await runWithTenant({ tenantId }, () => cadence.scanAndDispatch())).toBe(0);
  });
});
