import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrmError } from "@sdr/core";
import { HttpCrmProvider, makeFetchCrmHttp } from "./index";

/** Servidor que ACEITA a conexão mas nunca responde (CRM pendurado). */
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

describe("fetchCrmHttp — timeout de rede (AbortSignal)", () => {
  const srv = hangingServer();
  let base = "";
  beforeAll(async () => {
    base = await srv.listen();
  });
  afterAll(() => srv.close());

  it("post pendurado aborta após o timeout", async () => {
    const http = makeFetchCrmHttp(100);
    await expect(http.post(`${base}/contacts`, {}, {})).rejects.toThrow(/timeout de rede após 100ms/);
  });

  it("provider converte o timeout em CrmError TRANSIENTE (o job re-tenta)", async () => {
    const provider = new HttpCrmProvider({ baseURL: base, timeoutMs: 100 });
    const err = await provider
      .upsertContact({ phone: "+5511999" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmError);
    expect((err as CrmError).transient).toBe(true);
  });
});
