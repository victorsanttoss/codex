import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { loadConfig } from "@sdr/config";
import {
  ProviderRegistry,
  runWithTenant,
  type InboundWebhookRequest,
  type TranscriptionInput,
  type TranscriptionProvider,
  type TranscriptionResult,
} from "@sdr/core";
import {
  closeDb,
  getConversationByKey,
  makeCipherFromEnv,
  makeMigrationClient,
  TenantSecretsStore,
  upsertChannelConnection,
} from "@sdr/db";
import { signMetaBody, type HttpClient } from "@sdr/whatsapp-cloud";
import { ChannelFactory } from "./channel-factory.service";
import { MediaService } from "./media.service";
import { EchoMessageHandler, type InboundMessageHandler } from "./message-handler";
import { InboundCoreService } from "./inbound-core.service";
import { InboundPipelineService, InboundProcessingError } from "./inbound-pipeline.service";
import { isLockContention } from "./webhook.queue";
import { OutboxService } from "../outbox/outbox.service";
import { SerializedRunner } from "../queue/serialized-runner";
import { TranscriptionService } from "../transcription/transcription.service";
import { AudioEnrichmentService } from "../transcription/audio-enrichment.service";

/** Provedor de transcrição FAKE p/ a integração — sem rede; ecoa um texto fixo. */
class FixedTranscriptionProvider implements TranscriptionProvider {
  readonly id = "fake-stt";
  constructor(private readonly text: string) {}
  async transcribe(_input: TranscriptionInput): Promise<TranscriptionResult> {
    return { text: this.text, usage: { seconds: 2 } };
  }
}

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

