import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@sdr/config";
import { runWithTenant } from "@sdr/core";
import {
  closeDb,
  makeCipherFromEnv,
  makeMigrationClient,
  resolveConnectionByPhoneNumberId,
  TenantSecretsStore,
} from "@sdr/db";
import type { HttpClient } from "@sdr/whatsapp-cloud";
import { EmbeddedSignupService, SignupConflictError } from "./embedded-signup.service";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

function j(body: unknown) {
  return {
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function mockGraph(phoneNumberId: string): HttpClient {
  return {
    async get(url: string) {
      if (url.includes("/oauth/access_token")) return j({ access_token: "TKN-123", expires_in: 3600 });
      if (url.includes("/phone_numbers")) return j({ data: [{ id: phoneNumberId }] });
      if (url.includes("fields=")) return j({ id: phoneNumberId, display_phone_number: "+5511" });
      return j({});
    },
    async post() {
      return j({ success: true });
    },
  };
}

describe.skipIf(!dbConfigured)("M3 — EmbeddedSignupService (integração ao vivo)", () => {
  const cfg = loadConfig();
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

  it("fluxo feliz: troca code, persiste token cifrado + conexão; resolve passa a rotear", async () => {
    const pn = "PN_" + randomUUID().slice(0, 8);
    const svc = new EmbeddedSignupService(cfg, mockGraph(pn));
    const res = await runWithTenant({ tenantId: tenantA }, () =>
      svc.connect({ code: "code-xyz", phoneNumberId: pn, wabaId: "WABA1" }),
    );
    expect(res.reconnected).toBe(false);
    expect(res.displayPhone).toBe("+5511");

    // conexão roteável e token cifrado guardado
    expect((await resolveConnectionByPhoneNumberId(pn))?.tenantId).toBe(tenantA);
    const token = await runWithTenant({ tenantId: tenantA }, () =>
      new TenantSecretsStore(makeCipherFromEnv()).get("whatsapp_token"),
    );
    expect(token).toBe("TKN-123");
  });

  it("conflito: número de outro tenant é recusado (SignupConflictError)", async () => {
    const pn = "PN_" + randomUUID().slice(0, 8);
    await runWithTenant({ tenantId: tenantA }, () =>
      new EmbeddedSignupService(cfg, mockGraph(pn)).connect({ code: "c", phoneNumberId: pn, wabaId: "W" }),
    );
    await expect(
      runWithTenant({ tenantId: tenantB }, () =>
        new EmbeddedSignupService(cfg, mockGraph(pn)).connect({ code: "c", phoneNumberId: pn, wabaId: "W" }),
      ),
    ).rejects.toBeInstanceOf(SignupConflictError);
  });

  it("recusa número que não pertence à WABA informada", async () => {
    const pn = "PN_" + randomUUID().slice(0, 8);
    const badGraph: HttpClient = {
      async get(url: string) {
        if (url.includes("/oauth/access_token")) return j({ access_token: "T" });
        if (url.includes("/phone_numbers")) return j({ data: [{ id: "OUTRO_NUMERO" }] });
        if (url.includes("fields=")) return j({ id: pn });
        return j({});
      },
      async post() {
        return j({});
      },
    };
    await expect(
      runWithTenant({ tenantId: tenantA }, () =>
        new EmbeddedSignupService(cfg, badGraph).connect({ code: "c", phoneNumberId: pn, wabaId: "W" }),
      ),
    ).rejects.toThrow(/não pertence/);
  });

  it("reconexão: mesmo tenant reconecta o número (reconnected=true)", async () => {
    const pn = "PN_" + randomUUID().slice(0, 8);
    const svc = new EmbeddedSignupService(cfg, mockGraph(pn));
    await runWithTenant({ tenantId: tenantA }, () =>
      svc.connect({ code: "c1", phoneNumberId: pn, wabaId: "W" }),
    );
    const again = await runWithTenant({ tenantId: tenantA }, () =>
      svc.connect({ code: "c2", phoneNumberId: pn, wabaId: "W" }),
    );
    expect(again.reconnected).toBe(true);
  });
});
