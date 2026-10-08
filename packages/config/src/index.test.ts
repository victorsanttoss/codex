import { describe, expect, it } from "vitest";
import { loadConfig } from "./index";

const KEK_OK = Buffer.alloc(32, 7).toString("base64");

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://app:pw@localhost:5432/sdr",
    MIGRATION_DATABASE_URL: "postgres://mig:pw@localhost:5432/sdr",
    REDIS_URL: "redis://localhost:6379",
    JWT_ACCESS_SECRET: "a".repeat(40),
    JWT_REFRESH_SECRET: "b".repeat(40),
    SECRETS_KEK_V1: KEK_OK,
    SECRETS_KEK_ACTIVE_VERSION: "1",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("carrega config válida e expõe a KEK ativa", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.secrets.activeVersion).toBe(1);
    expect(cfg.secrets.keks["1"]).toBe(KEK_OK);
    expect(cfg.auth.accessTtl).toBe("15m"); // default
  });

  it("embeddings: timeouts de ingestão e retrieval independentes (env + defaults)", () => {
    const defaults = loadConfig(baseEnv());
    expect(defaults.embeddings.timeoutMs).toBe(15_000);
    expect(defaults.embeddings.retrievalTimeoutMs).toBe(15_000);
    const cfg = loadConfig(
      baseEnv({ EMBEDDINGS_TIMEOUT_MS: "180000", EMBEDDINGS_RETRIEVAL_TIMEOUT_MS: "8000" }),
    );
    expect(cfg.embeddings.timeoutMs).toBe(180_000);
    expect(cfg.embeddings.retrievalTimeoutMs).toBe(8_000);
  });

  it("rejeita KEK que não decodifica para 32 bytes", () => {
    expect(() => loadConfig(baseEnv({ SECRETS_KEK_V1: "curtademais" }))).toThrow(/32 bytes/);
  });

  it("rejeita versão ativa sem KEK correspondente", () => {
    expect(() => loadConfig(baseEnv({ SECRETS_KEK_ACTIVE_VERSION: "9" }))).toThrow(
      /KEK correspondente/,
    );
  });

  it("rejeita segredo JWT curto", () => {
    expect(() => loadConfig(baseEnv({ JWT_ACCESS_SECRET: "curto" }))).toThrow(/JWT_ACCESS_SECRET/);
  });

  it("rejeita PLATFORM_ADMIN_TOKEN curto (< 32)", () => {
    expect(() => loadConfig(baseEnv({ PLATFORM_ADMIN_TOKEN: "curto" }))).toThrow(
      /PLATFORM_ADMIN_TOKEN/,
    );
  });

  // ── Endurecimento em produção (NODE_ENV=production) ──────────────────────
  // Base de prod "boa": tudo que o superRefine exige preenchido corretamente.
  function prodEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return baseEnv({
      NODE_ENV: "production",
      AUTH_COOKIE_SECURE: "true",
      AUTH_COOKIE_DOMAIN: "sdr.exemplo.com.br",
      WEB_ORIGIN: "https://sdr.exemplo.com.br",
      WHATSAPP_APP_SECRET: "s".repeat(40),
      PLATFORM_ADMIN_TOKEN: "p".repeat(40),
      ...overrides,
    });
  }

  it("prod: config endurecida válida passa", () => {
    const cfg = loadConfig(prodEnv());
    expect(cfg.nodeEnv).toBe("production");
    expect(cfg.auth.cookieSecure).toBe(true);
    expect(cfg.web.origin).toBe("https://sdr.exemplo.com.br");
  });

  it("prod: falha se AUTH_COOKIE_SECURE não for true", () => {
    expect(() => loadConfig(prodEnv({ AUTH_COOKIE_SECURE: "false" }))).toThrow(
      /AUTH_COOKIE_SECURE/,
    );
  });

  it("prod: falha se cookieDomain for localhost", () => {
    expect(() => loadConfig(prodEnv({ AUTH_COOKIE_DOMAIN: "localhost" }))).toThrow(
      /AUTH_COOKIE_DOMAIN/,
    );
  });

  it("prod: falha se WHATSAPP_APP_SECRET ausente", () => {
    expect(() => loadConfig(prodEnv({ WHATSAPP_APP_SECRET: undefined }))).toThrow(
      /WHATSAPP_APP_SECRET/,
    );
  });

  it("prod: falha se PLATFORM_ADMIN_TOKEN ausente", () => {
    expect(() => loadConfig(prodEnv({ PLATFORM_ADMIN_TOKEN: undefined }))).toThrow(
      /PLATFORM_ADMIN_TOKEN/,
    );
  });

  it("prod: falha se WEB_ORIGIN for localhost", () => {
    expect(() => loadConfig(prodEnv({ WEB_ORIGIN: "http://localhost:3000" }))).toThrow(
      /WEB_ORIGIN/,
    );
  });

  it("prod: falha se WEB_ORIGIN for wildcard", () => {
    expect(() => loadConfig(prodEnv({ WEB_ORIGIN: "*" }))).toThrow(/WEB_ORIGIN/);
  });

  it("prod: falha se um segredo contém placeholder do .env.example", () => {
    expect(() =>
      loadConfig(prodEnv({ PLATFORM_ADMIN_TOKEN: "troque-por-um-token-forte-de-verdade-aqui" })),
    ).toThrow(/placeholder/);
  });

  it("dev: permissivo — cookie inseguro e localhost passam", () => {
    const cfg = loadConfig(
      baseEnv({ NODE_ENV: "development", AUTH_COOKIE_SECURE: "false", AUTH_COOKIE_DOMAIN: "localhost" }),
    );
    expect(cfg.auth.cookieSecure).toBe(false);
    expect(cfg.auth.cookieDomain).toBe("localhost");
  });
});
