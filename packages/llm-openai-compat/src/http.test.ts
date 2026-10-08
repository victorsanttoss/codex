import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmError } from "@sdr/core";
import { makeFetchOpenAiHttp } from "./http";
import { OpenAiCompatProvider } from "./openai-adapter";

/**
 * Servidor controlável: `/hang` nunca responde; `/drip` responde os headers do
 * SSE e depois ESTAGNA (nunca fecha o body) — simula stream pendurado.
 */
function slowServer() {
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    if (req.url === "/drip/chat/completions") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"oi"}}]}\n\n');
      // ...e nunca mais escreve nem encerra (stream estagnado).
      return;
    }
    /* /hang: nunca responde */
  });
  server.on("connection", (s) => sockets.add(s));
  return {
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

describe("fetchOpenAiHttp — timeout de rede (AbortSignal)", () => {
  const srv = slowServer();
  let base = "";
  beforeAll(async () => {
    base = await srv.listen();
  });
  afterAll(() => srv.close());

  it("complete pendurado aborta após o timeout", async () => {
    const http = makeFetchOpenAiHttp(100);
    await expect(http.complete(`${base}/hang`, {}, {})).rejects.toThrow(/timeout de rede após 100ms/);
  });

  it("stream ESTAGNADO também aborta (o signal cobre as leituras do body)", async () => {
    // 1000ms (não menos): sob carga paralela da suíte, um timeout curto pode
    // abortar ANTES da 1ª leitura do body e flakear o assert de emissão.
    const http = makeFetchOpenAiHttp(1000);
    const events: string[] = [];
    await expect(async () => {
      for await (const data of http.stream(`${base}/drip/chat/completions`, {}, {})) {
        events.push(data);
      }
    }).rejects.toThrow(/timeout de rede após 1000ms/);
    expect(events.length).toBeGreaterThanOrEqual(1); // o que chegou antes foi emitido
  });

  it("adaptador converte o timeout em LlmError TRANSIENTE (retry)", async () => {
    const provider = new OpenAiCompatProvider({ baseURL: `${base}/hang`, timeoutMs: 100 });
    const err = await provider
      .complete({ model: "m", messages: [{ role: "user", content: "oi" }] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).transient).toBe(true);
  });
});
