import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "@sdr/config";
import { closeDb, makeMigrationClient } from "@sdr/db";
import { TokenRefreshService, type TokenRefresher } from "./token-refresh.service";
import type { AlertEvent, AlertNotifier } from "./alert-notifier";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const cfg = { app: { role: "scheduler" } } as unknown as AppConfig;

describe.skipIf(!dbConfigured)("M11 — TokenRefreshService (resolve dívida M3, ao vivo)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId = "";

  async function seedExpiringConnection(): Promise<string> {
    const pnid = "pnid-" + randomUUID();
    await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      // token expira em ~1 dia (dentro do horizonte de 3 dias)
      await tx`INSERT INTO channel_connections (tenant_id, phone_number_id, status, secret_ref, token_expires_at)
               VALUES (${tenantId}, ${pnid}, 'active', 'whatsapp_token', now() + interval '1 day')`;
    });
    return pnid;
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [t] = await mig.sql<{ id: string }[]>`INSERT INTO tenants (name, slug) VALUES ('TR', ${"tr-" + randomUUID()}) RETURNING id`;
    tenantId = t!.id;
  });
  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await closeDb();
  });

  it("refresher devolve token novo → renova token_expires_at", async () => {
    const pnid = await seedExpiringConnection();
    const newExpiry = new Date(Date.now() + 60 * 24 * 3600_000); // +60d
    const refresher: TokenRefresher = { async refresh() { return { expiresAt: newExpiry }; } };
    const sent: AlertEvent[] = [];
    const notifier: AlertNotifier = { async notify(a) { sent.push(a); } };
    const svc = new TokenRefreshService(cfg, refresher, notifier);

    const r = await svc.refreshExpiring();
    expect(r.refreshed).toBeGreaterThanOrEqual(1);
    const rows = await mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return tx<{ token_expires_at: Date }[]>`
        SELECT token_expires_at FROM channel_connections WHERE phone_number_id = ${pnid}`;
    });
    const row = (rows as unknown as { token_expires_at: Date }[])[0]!;
    expect(new Date(row.token_expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 24 * 3600_000);
  });

  it("refresher null → ALERTA o operador (não silencia a expiração)", async () => {
    await seedExpiringConnection();
    const refresher: TokenRefresher = { async refresh() { return null; } };
    const sent: AlertEvent[] = [];
    const notifier: AlertNotifier = { async notify(a) { sent.push(a); } };
    const svc = new TokenRefreshService(cfg, refresher, notifier);

    const r = await svc.refreshExpiring();
    expect(r.alerted).toBeGreaterThanOrEqual(1);
    expect(sent.some((a) => a.kind === "token_refresh_needed")).toBe(true);
  });
});
