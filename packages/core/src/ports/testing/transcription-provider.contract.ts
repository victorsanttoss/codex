import { describe, expect, it } from "vitest";
import type { TranscriptionProvider } from "../transcription-provider";

/**
 * Suíte de contrato REUTILIZÁVEL para `TranscriptionProvider`. Garante que
 * qualquer adaptador devolva texto (string) e uso para metering, e que aceite o
 * formato OGG/Opus do WhatsApp. Exercitada com o `FakeTranscriptionProvider` e
 * por cada adaptador concreto (com HTTP mockado — sem rede real).
 */
export function runTranscriptionProviderContract(
  name: string,
  makeProvider: () => TranscriptionProvider,
): void {
  describe(`TranscriptionProvider contract :: ${name}`, () => {
    it("transcribe() devolve texto (string) e uso", async () => {
      const p = makeProvider();
      const res = await p.transcribe({
        data: Buffer.from("ogg-fake-bytes"),
        mimeType: "audio/ogg",
        languageHint: "pt",
      });
      expect(typeof res.text).toBe("string");
      expect(res.usage).toBeTypeOf("object");
    });

    it("transcribe() reporta uso não-negativo quando presente", async () => {
      const p = makeProvider();
      const res = await p.transcribe({ data: Buffer.from("audio"), mimeType: "audio/ogg" });
      if (res.usage.seconds !== undefined) expect(res.usage.seconds).toBeGreaterThanOrEqual(0);
      if (res.usage.tokensOut !== undefined) expect(res.usage.tokensOut).toBeGreaterThanOrEqual(0);
    });

    it("transcribe() expõe um id estável", () => {
      const p = makeProvider();
      expect(typeof p.id).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
    });
  });
}
