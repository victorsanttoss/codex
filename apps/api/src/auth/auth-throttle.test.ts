import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ThrottlerGuard } from "@nestjs/throttler";
import { AuthController } from "./auth.controller";

/**
 * Smoke test do rate-limit de credenciais: garante que o ThrottlerGuard está
 * aplicado EXATAMENTE em /auth/login e /auth/refresh (não global — webhooks e
 * demais rotas não passam pelo guard) e que o override de 10/min está no lugar.
 * O ThrottlerModule é registrado UMA vez (global) no AppModule; o limite por
 * rota vem do @Throttle() (login/refresh = 10; default global = 30).
 */
describe("auth — rate-limit (força bruta)", () => {
  const guardsOf = (method: keyof AuthController) =>
    (Reflect.getMetadata("__guards__", AuthController.prototype[method]) ?? []) as unknown[];

  it("login e refresh têm o ThrottlerGuard", () => {
    expect(guardsOf("login")).toContain(ThrottlerGuard);
    expect(guardsOf("refresh")).toContain(ThrottlerGuard);
  });

  it("demais endpoints NÃO têm o guard (não afeta switch-tenant/logout/me)", () => {
    expect(guardsOf("switchTenant")).not.toContain(ThrottlerGuard);
    expect(guardsOf("logout")).not.toContain(ThrottlerGuard);
    expect(guardsOf("me")).not.toContain(ThrottlerGuard);
  });

  it("login e refresh têm @Throttle com limite 10 (override do default global)", () => {
    // O @Throttle grava metadados por-nome do throttler ('default'): a chave é
    // `THROTTLER:LIMITdefault`. Confirmamos o override para 10 nos dois métodos.
    for (const method of ["login", "refresh"] as const) {
      const limit = Reflect.getMetadata("THROTTLER:LIMITdefault", AuthController.prototype[method]) as
        | number
        | (() => number)
        | undefined;
      expect(typeof limit === "function" ? limit() : limit).toBe(10);
    }
  });
});
