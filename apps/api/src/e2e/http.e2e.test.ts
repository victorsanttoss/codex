/**
 * E2E HTTP — primeira suíte que exercita o servidor Nest REAL (AppModule
 * inteiro + guards globais + middleware + ValidationPipe) via supertest.
 *
 * Motivação (docs/CHECKPOINT.md): os testes existentes exercitam services e
 * isso escondeu bugs de "cola" HTTP (guards, pipes, contexto de tenant por
 * request) — exatamente a classe coberta aqui.
 *
 * O bootstrap replica o main.ts: rawBody:true (HMAC do webhook é sobre os
 * bytes originais — ADR 0007), cookie-parser e ValidationPipe global
 * ({ whitelist, transform }). O logger pino é silenciado (não altera
 * comportamento). CORS não é asserido (não afeta supertest same-origin).
 *
 * Roda com a config dedicada (SWC emite decorator metadata p/ DI do Nest):
 *   npx vitest run --config vitest.e2e.config.ts
 */
import { createHash, randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import argon2 from "argon2";
import cookieParser from "cookie-parser";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runWithTenant } from "@sdr/core";
import {
  applyLeadDecision,
  closeDb,
  getOrCreateLeadProfile,
  makeMigrationClient,
  recordInboundMessage,
} from "@sdr/db";
import { signMetaBody } from "@sdr/whatsapp-cloud";
import { AppModule } from "../app.module";
import { WebhookQueue } from "../whatsapp/webhook.queue";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

// ── Env controlado (ANTES do loadConfig do AppConfigModule, que roda no init) ──
// APP_ROLE=api: NÃO consome filas BullMQ nem sobe sessões Baileys/scheduler —
// só HTTP (producers de fila ainda conectam no Redis, mas ninguém consome).
// Segredos do webhook conhecidos para assinar payloads no teste.
const E2E_APP_SECRET = "e2e-app-secret-" + randomUUID();
const E2E_VERIFY_TOKEN = "e2e-verify-" + randomUUID();
const ENV_OVERRIDES: Record<string, string> = {
  APP_ROLE: "api",
  WHATSAPP_APP_SECRET: E2E_APP_SECRET,
  WHATSAPP_VERIFY_TOKEN: E2E_VERIFY_TOKEN,
  LOG_LEVEL: "fatal", // pino-http loga cada request no stdout; silencia o ruído
};
const envBackup: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
  envBackup[k] = process.env[k];
  process.env[k] = v;
}

