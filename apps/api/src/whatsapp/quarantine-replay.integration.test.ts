import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { loadConfig } from "@sdr/config";
import { ProviderRegistry, runWithTenant, type InboundWebhookRequest } from "@sdr/core";
import {
  closeDb,
  makeCipherFromEnv,
  makeMigrationClient,
  quarantineInbound,
  setConnectionStatus,
  TenantSecretsStore,
  upsertChannelConnection,
} from "@sdr/db";
import { signMetaBody, type HttpClient } from "@sdr/whatsapp-cloud";
import { ChannelFactory } from "./channel-factory.service";
import { MediaService } from "./media.service";
import { EchoMessageHandler } from "./message-handler";
import { InboundCoreService } from "./inbound-core.service";
import { InboundPipelineService } from "./inbound-pipeline.service";
import { QuarantineReplayService } from "./quarantine-replay.service";
import type { WebhookQueue, WebhookJob } from "./webhook.queue";
import { OutboxService } from "../outbox/outbox.service";
import { SerializedRunner } from "../queue/serialized-runner";
import { TranscriptionService } from "../transcription/transcription.service";
import { AudioEnrichmentService } from "../transcription/audio-enrichment.service";

/**
 * Integração da QUARENTENA de inbound (0032): mensagem para conexão
 * `disconnected` NÃO é descartada — vai para a quarentena; quando a conexão
 * volta a `active`, o sweep re-enfileira o payload e a pipeline processa.
 */
const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

function makeMockHttp() {
  const sent: Array<{ url: string; body: unknown }> = [];
  const http: HttpClient = {
    async post(url, opts) {
      sent.push({ url, body: JSON.parse(opts.body) });
      return resp(200, { messages: [{ id: "wamid.SENT." + sent.length }] });
    },
    async get() {
      return resp(200, {});
    },
  };
  return { http, sent };
}
function resp(status: number, body: unknown) {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe.skipIf(!dbConfigured)("0032 — quarentena de inbound (integração)", () => {
  const cfg = loadConfig();
  const pnid = "PN_" + randomUUID().slice(0, 8);
  let mig: ReturnType<typeof makeMigrationClient>;
  let redis: Redis;
  let tenantId = "";
  let pipeline: InboundPipelineService;
  let sweeper: QuarantineReplayService;
  let mock: ReturnType<typeof makeMockHttp>;

  function asTenant<T>(fn: (tx: typeof mig.sql) => Promise<T>): Promise<T> {
    return mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as typeof mig.sql);
    }) as Promise<T>;
  }

  function signedInbound(message: Record<string, unknown>): InboundWebhookRequest {
    const withTs = { ...message, timestamp: String(Math.floor(Date.now() / 1000)) };
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: "+5511", phone_number_id: pnid },
                contacts: [{ profile: { name: "Lead" }, wa_id: "5511999" }],
                messages: [withTs],
              },
            },
          ],
        },
      ],
    });
    return {
      headers: { "x-hub-signature-256": signMetaBody(body, cfg.whatsapp.appSecret!) },
      query: {},
      rawBody: body,
    };
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('QUAR', ${"quar-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
    await runWithTenant({ tenantId }, async () => {
      await new TenantSecretsStore(makeCipherFromEnv()).put("whatsapp_token", "tenant-token-xyz");
      // Conexão registrada mas FORA do ar (ex.: token 401 marcou disconnected).
      await upsertChannelConnection({ phoneNumberId: pnid, displayPhone: "+5511", status: "disconnected" });
    });
    redis = new Redis(cfg.redis.url, { maxRetriesPerRequest: null });
    mock = makeMockHttp();
    const channels = new ChannelFactory(cfg, mock.http);
    const media = new MediaService(cfg, mock.http);
    const audio = new AudioEnrichmentService(cfg, new TranscriptionService(new ProviderRegistry(), cfg));
    const core = new InboundCoreService(media, audio, new SerializedRunner(redis), new EchoMessageHandler());
    pipeline = new InboundPipelineService(channels, core, new OutboxService(channels));
    // Fila FAKE: o enqueue processa direto pela pipeline (sem BullMQ no teste).
    const fakeQueue = {
      enqueue: async (job: WebhookJob) => {
        await pipeline.process(job);
      },
    } as unknown as WebhookQueue;
    sweeper = new QuarantineReplayService(cfg, fakeQueue);
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await redis.quit();
    await closeDb();
  });

  it("conexão disconnected: mensagem vai para a QUARENTENA (não é descartada nem ecoa)", async () => {
    const ext = "wamid.Q1." + randomUUID();
    await pipeline.process(
      signedInbound({ from: "5511999", id: ext, type: "text", text: { body: "tem vaga?" } }),
    );
    expect(mock.sent).toHaveLength(0); // nada enviado (conexão fora do ar)
    const rows = await asTenant(
      (tx) => tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM inbound_quarantine
        WHERE phone_number_id = ${pnid} AND replayed_at IS NULL`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("conexão volta a active: sweep re-enfileira, pipeline processa e marca replayed_at", async () => {
    await runWithTenant({ tenantId }, () => setConnectionStatus(pnid, "active"));
    const res = await sweeper.sweep();
    expect(res.replayed).toBeGreaterThanOrEqual(1);
    // a mensagem quarentenada foi processada de verdade (echo enviado)
    const echo = mock.sent.find((s) => JSON.stringify(s.body).includes("echo: tem vaga?"));
    expect(echo).toBeTruthy();
    const pending = await asTenant(
      (tx) => tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM inbound_quarantine
        WHERE phone_number_id = ${pnid} AND replayed_at IS NULL`,
    );
    expect(pending[0]!.n).toBe(0);
    // 2º sweep: nada novo (replayed marcado) e o dedup protegeria um replay duplo
    const before = mock.sent.length;
    const again = await sweeper.sweep();
    expect(again.replayed).toBe(0);
    expect(mock.sent.length).toBe(before);
  });

  it("linhas expiradas são apagadas pelo sweep (sem replay)", async () => {
    const id = await quarantineInbound({
      tenantId,
      phoneNumberId: pnid,
      payload: { headers: {}, query: {}, rawBody: "{}" },
      expiresAt: new Date(Date.now() - 1_000),
    });
    const before = mock.sent.length;
    const res = await sweeper.sweep();
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect(mock.sent.length).toBe(before); // expirada NÃO re-enfileira
    const rows = await asTenant(
      (tx) => tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM inbound_quarantine WHERE id = ${id}`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});
