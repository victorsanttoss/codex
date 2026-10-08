import { describe, expect, it } from "vitest";
import { TranscriptionError } from "@sdr/core";
import { runTranscriptionProviderContract } from "../../core/src/ports/testing/transcription-provider.contract";
import { OpenAiCompatTranscriptionProvider } from "./transcription-adapter";
import type { TranscriptionHttp, TranscriptionMultipart } from "./http";

const noSleep = async () => {};

/** Mock que captura as chamadas multipart e devolve o que o handler retornar. */
function fakeHttp(
  handler: (body: TranscriptionMultipart, call: number) => { status: number; json: unknown },
) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: TranscriptionMultipart }> = [];
  const http: TranscriptionHttp = {
    async post(url, headers, body) {
      calls.push({ url, headers, body });
      return handler(body, calls.length);
    },
  };
  return { http, calls };
}

function okJson(text: string, duration = 3.2) {
  return { status: 200, json: { text, duration, language: "pt" } };
}

function make(
  opts: Partial<ConstructorParameters<typeof OpenAiCompatTranscriptionProvider>[0]> = {},
  http?: TranscriptionHttp,
) {
  return new OpenAiCompatTranscriptionProvider({
    baseURL: "http://stt.local/v1",
    model: "whisper-1",
    sleep: noSleep,
    ...(http ? { http } : {}),
    ...opts,
  });
}

// 1) Contrato reutilizável.
runTranscriptionProviderContract("openai_compat", () =>
  make({}, fakeHttp(() => okJson("olá mundo")).http),
);

describe("OpenAiCompatTranscriptionProvider", () => {
  it("mapeia texto/duração; usa baseURL/model, Bearer e verbose_json", async () => {
    const { http, calls } = fakeHttp(() => okJson("bom dia", 4.5));
    const provider = make({ apiKey: "sk-t" }, http);
    const res = await provider.transcribe({ data: Buffer.from("oggbytes"), mimeType: "audio/ogg", languageHint: "pt" });
    expect(res.text).toBe("bom dia");
    expect(res.usage.seconds).toBe(4.5);
    expect(calls[0]!.url).toBe("http://stt.local/v1/audio/transcriptions");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-t");
    expect(calls[0]!.body.fields.model).toBe("whisper-1");
    expect(calls[0]!.body.fields.response_format).toBe("verbose_json");
    expect(calls[0]!.body.fields.language).toBe("pt");
    expect(calls[0]!.body.filename).toBe("audio.ogg");
  });

  it("aplica defaultLanguage quando não há languageHint", async () => {
    const { http, calls } = fakeHttp(() => okJson("texto"));
    await make({ defaultLanguage: "pt" }, http).transcribe({ data: Buffer.from("a"), mimeType: "audio/ogg" });
    expect(calls[0]!.body.fields.language).toBe("pt");
  });

  it("deriva a extensão do MIME (mp3, wav, mp4, default ogg)", async () => {
    const { http, calls } = fakeHttp(() => okJson("x"));
    const p = make({}, http);
    await p.transcribe({ data: Buffer.from("a"), mimeType: "audio/mpeg" });
    await p.transcribe({ data: Buffer.from("a"), mimeType: "audio/wav" });
    await p.transcribe({ data: Buffer.from("a"), mimeType: "audio/mp4" });
    await p.transcribe({ data: Buffer.from("a"), mimeType: "audio/desconhecido" });
    expect(calls.map((c) => c.body.filename)).toEqual(["audio.mp3", "audio.wav", "audio.mp4", "audio.ogg"]);
  });

  it("sem duração na resposta → usage sem seconds (não inventa)", async () => {
    const { http } = fakeHttp(() => ({ status: 200, json: { text: "só texto" } }));
    const res = await make({}, http).transcribe({ data: Buffer.from("a"), mimeType: "audio/ogg" });
    expect(res.text).toBe("só texto");
    expect(res.usage.seconds).toBeUndefined();
  });

  it("resposta sem 'text' → TranscriptionError permanente", async () => {
    const { http } = fakeHttp(() => ({ status: 200, json: { duration: 1 } }));
    await expect(make({}, http).transcribe({ data: Buffer.from("a"), mimeType: "audio/ogg" })).rejects.toMatchObject({
      name: "TranscriptionError",
      transient: false,
    });
  });

  it("erro permanente (401) vira TranscriptionError tipado, sem retry", async () => {
    let n = 0;
    const { http } = fakeHttp(() => {
      n++;
      return { status: 401, json: { error: { message: "bad key" } } };
    });
    await expect(make({ maxAttempts: 3 }, http).transcribe({ data: Buffer.from("a"), mimeType: "audio/ogg" })).rejects.toMatchObject({
      name: "TranscriptionError",
      transient: false,
      status: 401,
    });
    expect(n).toBe(1);
    expect(TranscriptionError).toBeDefined();
  });

  it("erro transiente (503) faz retry e depois sucede", async () => {
    let n = 0;
    const { http } = fakeHttp(() => {
      n++;
      if (n === 1) return { status: 503, json: {} };
      return okJson("recuperado");
    });
    const res = await make({ maxAttempts: 3 }, http).transcribe({ data: Buffer.from("a"), mimeType: "audio/ogg" });
    expect(n).toBe(2);
    expect(res.text).toBe("recuperado");
  });

  it("413 (áudio grande) é permanente — não retenta indefinidamente", async () => {
    let n = 0;
    const { http } = fakeHttp(() => {
      n++;
      return { status: 413, json: { error: { message: "too large" } } };
    });
    await expect(make({ maxAttempts: 3 }, http).transcribe({ data: Buffer.from("a"), mimeType: "audio/ogg" })).rejects.toMatchObject({
      name: "TranscriptionError",
      status: 413,
      transient: false,
    });
    expect(n).toBe(1);
  });
});
