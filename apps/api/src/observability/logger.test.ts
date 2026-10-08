import { createServer } from "node:http";
import { Writable } from "node:stream";
import pino from "pino";
import pinoHttp, { type Options } from "pino-http";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@sdr/config";
import { runWithTenant, type NormalizedInboundMessage } from "@sdr/core";
import { FakeBaileysDriver, type BaileysEvent } from "@sdr/whatsapp-baileys";
import { BaileysSessionManager } from "../baileys/baileys-session.manager";
import { baileysRegistryProvider } from "../baileys/baileys.registry";
import { InboundCoreService } from "../whatsapp/inbound-core.service";
import { buildPinoParams, logCorrelationId } from "./logger";

vi.mock("@sdr/db", () => ({
  listActiveConnectionsByProvider: vi.fn().mockResolvedValue([]),
  setConnectionStatus: vi.fn().mockResolvedValue(undefined),
  markMessageStatusByExternalId: vi.fn().mockResolvedValue(undefined),
  reconcileOutboxStatus: vi.fn().mockResolvedValue(undefined),
  recordOutboundMessage: vi.fn().mockResolvedValue(undefined),
}));

const PHONE = "5511977774444";
const SESSION_PHONE = "5511966663333";
const LEAD_TEXT =
  "Tenho uma condição de saúde e procuro imóvel na Rua Sintética 123";
const TOKENS = {
  authorization: "Bearer secret-auth-regression",
  cookie: "session=secret-cookie-regression",
  "x-platform-token": "secret-platform-regression",
  "x-intake-token": "secret-intake-regression",
  "x-broker-token": "secret-broker-regression",
};
const CONFIG = { logLevel: "debug" } as AppConfig;

function capture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    output: () => chunks.join(""),
    records: () =>
      chunks
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

function assertNoPrivateData(output: string) {
  for (const value of [
    ...Object.values(TOKENS),
    PHONE,
    SESSION_PHONE,
    LEAD_TEXT,
    "secret-query-regression",
    "secret-response-cookie",
  ]) {
    expect(output).not.toContain(value);
  }
}

function externalError() {
  return Object.assign(
    new Error(`${LEAD_TEXT}: ${PHONE}; ${TOKENS["x-platform-token"]}`),
    {
      code: "ECONNRESET",
      statusCode: 503,
      config: { headers: TOKENS, data: { text: LEAD_TEXT, phone: PHONE } },
      cause: new Error(TOKENS["x-broker-token"]),
    },
  );
}

// Adaptador de teste para a interface do Logger do Nest. A saída é serializada
// pelo pino real com a mesma configuração usada na aplicação.
function logAdapter(stream: Writable) {
  const logger = pino(buildPinoParams(CONFIG).pinoHttp as Options, stream);
  return {
    log: (value: object) => logger.info(value),
    warn: (value: object) => logger.warn(value),
    error: (value: object) => logger.error(value),
    debug: (value: object) => logger.debug(value),
  };
}

