import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TranscriptionError } from "@sdr/core";
import { makeFetchTranscriptionHttp } from "./http";
import { OpenAiCompatTranscriptionProvider } from "./transcription-adapter";

/** Servidor que ACEITA a conexão mas nunca responde (Whisper travado). */
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

const AUDIO = {
  file: Buffer.from("fake-ogg"),
  filename: "audio.ogg",
  contentType: "audio/ogg",
  fields: { model: "whisper-1" },
};

describe("fetchTranscriptionHttp — timeout de rede (AbortSignal)", () => {
  const srv = hangingServer();
  let base = "";
  beforeAll(async () => {
    base = await srv.listen();
  });
  afterAll(() => srv.close());

  it("post multipart pendurado aborta após o timeout", async () => {
    const http = makeFetchTranscriptionHttp(100);
    await expect(http.post(`${base}/audio/transcriptions`, {}, AUDIO)).rejects.toThrow(
      /timeout de rede após 100ms/,
    );
  });

  it("adaptador converte o timeout em TranscriptionError TRANSIENTE (retry esgotado)", async () => {
    const provider = new OpenAiCompatTranscriptionProvider({
      baseURL: base,
      model: "whisper-1",
      timeoutMs: 100,
      maxAttempts: 1,
    });
    const err = await provider
      .transcribe({ data: AUDIO.file, mimeType: "audio/ogg" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptionError);
    expect((err as TranscriptionError).transient).toBe(true);
  });
});
