import { createHash, randomUUID } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@sdr/config";
import { closeDb, makeMigrationClient } from "@sdr/db";
import { type ActingStaff, PlatformStaffGuard, type StaffRole } from "./platform-staff.guard";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** ExecutionContext mínimo com o header dado; devolve também o `req` mutado. */
function fakeCtx(headers: Record<string, string>): { ctx: ExecutionContext; req: { staff?: ActingStaff } } {
  const req: { headers: Record<string, string>; staff?: ActingStaff } = { headers };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { ctx, req };
}

/** Reflector que devolve os papéis exigidos por este teste (sem metadata real). */
function fakeReflector(required: StaffRole[] | undefined): Reflector {
  return { getAllAndOverride: () => required } as unknown as Reflector;
}

describe.skipIf(!dbConfigured)("M14 — PlatformStaffGuard (identidade por-staff + papel)", () => {
  const cfg = loadConfig();
  cfg.platform.adminToken = "shared-bootstrap-token-" + randomUUID();
  const mig = makeMigrationClient();
  const tag = randomUUID().slice(0, 8);
  const CURATOR_TOKEN = "tok-curator-" + tag;
  const SUPPORT_TOKEN = "tok-support-" + tag;
  const curatorEmail = `curator-${tag}@t.local`;
  const supportEmail = `support-${tag}@t.local`;

  beforeAll(async () => {
    await mig.sql`
      INSERT INTO platform_staff (email, name, role, token_hash) VALUES
        (${curatorEmail}, 'Cur', 'curator', ${sha256(CURATOR_TOKEN)}),
        (${supportEmail}, 'Sup', 'support', ${sha256(SUPPORT_TOKEN)})`;
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM platform_staff WHERE email IN (${curatorEmail}, ${supportEmail})`;
    await mig.sql.end();
    await closeDb();
  });

  it("token pessoal → resolve a identidade concreta do staff (papel da linha)", async () => {
    const guard = new PlatformStaffGuard(cfg, fakeReflector(undefined));
    const { ctx, req } = fakeCtx({ "x-platform-token": CURATOR_TOKEN });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(req.staff?.email).toBe(curatorEmail);
    expect(req.staff?.role).toBe("curator");
  });

  it("papel exigido: curador PASSA em endpoint curator-only", async () => {
    const guard = new PlatformStaffGuard(cfg, fakeReflector(["curator"]));
    const { ctx } = fakeCtx({ "x-platform-token": CURATOR_TOKEN });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it("papel exigido: SUPPORT é BARRADO em endpoint curator-only", async () => {
    const guard = new PlatformStaffGuard(cfg, fakeReflector(["curator"]));
    const { ctx, req } = fakeCtx({ "x-platform-token": SUPPORT_TOKEN });
    expect(await guard.canActivate(ctx)).toBe(false);
    expect(req.staff?.role).toBe("support"); // identificado, mas sem permissão
  });

  it("token compartilhado de bootstrap → identidade admin (passa em tudo)", async () => {
    const guard = new PlatformStaffGuard(cfg, fakeReflector(["curator"]));
    const { ctx, req } = fakeCtx({ "x-platform-token": cfg.platform.adminToken! });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(req.staff?.id).toBe("platform-admin");
    expect(req.staff?.role).toBe("admin");
  });

  it("token inválido e header ausente → nega (fail-closed)", async () => {
    const guard = new PlatformStaffGuard(cfg, fakeReflector(undefined));
    expect(await guard.canActivate(fakeCtx({ "x-platform-token": "lixo" }).ctx)).toBe(false);
    expect(await guard.canActivate(fakeCtx({}).ctx)).toBe(false);
  });
});
