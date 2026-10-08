import { describe, expect, it } from "vitest";
import { JwtService } from "@nestjs/jwt";
import type { AppConfig } from "@sdr/config";
import { TokenService } from "./token.service";

const cfg = {
  auth: {
    accessSecret: "access-secret-com-mais-de-32-caracteres!!",
    refreshSecret: "refresh-secret-com-mais-de-32-caracteres!",
    accessTtl: "15m",
    refreshTtl: "30d",
    cookieDomain: "localhost",
    cookieSecure: false,
  },
} as unknown as AppConfig;

function makeService(): TokenService {
  return new TokenService(new JwtService({}), cfg);
}

describe("TokenService", () => {
  it("assina e verifica access token (roundtrip dos claims)", async () => {
    const svc = makeService();
    const token = await svc.signAccess({ sub: "u1", tenantId: "t1", role: "admin" });
    const claims = await svc.verifyAccess(token);
    expect(claims).toMatchObject({ sub: "u1", tenantId: "t1", role: "admin" });
  });

  it("access token NÃO é válido com o segredo de refresh (segredos isolados)", async () => {
    const svc = makeService();
    const access = await svc.signAccess({ sub: "u1", tenantId: "t1", role: "agent" });
    await expect(svc.verifyRefresh(access)).rejects.toBeDefined();
  });

  it("assina e verifica refresh token com jti (referência da sessão server-side)", async () => {
    const svc = makeService();
    const token = await svc.signRefresh({ sub: "u1", tenantId: "t1", jti: "jti-abc" });
    expect(await svc.verifyRefresh(token)).toMatchObject({
      sub: "u1",
      tenantId: "t1",
      jti: "jti-abc",
    });
  });

  it("readExpiration devolve o exp do token assinado (30d de refreshTtl)", async () => {
    const svc = makeService();
    const before = Date.now();
    const token = await svc.signRefresh({ sub: "u1", tenantId: "t1", jti: "j" });
    const exp = svc.readExpiration(token).getTime();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(exp).toBeGreaterThan(before + thirtyDays - 60_000);
    expect(exp).toBeLessThan(before + thirtyDays + 60_000);
  });
});
