import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient, withTenant } from "./client";
import {
  getConversationByKey,
  getConversationHistory,
  isWithinServiceWindow,
  recordInboundMessage,
  recordOutboundMessage,
  SERVICE_WINDOW_MS,
  setInboundTranscription,
} from "./conversations";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("inbound retries (real PostgreSQL)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA: string;
  let tenantB: string;

  function scoped<T>(fn: () => Promise<T>, tenantId = tenantA) {
    return runWithTenant({ tenantId }, fn);
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('Retry A', ${randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('Retry B', ${randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  it("an old retry reuses the message and preserves the newer contact clock and service window", async () => {
    const now = new Date();
    const oldAt = new Date(now.getTime() - 25 * 60 * 60_000);
    const newAt = new Date(now.getTime() - 60_000);
    const waId = randomUUID();
    const conversationKey = `cloud_api:retry:${waId}`;
    const oldInput = {
      conversationKey, waId, externalMessageId: randomUUID(), type: "media",
      content: { mediaType: "audio", mediaId: randomUUID() }, receivedAt: oldAt,
    };

    await scoped(async () => {
      const first = await recordInboundMessage(oldInput);
      await setInboundTranscription(first.messageId, "Quero visitar o imóvel amanhã.");
      await recordInboundMessage({
        conversationKey, waId, externalMessageId: randomUUID(), type: "text",
        content: { text: "Pode ser de manhã?" }, receivedAt: newAt,
      });
      expect(await recordInboundMessage(oldInput)).toEqual(first);

      const conversation = await getConversationByKey(conversationKey);
      expect(conversation?.windowExpiresAt?.getTime()).toBe(newAt.getTime() + SERVICE_WINDOW_MS);
      expect(isWithinServiceWindow(conversation?.windowExpiresAt, now)).toBe(true);
      const clocks = await withTenant(async (tx) => tx.execute(sql`
        SELECT cv.last_inbound_at, ct.last_seen_at
        FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
        WHERE cv.id = ${first.conversationId}
      `));
      expect(new Date(clocks[0]?.last_inbound_at as string).getTime()).toBe(newAt.getTime());
      expect(new Date(clocks[0]?.last_seen_at as string).getTime()).toBe(newAt.getTime());
      const history = await getConversationHistory(first.conversationId);
      expect(history).toHaveLength(2);
      expect(history[0]?.content).toMatchObject({
        text: "Quero visitar o imóvel amanhã.", transcribed: true, mediaId: oldInput.content.mediaId,
      });
    });
  });

  it("concurrent re-deliveries create only one inbound record and return its stable identity", async () => {
    const waId = randomUUID();
    const input = {
      conversationKey: `cloud_api:concurrent:${waId}`, waId,
      externalMessageId: randomUUID(), type: "text", content: { text: "Olá" },
    };
    await scoped(async () => {
      const records = await Promise.all(Array.from({ length: 8 }, () => recordInboundMessage(input)));
      expect(new Set(records.map((r) => r.messageId)).size).toBe(1);
      expect(new Set(records.map((r) => r.conversationId)).size).toBe(1);
      expect(await getConversationHistory(records[0]!.conversationId)).toHaveLength(1);
    });
  });

  it("a duplicate external id cannot redirect an inbound to another conversation", async () => {
    const waId = randomUUID();
    const externalMessageId = randomUUID();
    const input = {
      conversationKey: `cloud_api:original:${waId}`, waId, externalMessageId,
      type: "text", content: { text: "Original" },
    };
    const otherWaId = randomUUID();
    const otherKey = `cloud_api:other:${otherWaId}`;
    await scoped(async () => {
      const original = await recordInboundMessage(input);
      await expect(recordInboundMessage({ ...input, conversationKey: otherKey, waId: otherWaId }))
        .rejects.toThrow("inbound_message_identity_conflict");
      expect(await getConversationByKey(otherKey)).toBeNull();
      expect(await getConversationHistory(original.conversationId)).toHaveLength(1);
    });
    // Provider identities remain tenant scoped, so the same id in B is valid.
    const b = await scoped(() => recordInboundMessage(input), tenantB);
    expect(await scoped(() => getConversationHistory(b.conversationId), tenantB)).toHaveLength(1);
  });

  it("an outbound external id is not silently accepted as an inbound retry", async () => {
    const waId = randomUUID();
    const input = {
      conversationKey: `cloud_api:direction:${waId}`, waId, externalMessageId: randomUUID(),
      type: "text", content: { text: "Entrada" },
    };
    await scoped(async () => {
      const original = await recordInboundMessage(input);
      const outboundId = randomUUID();
      await recordOutboundMessage({
        conversationId: original.conversationId, externalMessageId: outboundId,
        type: "text", content: { text: "Resposta" },
      });
      await expect(recordInboundMessage({ ...input, externalMessageId: outboundId }))
        .rejects.toThrow("inbound_message_identity_conflict");
      expect(await getConversationHistory(original.conversationId)).toHaveLength(2);
    });
  });
});
