import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@sdr/config";
import { AudioEnrichmentService, type DownloadedAudio } from "./audio-enrichment.service";
import type { TranscriptionService } from "./transcription.service";

// Mocka os repos de cache do @sdr/db (sem banco). Cada teste configura o retorno.
const getTranscriptionByMedia = vi.fn();
const saveTranscription = vi.fn();
const recordUsage = vi.fn();
vi.mock("@sdr/db", () => ({
  getTranscriptionByMedia: (...a: unknown[]) => getTranscriptionByMedia(...a),
  saveTranscription: (...a: unknown[]) => saveTranscription(...a),
  recordUsage: (...a: unknown[]) => recordUsage(...a),
}));

function cfg(over: Partial<AppConfig["transcription"]> = {}): AppConfig {
  return {
    transcription: {
      enabled: true,
      baseURL: "http://stt.local/v1",
      defaultModel: "whisper-1",
      languageHint: "pt",
      maxDurationSeconds: 300,
      maxBytes: 1000,
      ...over,
    },
  } as unknown as AppConfig;
}

function audioOf(bytes: number): DownloadedAudio {
  return {
    mediaObjectId: "mo-1",
    providerMediaId: "AUD1",
    buffer: Buffer.alloc(bytes, 1),
    mimeType: "audio/ogg",
  };
}

function svc(config: AppConfig, transcribe: TranscriptionService["transcribe"]) {
  const transcription = { transcribe } as unknown as TranscriptionService;
  return new AudioEnrichmentService(config, transcription);
}

function outcome(over: Record<string, unknown> = {}) {
  return { text: "olá", seconds: 5, model: "whisper-1", provider: "openai_compat", costMicros: 500, ...over };
}

afterEach(() => {
  getTranscriptionByMedia.mockReset();
  saveTranscription.mockReset();
  recordUsage.mockReset();
});

describe("AudioEnrichmentService", () => {
  it("desligado por config → null (sem tocar cache nem provedor)", async () => {
    const transcribe = vi.fn();
    const out = await svc(cfg({ enabled: false }), transcribe).transcribeInbound(audioOf(10));
    expect(out).toBeNull();
    expect(getTranscriptionByMedia).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("cache hit → devolve texto sem transcrever (idempotência, sem nova cobrança)", async () => {
    getTranscriptionByMedia.mockResolvedValue({ text: "do cache", seconds: 3 });
    const transcribe = vi.fn();
    const out = await svc(cfg(), transcribe).transcribeInbound(audioOf(10));
    expect(out).toBe("do cache");
    expect(transcribe).not.toHaveBeenCalled();
    expect(saveTranscription).not.toHaveBeenCalled();
  });

  it("cache hit acima do limite de duração → null (consistente entre retries)", async () => {
    getTranscriptionByMedia.mockResolvedValue({ text: "longo", seconds: 999 });
    const out = await svc(cfg({ maxDurationSeconds: 60 }), vi.fn()).transcribeInbound(audioOf(10));
    expect(out).toBeNull();
  });

  it("tamanho acima do limite → null SEM transcrever (freio de custo pré-cobrança)", async () => {
    getTranscriptionByMedia.mockResolvedValue(null);
    const transcribe = vi.fn();
    const out = await svc(cfg({ maxBytes: 100 }), transcribe).transcribeInbound(audioOf(200));
    expect(out).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("sucesso → persiste cache ANTES de medir, e devolve o texto", async () => {
    getTranscriptionByMedia.mockResolvedValue(null);
    const transcribe = vi.fn().mockResolvedValue(outcome({ text: "olá", seconds: 5 }));
    const order: string[] = [];
    saveTranscription.mockImplementation(async () => void order.push("save"));
    recordUsage.mockImplementation(async () => void order.push("meter"));
    const out = await svc(cfg(), transcribe).transcribeInbound(audioOf(10));
    expect(out).toBe("olá");
    expect(saveTranscription).toHaveBeenCalledWith("mo-1", "olá", 5, expect.any(Date));
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "transcription", costMicros: 500 }),
    );
    expect(order).toEqual(["save", "meter"]); // cache durável antes da cobrança
  });

  it("transcrito mas longo demais → persiste (cache) porém NÃO injeta (null)", async () => {
    getTranscriptionByMedia.mockResolvedValue(null);
    const transcribe = vi.fn().mockResolvedValue(outcome({ text: "ramble", seconds: 600 }));
    const out = await svc(cfg({ maxDurationSeconds: 60 }), transcribe).transcribeInbound(audioOf(10));
    expect(out).toBeNull();
    expect(saveTranscription).toHaveBeenCalled();
  });

  it("falha do provedor → null (graceful) e NÃO cacheia/mede (permite retry)", async () => {
    getTranscriptionByMedia.mockResolvedValue(null);
    const transcribe = vi.fn().mockRejectedValue(new Error("Transcrição: rate limit"));
    const out = await svc(cfg(), transcribe).transcribeInbound(audioOf(10));
    expect(out).toBeNull();
    expect(saveTranscription).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
