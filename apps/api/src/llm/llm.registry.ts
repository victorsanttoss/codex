import { ProviderRegistry } from "@sdr/core";
import { AnthropicLLMProvider, type AnthropicAdapterConfig } from "@sdr/llm-anthropic";
import { OpenAiCompatProvider, type OpenAiCompatConfig } from "@sdr/llm-openai-compat";

/** Token DI do registro de provedores de LLM (composition root). */
export const LLM_REGISTRY = "LLM_REGISTRY";

/** Registra os adaptadores concretos no ProviderRegistry agnóstico do core. */
export const llmRegistryProvider = {
  provide: LLM_REGISTRY,
  useFactory: (): ProviderRegistry => {
    const registry = new ProviderRegistry();
    registry.registerLLM("anthropic", (cfg) => new AnthropicLLMProvider(cfg as AnthropicAdapterConfig));
    registry.registerLLM(
      "openai_compat",
      (cfg) => new OpenAiCompatProvider(cfg as unknown as OpenAiCompatConfig),
    );
    return registry;
  },
};
