import { ProviderRegistry } from "@sdr/core";
import {
  OpenAiCompatTranscriptionProvider,
  type OpenAiCompatTranscriptionConfig,
} from "@sdr/transcription-openai-compat";

/** Token DI do registro de provedores de TRANSCRIÇÃO (composition root). */
export const TRANSCRIPTION_REGISTRY = "TRANSCRIPTION_REGISTRY";

/** Registra os adaptadores concretos de transcrição no ProviderRegistry agnóstico. */
export const transcriptionRegistryProvider = {
  provide: TRANSCRIPTION_REGISTRY,
  useFactory: (): ProviderRegistry => {
    const registry = new ProviderRegistry();
    registry.registerTranscription(
      "openai_compat",
      (cfg) => new OpenAiCompatTranscriptionProvider(cfg as unknown as OpenAiCompatTranscriptionConfig),
    );
    return registry;
  },
};
