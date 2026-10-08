import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient } from "./client";
import {
  getConversationHistory,
  recordInboundMessage,
  setInboundTranscription,
} from "./conversations";
import {
  getTranscriptionByMedia,
  insertMediaObject,
  saveTranscription,
} from "./media";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("M12 — cache de transcrição (db)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('A', ${"a-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('B', ${"b-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  async function seedAudio(tenantId: string, mediaId: string) {
    return runWithTenant({ tenantId }, async () => {
      const rec = await recordInboundMessage({
        conversationKey: `cloud_api:pn:${randomUUID().slice(0, 6)}`,
        waId: "5511" + randomUUID().slice(0, 6),
        externalMessageId: "wamid." + randomUUID(),
        type: "media",
        content: { mediaType: "audio", mediaId },
      });
      const media = await insertMediaObject({
        messageId: rec.messageId,
        providerMediaId: mediaId,
        mimeType: "audio/ogg",
      });
      return media.id;
    });
  }

  it("sem transcrição persistida → cache miss (null)", async () => {
    const mediaId = "MID_" + randomUUID().slice(0, 8);
    await seedAudio(tenantA, mediaId);
    const cached = await runWithTenant({ tenantId: tenantA }, () => getTranscriptionByMedia(mediaId));
    expect(cached).toBeNull();
  });

  it("após saveTranscription → cache hit com texto e segundos (idempotência)", async () => {
    const mediaId = "MID_" + randomUUID().slice(0, 8);
    const mediaObjectId = await seedAudio(tenantA, mediaId);
    await runWithTenant({ tenantId: tenantA }, () =>
      saveTranscription(mediaObjectId, "bom dia, quero um orçamento", 5, new Date()),
    );
    const cached = await runWithTenant({ tenantId: tenantA }, () => getTranscriptionByMedia(mediaId));
    expect(cached).toEqual({ text: "bom dia, quero um orçamento", seconds: 5 });
  });

  it("RLS: tenant B não enxerga a transcrição do tenant A", async () => {
    const mediaId = "MID_" + randomUUID().slice(0, 8);
    const mediaObjectId = await seedAudio(tenantA, mediaId);
    await runWithTenant({ tenantId: tenantA }, () =>
      saveTranscription(mediaObjectId, "segredo do A", 3, new Date()),
    );
    const fromB = await runWithTenant({ tenantId: tenantB }, () => getTranscriptionByMedia(mediaId));
    expect(fromB).toBeNull();
  });

  it("setInboundTranscription injeta o texto no content → histórico passa a VER o áudio", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const rec = await recordInboundMessage({
        conversationKey: `cloud_api:pn:${randomUUID().slice(0, 6)}`,
        waId: "5511" + randomUUID().slice(0, 6),
        externalMessageId: "wamid." + randomUUID(),
        type: "media",
        content: { mediaType: "audio", mediaId: "AUDHIST_" + randomUUID().slice(0, 6) },
      });
      // Antes: o histórico não tem texto para a mensagem de áudio.
      const before = await getConversationHistory(rec.conversationId, 30);
      expect(before.find((h) => h.content.text)).toBeUndefined();

      await setInboundTranscription(rec.messageId, "quero agendar uma visita amanhã");

      // Depois: o content ganhou o texto transcrito (+ marcador), preservando a mídia.
      const after = await getConversationHistory(rec.conversationId, 30);
      const audio = after.find((h) => h.content.mediaType === "audio");
      expect(audio?.content.text).toBe("quero agendar uma visita amanhã");
      expect(audio?.content.transcribed).toBe(true);
      expect(audio?.content.mediaType).toBe("audio"); // não perde a origem
    });
  });
});
