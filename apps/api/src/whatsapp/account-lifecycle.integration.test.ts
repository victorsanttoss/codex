import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@sdr/config";
import { runWithTenant, type InboundWebhookRequest } from "@sdr/core";
import {
  closeDb,
  findConnectionOwner,
  makeMigrationClient,
  resolveConnectionByPhoneNumberId,
  upsertChannelConnection,
} from "@sdr/db";
import { signMetaBody, type HttpClient } from "@sdr/whatsapp-cloud";
import { ChannelFactory } from "./channel-factory.service";
import { AccountEventsService } from "./account-events.service";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const noopHttp: HttpClient = {
  async get() {
    return { status: 200, json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
  },
  async post() {
    return { status: 200, json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
  },
};

describe.skipIf(!dbConfigured)("M3 — lifecycle de conta + expiração (integração)", () => {
  const cfg = loadConfig();
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId = "";
  const pn = "PN_" + randomUUID().slice(0, 8);
  const waba = "WABA_" + randomUUID().slice(0, 8);

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('AC', ${"ac-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
    await runWithTenant({ tenantId }, () =>
      upsertChannelConnection({
        phoneNumberId: pn,
        wabaId: waba,
        tokenExpiresAt: new Date(Date.now() + 24 * 3600 * 1000), // vence em 1 dia
      }),
    );
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await closeDb();
  });

  function signedAccountEvent(event: string): InboundWebhookRequest {
    const body = JSON.stringify({
      entry: [{ id: waba, changes: [{ field: "account_update", value: { event } }] }],
    });
    return { headers: { "x-hub-signature-256": signMetaBody(body, cfg.whatsapp.appSecret!) }, query: {}, rawBody: body };
  }

  it("account_update 'DISABLED_UPDATE' revoga a conexão (resolve para de rotear)", async () => {
    const svc = new AccountEventsService(new ChannelFactory(cfg, noopHttp));
    await svc.process(signedAccountEvent("DISABLED_UPDATE"));
    expect(await resolveConnectionByPhoneNumberId(pn)).toBeNull(); // revoked != active
    expect((await findConnectionOwner(pn))?.status).toBe("revoked");
  });

  // O scan de tokens vencendo migrou para o TokenRefreshService (M11/OpsModule);
  // ver ops.integration.test.ts (renova / alerta).
});