function makeMockHttp() {
  const sent: Array<{ url: string; body: unknown }> = [];
  const http: HttpClient = {
    async post(url, opts) {
      sent.push({ url, body: JSON.parse(opts.body) });
      return resp(200, { messages: [{ id: "wamid.SENT." + sent.length }] });
    },
    async get(url) {
      // URLs de download NÃO podem terminar em /MID1 /AUD1 (senão colidem com o
      // endpoint de metadados e o binário volta como metadados sem tamanho).
      if (url.endsWith("/MID1")) return resp(200, { url: "https://cdn/dl?MID1", mime_type: "image/jpeg" });
      if (url.endsWith("/AUD1")) return resp(200, { url: "https://cdn/dl?AUD1", mime_type: "audio/ogg" });
      return respBytes(new TextEncoder().encode("bytes-do-audio-ou-imagem").buffer);
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
function respBytes(buf: ArrayBuffer) {
  // Content-Length declarado: o guard anti-DoS da MediaService checa o tamanho
  // ANTES de materializar (mídia sem tamanho declarado é descartada).
  return {
    status: 200,
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => buf,
    header: (name: string) =>
      name.toLowerCase() === "content-length" ? String(buf.byteLength) : null,
  };
}

describe.skipIf(!dbConfigured)("M2 — pipeline inbound/outbound (integração ao vivo)", () => {
  const cfg = loadConfig();
  const pnid = "PN_" + randomUUID().slice(0, 8);
  let mig: ReturnType<typeof makeMigrationClient>;
  let redis: Redis;
  let tenantId = "";
  let pipeline: InboundPipelineService;
  let mock: ReturnType<typeof makeMockHttp>;
  let channels: ChannelFactory;
  let media: MediaService;
  let audio: AudioEnrichmentService;
  let runner: SerializedRunner;

  // Consulta tabelas tenant-scoped via migrator COM app.tenant_id setado — sob
  // FORCE RLS nem o owner vê linhas sem isso (o que é justamente o esperado).
  function asTenant<T>(fn: (tx: typeof mig.sql) => Promise<T>): Promise<T> {
    return mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as typeof mig.sql);
    }) as Promise<T>;
  }

  function signedInbound(message: Record<string, unknown>): InboundWebhookRequest {
    // timestamp ATUAL: a janela de 24h é calculada pelo horário da mensagem.
    const withTs = { ...message, timestamp: String(Math.floor(Date.now() / 1000)) };
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: "+5511", phone_number_id: pnid },
                contacts: [{ profile: { name: "Fulano" }, wa_id: "5511999" }],
                messages: [withTs],
              },
            },
          ],
        },
      ],
    });
    return { headers: { "x-hub-signature-256": signMetaBody(body, cfg.whatsapp.appSecret!) }, query: {}, rawBody: body };
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('WA', ${"wa-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
    await runWithTenant({ tenantId }, async () => {
      await new TenantSecretsStore(makeCipherFromEnv()).put("whatsapp_token", "tenant-token-xyz");
      await upsertChannelConnection({ phoneNumberId: pnid, displayPhone: "+5511" });
    });
    redis = new Redis(cfg.redis.url, { maxRetriesPerRequest: null });
    mock = makeMockHttp();
    channels = new ChannelFactory(cfg, mock.http);
    media = new MediaService(cfg, mock.http);
    runner = new SerializedRunner(redis);
    // STT fake injetado pelo registry → enriquecimento transcreve áudio p/ texto.
    const registry = new ProviderRegistry();
    registry.registerTranscription("openai_compat", () => new FixedTranscriptionProvider("quero um orçamento"));
    audio = new AudioEnrichmentService(cfg, new TranscriptionService(registry, cfg));
    const core = new InboundCoreService(media, audio, runner, new EchoMessageHandler());
    // OutboxService REAL: o reply reativo grava o ledger (linha 'sent') de verdade.
    pipeline = new InboundPipelineService(channels, core, new OutboxService(channels));
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await redis.quit();
    await closeDb();
  });

  it("texto: round-trip — persiste inbound, ecoa outbound dentro da janela", async () => {
    const ext = "wamid.IN." + randomUUID();
    await pipeline.process(
      signedInbound({ from: "5511999", id: ext, timestamp: "1700000000", type: "text", text: { body: "olá" } }),
    );
    // ecoou via Meta (mock)
    const echo = mock.sent.find((s) => JSON.stringify(s.body).includes("echo: olá"));
    expect(echo).toBeTruthy();
    // conversa criada
    const conv = await runWithTenant({ tenantId }, () =>
      getConversationByKey(`cloud_api:${pnid}:5511999`),
    );
    expect(conv).toBeTruthy();
    // 1 inbound + 1 outbound persistidos
    const rows = await asTenant((tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM messages`);
    expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it("dedup: reentregar o mesmo id não reprocessa (não ecoa de novo)", async () => {
    const ext = "wamid.DUP." + randomUUID();
    const before = mock.sent.length;
    const payload = signedInbound({ from: "5511888", id: ext, type: "text", text: { body: "oi" } });
    await pipeline.process(payload);
    await pipeline.process(payload); // reentrega
    const echoes = mock.sent.slice(before).filter((s) => JSON.stringify(s.body).includes("echo: oi"));
    expect(echoes).toHaveLength(1);
  });

  it("RETRY: falha do handler propaga (job falha) e o reprocesso responde — sem perda", async () => {
    // Handler que falha na 1ª chamada (DB hiccup/LLM/envio) e funciona na 2ª.
    let calls = 0;
    const flaky: InboundMessageHandler = {
      async handle(c) {
        calls++;
        if (calls === 1) throw new Error("hiccup transitório");
        await c.reply(`echo-retry: ${c.message.text}`);
      },
    };
    const core = new InboundCoreService(media, audio, runner, flaky);
    const p = new InboundPipelineService(channels, core, new OutboxService(channels));
    const ext = "wamid.RTY." + randomUUID();
    const payload = signedInbound({ from: "5511444", id: ext, type: "text", text: { body: "retry me" } });

    // 1ª entrega: o erro NÃO é engolido — propaga para o worker re-tentar.
    await expect(p.process(payload)).rejects.toBeInstanceOf(InboundProcessingError);
    // dedup pós-sucesso: a falha NÃO marcou a mensagem como processada.
    // 2ª entrega (retry do BullMQ): processa e responde.
    await p.process(payload);
    expect(calls).toBe(2);
    const echoes = mock.sent.filter((s) => JSON.stringify(s.body).includes("echo-retry: retry me"));
    expect(echoes).toHaveLength(1);
    // 3ª entrega: agora sim deduplicada (não ecoa de novo).
    await p.process(payload);
    expect(calls).toBe(2);
  });

  it("LOCK ocupado: falha retryável (contenção) em vez de descartar a 2ª mensagem", async () => {
    const from = "5511333";
    const key = `cloud_api:${pnid}:${from}`;
    // segura o FIFO da conversa por mais tempo que o waitMs curto do pipeline (2s)
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = runner.run(key, async () => gate, { ttlMs: 30_000 });
    await new Promise((r) => setTimeout(r, 50)); // garante a aquisição do holder

    const ext = "wamid.LCK." + randomUUID();
    const payload = signedInbound({ from, id: ext, type: "text", text: { body: "segunda msg" } });
    try {
      const err = await pipeline.process(payload).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(InboundProcessingError);
      expect(isLockContention(err)).toBe(true); // → worker re-enfileira com delay
    } finally {
      release();
      await holder;
    }
    // com o lock livre, a "reentrega" processa normalmente (mensagem não perdida).
    await pipeline.process(payload);
    const echoes = mock.sent.filter((s) => JSON.stringify(s.body).includes("echo: segunda msg"));
    expect(echoes).toHaveLength(1);
  }, 15_000);

  it("assinatura inválida: nada é processado", async () => {
    const before = mock.sent.length;
    await pipeline.process({
      headers: { "x-hub-signature-256": "sha256=invalida" },
      query: {},
      rawBody: JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: pnid }, messages: [{ from: "x", id: "y", type: "text", text: { body: "z" } }] } }] }] }),
    });
    expect(mock.sent.length).toBe(before);
  });

  it("mídia: baixa e persiste media_objects", async () => {
    const ext = "wamid.MED." + randomUUID();
    await pipeline.process(
      signedInbound({ from: "5511777", id: ext, type: "image", image: { id: "MID1", mime_type: "image/jpeg" } }),
    );
    const rows = await asTenant(
      (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM media_objects WHERE provider_media_id = 'MID1'`,
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it("áudio (M12): transcreve e o agente responde ao TEXTO transcrito", async () => {
    const ext = "wamid.AUD." + randomUUID();
    const before = mock.sent.length;
    await pipeline.process(
      signedInbound({ from: "5511666", id: ext, type: "audio", audio: { id: "AUD1", mime_type: "audio/ogg" } }),
    );
    // o handler (echo) recebeu o texto transcrito → ecoa "echo: quero um orçamento"
    const echo = mock.sent.slice(before).find((s) => JSON.stringify(s.body).includes("echo: quero um orçamento"));
    expect(echo).toBeTruthy();
    // transcrição persistida (cache) na media_objects
    const rows = await asTenant(
      (tx) => tx<{ transcription: string }[]>`
        SELECT transcription FROM media_objects WHERE provider_media_id = 'AUD1'`,
    );
    expect(rows[0]!.transcription).toBe("quero um orçamento");
  });

  it("áudio reentregue (idempotência): cache evita 2ª cobrança de transcrição", async () => {
    const before = await asTenant(
      (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM usage_events WHERE type = 'transcription'`,
    );
    const ext = "wamid.AUD2." + randomUUID();
    const payload = signedInbound({ from: "5511555", id: ext, type: "audio", audio: { id: "AUD1", mime_type: "audio/ogg" } });
    await pipeline.process(payload);
    // AUD1 já tem transcrição em cache (do teste anterior) → não gera novo usage de transcrição
    const after = await asTenant(
      (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM usage_events WHERE type = 'transcription'`,
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("status: delivery receipt atualiza a mensagem outbound", async () => {
    // pega um external_message_id outbound já enviado
    const out = await asTenant(
      (tx) => tx<{ external_message_id: string }[]>`
        SELECT external_message_id FROM messages
        WHERE direction = 'outbound' AND external_message_id IS NOT NULL LIMIT 1`,
    );
    const ext = out[0]!.external_message_id;
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { metadata: { phone_number_id: pnid }, statuses: [{ id: ext, status: "delivered", timestamp: "1700000005", recipient_id: "5511999" }] } }] }],
    });
    await pipeline.process({ headers: { "x-hub-signature-256": signMetaBody(body, cfg.whatsapp.appSecret!) }, query: {}, rawBody: body });
    const rows = await asTenant(
      (tx) => tx<{ status: string }[]>`SELECT status FROM messages WHERE external_message_id = ${ext}`,
    );
    expect(rows[0]!.status).toBe("delivered");
  });
});