/** Sobe o app Nest REAL espelhando o bootstrap do main.ts. */
async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  // rawBody:true preserva os bytes originais (validação HMAC do webhook).
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!dbConfigured)("E2E HTTP — AppModule real via supertest", () => {
  const mig = makeMigrationClient();
  const tag = randomUUID().slice(0, 8);
  const PASSWORD = "senha-e2e-" + tag;
  const emailA = `e2e-a-${tag}@t.local`;
  const emailB = `e2e-b-${tag}@t.local`;
  const staffEmail = `e2e-staff-${tag}@t.local`;
  const STAFF_TOKEN = "tok-e2e-staff-" + tag;
  const LEAD_A = "Lead E2E Tenant A " + tag;
  const LEAD_B = "Lead E2E Tenant B " + tag;

  let app: INestApplication;
  let tenantA = "";
  let tenantB = "";
  let userAId = "";
  let convB = ""; // conversa do tenant B (para provar 404 cross-tenant)
  let tokenA = ""; // access token do usuário do tenant A
  let tokenB = "";

  /** Semeia uma conversa+lead no tenant dado (mesmo padrão do crm-read.test). */
  async function seedLead(tenantId: string, name: string): Promise<string> {
    return runWithTenant({ tenantId }, async () => {
      const rec = await recordInboundMessage({
        conversationKey: `cloud_api:pn:${randomUUID().slice(0, 6)}`,
        waId: "5511" + randomUUID().slice(0, 7),
        profileName: name,
        externalMessageId: "wamid." + randomUUID(),
        type: "text",
        content: { text: "olá" },
      });
      await getOrCreateLeadProfile(rec.conversationId);
      await applyLeadDecision(rec.conversationId, { status: "new", stage: "new", score: 10 });
      return rec.conversationId;
    });
  }

  beforeAll(async () => {
    // Tenants A e B + um usuário em cada (admin em A, agent em B).
    const [ta] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('E2E A', ${"e2e-a-" + tag}) RETURNING id`;
    const [tb] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('E2E B', ${"e2e-b-" + tag}) RETURNING id`;
    tenantA = ta!.id;
    tenantB = tb!.id;

    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const [ua] = await mig.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash) VALUES (${emailA}, ${passwordHash}) RETURNING id`;
    const [ub] = await mig.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash) VALUES (${emailB}, ${passwordHash}) RETURNING id`;
    userAId = ua!.id;
    // memberships tem FORCE RLS: o WITH CHECK exige app.tenant_id no contexto
    // (mesmo padrão do seed.ts) — uma transação por tenant.
    for (const [tenantId, userId, role] of [
      [tenantA, ua!.id, "admin"],
      [tenantB, ub!.id, "agent"],
    ] as const) {
      await mig.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`INSERT INTO memberships (tenant_id, user_id, role) VALUES (${tenantId}, ${userId}, ${role})`;
      });
    }

    // Staff da plataforma com token PESSOAL (não depende do PLATFORM_ADMIN_TOKEN do .env).
    await mig.sql`
      INSERT INTO platform_staff (email, name, role, token_hash)
      VALUES (${staffEmail}, 'E2E Staff', 'support', ${sha256(STAFF_TOKEN)})`;

    // Um lead/conversa em cada tenant (o escopo é o teste: A nunca vê B).
    await seedLead(tenantA, LEAD_A);
    convB = await seedLead(tenantB, LEAD_B);

    app = await createApp();
  });

  afterAll(async () => {
    await app?.close(); // ShutdownService fecha o pool compartilhado do @sdr/db
    await mig.sql`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`; // cascata
    await mig.sql`DELETE FROM users WHERE email IN (${emailA}, ${emailB})`;
    await mig.sql`DELETE FROM platform_staff WHERE email = ${staffEmail}`;
    await mig.sql.end();
    await closeDb();
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // 1. Auth — /auth/login e /auth/me atravessando ValidationPipe + guards.
  //    ORÇAMENTO DO THROTTLER: /auth/login tem limite de 10/min por IP e o
  //    contador é em memória POR instância do app — esta suíte faz só 4 hits
  //    no app principal (o teste dedicado do throttler usa OUTRA instância).
  //    TODO: refresh/logout ficam de fora — a semântica está sendo alterada
  //    por outro agente neste momento; cobrir quando estabilizar.
  // ────────────────────────────────────────────────────────────────────────
  describe("auth", () => {
    it("login com credenciais corretas → 201 + accessToken + cookies httpOnly", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: emailA, password: PASSWORD });
      // 201 = default do Nest para @Post sem @HttpCode (comportamento real do servidor).
      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.activeTenantId).toBe(tenantA);
      expect(res.body.tenants).toHaveLength(1);
      const cookies = res.get("set-cookie") ?? [];
      expect(cookies.some((c: string) => c.startsWith("access_token="))).toBe(true);
      expect(cookies.some((c: string) => c.startsWith("refresh_token="))).toBe(true);
      tokenA = res.body.accessToken as string;
    });

    it("login com senha errada → 401", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: emailA, password: "senha-errada" });
      expect(res.status).toBe(401);
      expect(res.body.accessToken).toBeUndefined();
    });

    it("login com corpo malformado → 400 (ValidationPipe global)", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: "não-é-email", password: "" });
      expect(res.status).toBe(400);
    });

    it("GET /auth/me sem token → 401 (JwtAuthGuard global)", async () => {
      const res = await request(app.getHttpServer()).get("/auth/me");
      expect(res.status).toBe(401);
    });

    it("GET /auth/me com access token → 200 com as claims do usuário", async () => {
      const res = await request(app.getHttpServer())
        .get("/auth/me")
        .set("Authorization", `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.sub).toBe(userAId);
      expect(res.body.tenantId).toBe(tenantA);
      expect(res.body.role).toBe("admin");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. Escopo de tenant no painel — o RLS de verdade, entrando pelo HTTP
  //    (JwtAuthGuard → assignTenant → withTenant no repo).
  // ────────────────────────────────────────────────────────────────────────
  describe("escopo de tenant no painel", () => {
    it("GET /admin/leads sem token → 401", async () => {
      const res = await request(app.getHttpServer()).get("/admin/leads");
      expect(res.status).toBe(401);
    });

    it("usuário do tenant A lista SÓ os leads do tenant A", async () => {
      const res = await request(app.getHttpServer())
        .get("/admin/leads")
        .set("Authorization", `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      const names = (res.body.rows as { name: string }[]).map((r) => r.name);
      expect(names).toContain(LEAD_A);
      expect(names).not.toContain(LEAD_B); // NUNCA dados do tenant B
    });

    it("usuário do tenant B lista SÓ os leads do tenant B", async () => {
      const login = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: emailB, password: PASSWORD });
      expect(login.status).toBe(201);
      tokenB = login.body.accessToken as string;

      const res = await request(app.getHttpServer())
        .get("/admin/leads")
        .set("Authorization", `Bearer ${tokenB}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      const names = (res.body.rows as { name: string }[]).map((r) => r.name);
      expect(names).toContain(LEAD_B);
      expect(names).not.toContain(LEAD_A);
    });

    it("detalhe de conversa de OUTRO tenant → 404 (invisível, não 403)", async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/leads/${convB}`)
        .set("Authorization", `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. Webhook — assinatura HMAC sobre o corpo BRUTO (ADR 0007). O controller
  //    responde 200 nos dois casos (não vaza a validação p/ um forjador); o
  //    efeito observável é ENFILEIRAR ou NÃO — espiona-se o WebhookQueue real.
  // ────────────────────────────────────────────────────────────────────────
  describe("webhook do WhatsApp", () => {
    const rawBody = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    it("GET de verificação: verify token correto → 200 com o challenge; errado → 403", async () => {
      const ok = await request(app.getHttpServer())
        .get("/webhooks/whatsapp")
        .query({ "hub.mode": "subscribe", "hub.verify_token": E2E_VERIFY_TOKEN, "hub.challenge": "desafio-123" });
      expect(ok.status).toBe(200);
      expect(ok.text).toBe("desafio-123");

      const bad = await request(app.getHttpServer())
        .get("/webhooks/whatsapp")
        .query({ "hub.mode": "subscribe", "hub.verify_token": "errado", "hub.challenge": "x" });
      expect(bad.status).toBe(403);
    });

    it("assinatura inválida → descartado na borda (200, mas NADA enfileirado)", async () => {
      const queue = app.get(WebhookQueue);
      const spy = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
      try {
        const res = await request(app.getHttpServer())
          .post("/webhooks/whatsapp")
          .set("content-type", "application/json")
          .set("x-hub-signature-256", "sha256=" + "0".repeat(64))
          .send(rawBody);
        expect(res.status).toBe(200); // 200 de propósito: não vaza a validação
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("assinatura válida → aceito (200) e evento enfileirado", async () => {
      const queue = app.get(WebhookQueue);
      // mock do enqueue: não toca o Redis real (payload mínimo, sem processamento).
      const spy = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
      try {
        const res = await request(app.getHttpServer())
          .post("/webhooks/whatsapp")
          .set("content-type", "application/json")
          .set("x-hub-signature-256", signMetaBody(rawBody, E2E_APP_SECRET))
          .send(rawBody);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true });
        expect(spy).toHaveBeenCalledTimes(1);
        // O corpo bruto chegou intacto ao enqueue (rawBody:true do bootstrap).
        expect(spy.mock.calls[0]![0].rawBody).toBe(rawBody);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. Plataforma — staff por token pessoal (x-platform-token), fail-closed.
  // ────────────────────────────────────────────────────────────────────────
  describe("área da plataforma (staff)", () => {
    it("GET /platform/tenants sem x-platform-token → 403 (fail-closed)", async () => {
      const res = await request(app.getHttpServer()).get("/platform/tenants");
      expect(res.status).toBe(403);
    });

    it("token de STAFF válido → 200 e enxerga os tenants (cross-tenant)", async () => {
      const res = await request(app.getHttpServer())
        .get("/platform/tenants")
        .set("x-platform-token", STAFF_TOKEN);
      expect(res.status).toBe(200);
      const ids = (res.body as { id: string }[]).map((t) => t.id);
      expect(ids).toContain(tenantA);
      expect(ids).toContain(tenantB);
    });

    it("GET /platform/me resolve a identidade concreta do staff", async () => {
      const res = await request(app.getHttpServer())
        .get("/platform/me")
        .set("x-platform-token", STAFF_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(staffEmail);
      expect(res.body.role).toBe("support");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 5. Throttler — 10/min por IP no /auth/login. O contador do Throttler é em
  //    memória POR instância do app (ThrottlerModule.forRoot no AuthModule);
  //    sobe-se uma SEGUNDA instância só para este teste, para não poluir (nem
  //    ser poluído por) os logins dos testes acima. Sem X-Forwarded-For: o
  //    main.ts não seta trust proxy, então o servidor real também não confia.
  // ────────────────────────────────────────────────────────────────────────
  describe("throttler do login", () => {
    it("11 tentativas rápidas do mesmo IP → a 11ª leva 429", async () => {
      const app2 = await createApp();
      try {
        const server = app2.getHttpServer();
        const body = { email: `throttle-${tag}@nao-existe.local`, password: "qualquer" };
        for (let i = 1; i <= 10; i += 1) {
          const res = await request(server).post("/auth/login").send(body);
          expect(res.status, `tentativa ${i} não deveria ser limitada`).toBe(401);
        }
        const eleventh = await request(server).post("/auth/login").send(body);
        expect(eleventh.status).toBe(429);
      } finally {
        await app2.close();
      }
    }, 120_000);
  });
});