describe("logs sem credenciais ou conteúdo de leads", () => {
  it.each([200, 503])(
    "captura HTTP real em fluxo %s preservando IDs/rota/status e descartando dados privados",
    async (status) => {
      const logs = capture();
      const middleware = pinoHttp(
        buildPinoParams(CONFIG).pinoHttp as Options,
        logs.stream,
      );
      const server = createServer((req, res) => {
        runWithTenant(
          {
            tenantId: "tenant-test",
            userId: "user-test",
            requestId: "request-test",
            conversationKey: `baileys:${SESSION_PHONE}:${PHONE}`,
          },
          () => {
            middleware(req, res);
            // O Express resolve o template APÓS o middleware de logging.
            Object.assign(req, { route: { path: "/logging/:id" } });
            req.log.info({
              event: "synthetic_request",
              token: TOKENS["x-intake-token"],
              metadata: { config: { headers: TOKENS } },
            });
            if (status === 503) {
              res.err = externalError();
              req.log.error({ err: res.err }, "provider_call_failed");
            }
            res.statusCode = status;
            res.setHeader("set-cookie", "session=secret-response-cookie");
            res.end("ok");
          },
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Test server did not bind");
      try {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/logging/${PHONE}?hub.verify_token=secret-query-regression`,
          {
            method: "POST",
            headers: { ...TOKENS, "content-type": "application/json" },
            body: JSON.stringify({ phone: PHONE, text: LEAD_TEXT }),
          },
        );
        expect(response.status).toBe(status);
        await response.text();
        await vi.waitFor(() =>
          expect(
            logs.records().some((record) => record.res?.statusCode === status),
          ).toBe(true),
        );
        assertNoPrivateData(logs.output());
        const completion = logs
          .records()
          .find((record) => record.res?.statusCode === status);
        expect(completion).toMatchObject({
          requestId: "request-test",
          tenantId: "tenant-test",
          userId: "user-test",
          conversationRef: logCorrelationId(
            `baileys:${SESSION_PHONE}:${PHONE}`,
          ),
          route: "/logging/:id",
          req: { method: "POST" },
          res: { statusCode: status },
        });
        if (status === 503) {
          const failure = logs
            .records()
            .find((record) => record.msg === "provider_call_failed");
          expect(failure.err).toMatchObject({
            type: "Error",
            code: "ECONNRESET",
            statusCode: 503,
          });
          expect(failure.err.stack).toContain("logger.test.ts");
          expect(failure.err).not.toHaveProperty("message");
          expect(failure.err).not.toHaveProperty("config");
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it("captura inbound Baileys normal, falho e diagnóstico cru sem imprimir telefone/texto/erro externo", async () => {
    const logs = capture();
    const driver = new FakeBaileysDriver();
    const core = { handle: vi.fn().mockResolvedValue(undefined) };
    const manager = new BaileysSessionManager(
      CONFIG,
      driver,
      baileysRegistryProvider.useFactory(),
      { get: vi.fn().mockResolvedValue(null) } as never,
      { publish: vi.fn().mockResolvedValue(undefined) } as never,
      { notify: vi.fn().mockResolvedValue(undefined) } as never,
      core as never,
      {} as never,
    );
    Object.defineProperty(manager, "logger", {
      value: logAdapter(logs.stream),
    });
    await manager.connect("tenant-test", SESSION_PHONE);
    driver.emit({
      type: "message",
      raw: {
        id: "inbound-normal",
        from: `${PHONE}@s.whatsapp.net`,
        text: LEAD_TEXT,
      },
    });
    await vi.waitFor(() =>
      expect(
        logs
          .records()
          .some((record) => record.event === "baileys_inbound_processed"),
      ).toBe(true),
    );
    core.handle.mockRejectedValueOnce(externalError());
    driver.emit({
      type: "message",
      raw: {
        id: "inbound-error",
        from: `${PHONE}@s.whatsapp.net`,
        text: LEAD_TEXT,
      },
    });
    driver.emit({
      type: "log",
      raw: { msg: `${PHONE} ${LEAD_TEXT} ${TOKENS["x-intake-token"]}` },
    } as unknown as BaileysEvent);
    await vi.waitFor(() =>
      expect(
        logs
          .records()
          .some((record) => record.event === "baileys_event_failed"),
      ).toBe(true),
    );
    assertNoPrivateData(logs.output());
    expect(core.handle).toHaveBeenCalledTimes(2);
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        event: "baileys_inbound_processed",
        tenantId: "tenant-test",
        sessionRef: logCorrelationId(SESSION_PHONE),
        conversationRef: logCorrelationId(`baileys:${SESSION_PHONE}:${PHONE}`),
      }),
    );
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        event: "baileys_event_failed",
        error: expect.objectContaining({ type: "Error", code: "ECONNRESET" }),
      }),
    );
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ event: "baileys_driver_event" }),
    );
    await manager.onModuleDestroy();
  });

  it("captura descarte por rate-limit usando correlação e tenant sem a chave telefônica", async () => {
    const logs = capture();
    const service = new InboundCoreService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { allow: vi.fn().mockResolvedValue(false) } as never,
    );
    Object.defineProperty(service, "logger", {
      value: logAdapter(logs.stream),
    });
    await service.handle(
      {
        conversationKey: `baileys:${SESSION_PHONE}:${PHONE}`,
        from: PHONE,
        content: { type: "text", text: LEAD_TEXT },
      } as NormalizedInboundMessage,
      { tenantId: "tenant-test" } as never,
      () => async () => {},
    );
    assertNoPrivateData(logs.output());
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        event: "inbound_rate_limited",
        tenantId: "tenant-test",
        conversationRef: logCorrelationId(`baileys:${SESSION_PHONE}:${PHONE}`),
      }),
    );
  });
});
