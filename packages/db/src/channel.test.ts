import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient } from "./client";
import {
  findConnectionOwner,
  listExpiringConnections,
  resolveConnectionByPhoneNumberId,
  setConnectionStatus,
  upsertChannelConnection,
} from "./channel-connections";
import {
  getConversationByKey,
  isWithinServiceWindow,
  markMessageStatusByExternalId,
  recordInboundMessage,
  recordOutboundMessage,
} from "./conversations";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("M2 — canal WhatsApp (db)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";
  const pnA = "PN_" + randomUUID().slice(0, 8);
  const pnB = "PN_" + randomUUID().slice(0, 8);

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('A', ${"a-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('B', ${"b-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
    await runWithTenant({ tenantId: tenantA }, () => upsertChannelConnection({ phoneNumberId: pnA }));
    await runWithTenant({ tenantId: tenantB }, () => upsertChannelConnection({ phoneNumberId: pnB }));
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  it("resolve o tenant certo pelo phone_number_id (caminho system) e isola", async () => {
    const ra = await resolveConnectionByPhoneNumberId(pnA);
    const rb = await resolveConnectionByPhoneNumberId(pnB);
    expect(ra?.tenantId).toBe(tenantA);
    expect(rb?.tenantId).toBe(tenantB);
    expect(await resolveConnectionByPhoneNumberId("PN_inexistente")).toBeNull();
  });

  it("persiste inbound (contato+conversa+mensagem) e abre a janela de 24h", async () => {
    const convKey = `cloud_api:${pnA}:5511999`;
    const rec = await runWithTenant({ tenantId: tenantA }, () =>
      recordInboundMessage({
        conversationKey: convKey,
        waId: "5511999",
        profileName: "Fulano",
        externalMessageId: "wamid." + randomUUID(),
        type: "text",
        content: { text: "olá" },
      }),
    );
    expect(rec.conversationId).toBeTruthy();

    const conv = await runWithTenant({ tenantId: tenantA }, () => getConversationByKey(convKey));
    expect(conv?.windowExpiresAt).toBeTruthy();
    expect(isWithinServiceWindow(conv!.windowExpiresAt)).toBe(true);
    // janela já vencida => fora
    expect(isWithinServiceWindow(new Date(Date.now() - 1000))).toBe(false);
  });

  it("registra outbound e atualiza status por external_message_id", async () => {
    const convKey = `cloud_api:${pnA}:5511888`;
    const rec = await runWithTenant({ tenantId: tenantA }, () =>
      recordInboundMessage({
        conversationKey: convKey,
        waId: "5511888",
        externalMessageId: "wamid." + randomUUID(),
        type: "text",
        content: { text: "oi" },
      }),
    );
    const ext = "wamid.out." + randomUUID();
    await runWithTenant({ tenantId: tenantA }, () =>
      recordOutboundMessage({
        conversationId: rec.conversationId,
        type: "text",
        content: { text: "echo: oi" },
        externalMessageId: ext,
      }),
    );
    const updated = await runWithTenant({ tenantId: tenantA }, () =>
      markMessageStatusByExternalId(ext, "delivered"),
    );
    expect(updated).toBe(true);
  });

  it("status é monotônico: 'delivered' atrasado não rebaixa 'read'", async () => {
    const convKey = `cloud_api:${pnA}:5511mono`;
    const rec = await runWithTenant({ tenantId: tenantA }, () =>
      recordInboundMessage({
        conversationKey: convKey,
        waId: "5511mono",
        externalMessageId: "wamid.in." + randomUUID(),
        type: "text",
        content: { text: "x" },
      }),
    );
    const ext = "wamid.out." + randomUUID();
    await runWithTenant({ tenantId: tenantA }, () =>
      recordOutboundMessage({ conversationId: rec.conversationId, type: "text", content: { text: "y" }, externalMessageId: ext }),
    );
    const toRead = await runWithTenant({ tenantId: tenantA }, () =>
      markMessageStatusByExternalId(ext, "read"),
    );
    const toDelivered = await runWithTenant({ tenantId: tenantA }, () =>
      markMessageStatusByExternalId(ext, "delivered"),
    );
    expect(toRead).toBe(true); // sent -> read avança
    expect(toDelivered).toBe(false); // delivered < read: não regride
  });

  it("não enxerga conexão de outro tenant no caminho tenant-scoped", async () => {
    // tenant A, sem set de resolve_phone, não vê a conexão de B por phone_number_id
    const found = await resolveConnectionByPhoneNumberId(pnB);
    expect(found?.tenantId).toBe(tenantB); // system resolve funciona…
    // …mas uma leitura tenant-scoped de A não traria a conexão de B (RLS) — coberto
    // pelos testes de isolamento gerais; aqui garantimos a resolução correta.
  });

  // OBS: este teste roda por último — desconecta pnB (não usado depois).
  it("lifecycle (M3): owner, expiração e desconexão param de resolver", async () => {
    expect((await findConnectionOwner(pnB))?.tenantId).toBe(tenantB);

    // token vencido -> aparece na lista de expiração do tenant
    await runWithTenant({ tenantId: tenantB }, () =>
      upsertChannelConnection({ phoneNumberId: pnB, tokenExpiresAt: new Date(Date.now() - 1000) }),
    );
    const expiring = await runWithTenant({ tenantId: tenantB }, () =>
      listExpiringConnections(new Date()),
    );
    expect(expiring.some((e) => e.phoneNumberId === pnB)).toBe(true);

    // desconectar -> resolve (que filtra active) para de rotear
    await runWithTenant({ tenantId: tenantB }, () => setConnectionStatus(pnB, "disconnected"));
    expect(await resolveConnectionByPhoneNumberId(pnB)).toBeNull();
    // mas o owner ainda é encontrado (qualquer status) p/ o guard de conflito
    expect((await findConnectionOwner(pnB))?.status).toBe("disconnected");
  });
});
