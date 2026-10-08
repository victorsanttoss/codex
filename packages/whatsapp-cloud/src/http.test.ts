import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFetchHttpClient, mapTimeout } from "./http";

/** Servidor que ACEITA a conexão mas nunca responde (socket pendurado). */
function hangingServer() {
  const sockets = new Set<Socket>();
  const server = createServer(() => {
    /* nunca responde */
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

describe("fetchHttpClient — timeout de rede (AbortSignal)", () => {
  const srv = hangingServer();
  let url = "";
  beforeAll(async () => {
    url = await srv.listen();
  });
  afterAll(() => srv.close());

  it("post pendurado aborta após o timeout (erro claro, sem travar o worker)", async () => {
    const http = makeFetchHttpClient(100);
    await expect(http.post(url, { headers: {}, body: "{}" })).rejects.toThrow(/timeout de rede após 100ms/);
  });

  it("get pendurado (download de mídia) também aborta", async () => {
    const http = makeFetchHttpClient(100);
    await expect(http.get(url, { headers: {} })).rejects.toThrow(/timeout de rede após 100ms/);
  });

  it("mapTimeout preserva erros que NÃO são de aborto", () => {
    const original = new Error("outra falha");
    expect(mapTimeout(original, 100)).toBe(original);
  });
});
