import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmbeddingError } from "@sdr/core";
import { makeFetchEmbeddingsHttp } from "./http";
import { OpenAiCompatEmbeddingsProvider } from "./embeddings-adapter";

/** Servidor que ACEITA a conexão mas nunca responde (endpoint pendurado). */
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

describe("fetchEmbeddingsHttp — timeout de rede (AbortSignal)", () => {
  const srv = hangingServer();
  let base = "";
  beforeAll(async () => {
    base = await srv.listen();
  });
  afterAll(() => srv.close());

  it("post pendurado aborta após o timeout", async () => {
    const http = makeFetchEmbeddingsHttp(100);
    await expect(http.post(`${base}/embeddings`, {}, { input: ["x"] })).rejects.toThrow(
      /timeout de rede após 100ms/,
    );
  });

  it("adaptador converte o timeout em EmbeddingError TRANSIENTE (retry esgotado)", async () => {
    const provider = new OpenAiCompatEmbeddingsProvider({
      baseURL: base,
      model: "bge-m3",
      timeoutMs: 100,
      maxAttempts: 1,
    });
    const err = await provider
      .embed(["texto"])
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).transient).toBe(true);
  });
});
