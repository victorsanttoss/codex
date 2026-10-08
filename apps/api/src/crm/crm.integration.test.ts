import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, getCrmSync, makeMigrationClient, schema, withTenant } from "@sdr/db";
import { CrmService } from "./crm.service";
import { CrmConfigService } from "./crm-config.service";
import { CrmSyncService } from "./crm-sync.service";
import { LeadOutcomeService } from "./lead-outcome.service";
import { crmRegistryProvider } from "./crm.registry";
import type { CrmSyncQueue } from "./crm-sync.queue";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const registry = crmRegistryProvider.useFactory();

describe.skipIf(!dbConfigured)("M7 — CRM sync + desfecho (integração ao vivo)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId = "";
  let conversationId = "";
  let sync: CrmSyncService;

  async function seedConversation(): Promise<string> {
    return mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO contacts (tenant_id, wa_id) VALUES (${tenantId}, ${"wa-" + randomUUID()}) RETURNING id`;
      const [conv] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, contact_id, conversation_key)
        VALUES (${tenantId}, ${c!.id}, ${"ck-" + randomUUID()}) RETURNING id`;
      return conv!.id;
    }) as Promise<string>;
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('CRMI', ${"crmi-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
    conversationId = await seedConversation();
    const config = new CrmConfigService();
    sync = new CrmSyncService(new CrmService(registry, config), config);
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await closeDb();
  });

  it("sync (builtin) cria contato+oportunidade e é IDEMPOTENTE no retry/re-handoff", async () => {
    const p = {
      conversationId,
      phone: "55 11 98765-4321", // formatado → normaliza para E.164 canônico
      name: "Ana",
      fields: { necessidade: "CRM", orcamento: 5000 },
      stage: "qualified",
      status: "qualified",
      score: 80,
    };
    await runWithTenant({ tenantId }, () => sync.sync(p));
    await runWithTenant({ tenantId }, () => sync.sync(p)); // retry / novo handoff do mesmo lead

    const contacts = await runWithTenant({ tenantId }, () =>
      withTenant((tx) => tx.select().from(schema.crmContacts)),
    );
    const opps = await runWithTenant({ tenantId }, () =>
      withTenant((tx) => tx.select().from(schema.opportunities)),
    );
    expect(contacts.filter((c) => c.phone === "+5511987654321")).toHaveLength(1); // normalizado + não duplicou
    expect(opps).toHaveLength(1);
    expect(await runWithTenant({ tenantId }, () => getCrmSync(conversationId))).toMatchObject({
      status: "synced",
      crmAdapter: "builtin",
    });
  });

  it("RE-SYNC: lead já 'synced' com payload NOVO atualiza o CRM (sem duplicar nada)", async () => {
    const conv3 = await seedConversation();
    const phone = "+5511977776666";
    const first = {
      conversationId: conv3,
      phone,
      name: "Bia",
      fields: { necessidade: "CRM" },
      stage: "qualified",
      status: "qualified",
      score: 60,
    };
    await runWithTenant({ tenantId }, () => sync.sync(first));
    expect((await runWithTenant({ tenantId }, () => getCrmSync(conv3)))?.status).toBe("synced");

    // O lead ganhou campos/score novos DEPOIS de sincronizado (jobId com hash de
    // payload deixa o job passar; o serviço não pode mais curto-circuitar).
    await runWithTenant({ tenantId }, () =>
      sync.sync({ ...first, status: "handoff", stage: "handoff", score: 95, fields: { necessidade: "CRM", orcamento: 9000 } }),
    );

    const contacts = await runWithTenant({ tenantId }, () =>
      withTenant((tx) => tx.select().from(schema.crmContacts)),
    );
    const opps = await runWithTenant({ tenantId }, () =>
      withTenant((tx) => tx.select().from(schema.opportunities)),
    );
    const mineContacts = contacts.filter((c) => c.phone === phone);
    expect(mineContacts).toHaveLength(1); // update idempotente pela chave canônica (ADR 0026)
    expect(mineContacts[0]!.fields).toMatchObject({ necessidade: "CRM", orcamento: 9000 }); // campos novos chegaram
    const mineOpps = opps.filter((o) => o.contactId === mineContacts[0]!.id);
    expect(mineOpps).toHaveLength(1); // não duplicou o deal
    expect(mineOpps[0]!.stage).toBe("handoff"); // ...e ele foi ATUALIZADO
    expect(mineOpps[0]!.score).toBe(95);

    // atividade de sync só na 1ª vez (re-sync não spamma o histórico do CRM)
    const acts = await runWithTenant({ tenantId }, () =>
      withTenant((tx) => tx.select().from(schema.activities)),
    );
    expect(acts.filter((a) => a.contactId === mineContacts[0]!.id && a.kind === "sync")).toHaveLength(1);
  });

  it("onTurnEnd: handoff registra agendamento + notificação (idempotentes) e enfileira sync", async () => {
    const enqueued: unknown[] = [];
    const fakeQueue = { async enqueueSync(j: unknown) { enqueued.push(j); } } as unknown as CrmSyncQueue;
    const outcome = new LeadOutcomeService(new CrmService(registry, new CrmConfigService()), fakeQueue);

    const conv2 = await seedConversation();
    const turn = {
      conversationId: conv2,
      phone: "+5511444",
      fields: { necessidade: "x" },
      stage: "handoff",
      status: "handoff",
      score: 50,
      handoff: true,
      handoffReason: "lead quente",
      scheduling: { when: "amanhã 14h", details: "demo do produto" },
    };
    await runWithTenant({ tenantId }, () => outcome.onTurnEnd(turn));
    await runWithTenant({ tenantId }, () => outcome.onTurnEnd(turn)); // chamada repetida → idempotente

    expect(enqueued.length).toBe(2); // enfileira nas duas; a dedup real é no provider/worker
    const notifs = await runWithTenant({ tenantId }, () =>
      withTenant((tx) => tx.select().from(schema.notifications)),
    );
    expect(notifs.filter((n) => n.idempotencyKey === `${conv2}:handoff`)).toHaveLength(1); // 1×
    const appts = await runWithTenant({ tenantId }, () =>
      withTenant((tx) => tx.select().from(schema.appointments)),
    );
    expect(appts.filter((a) => a.conversationId === conv2)).toHaveLength(1); // agendamento único
  });
});
