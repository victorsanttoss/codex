import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import { ProviderRegistry, requireTenantContext, type CompletionRequest } from "@sdr/core";
import { makeCipherFromEnv, recordUsage, TenantSecretsStore } from "@sdr/db";
import { DEFAULT_PRICING, hasPrice, LlmRouter, type Pricing, type RouteOutcome } from "@sdr/llm-router";
import { APP_CONFIG } from "../config/config.module";
import { LLM_REGISTRY } from "./llm.registry";

/** Heurística p/ PRICING (não é fronteira de segurança): host loopback/privado
 * ou .local/.internal = self-hosted → modelo aberto entra grátis ({0,0}). */
function isSelfHostedBaseURL(baseURL: string): boolean {
  try {
    const h = new URL(baseURL).hostname;
    return (
      h === "localhost" ||
      h === "::1" ||
      h === "0.0.0.0" ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h) ||
      h.endsWith(".local") ||
      h.endsWith(".internal")
    );
  } catch {
    return false;
  }
}

/**
 * Serviço de LLM por tenant. Monta um LlmRouter (custo/fallback) com a chave do
 * tenant (BYO, cifrada) ou a da plataforma (fallback), e grava metering por
 * chamada. O agente (M6) consome isto. A pipeline do M2 não muda.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    @Inject(LLM_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Roteador para o tenant ATIVO (chave do tenant ou da plataforma). */
  async routerForTenant(): Promise<LlmRouter> {
    requireTenantContext();

    // Override OpenAI-compatible (self-hosted vLLM/Ollama OU provedor por token):
    // quando `openaiBaseURL` está setado, o agente roteia para este provedor em vez
    // do Anthropic. Self-hosted entra com preço {0,0} (fail-closed do roteador).
    const openaiBaseURL = this.cfg.llm.openaiBaseURL;
    let provider;
    let pricing: Pricing | undefined;
    if (openaiBaseURL) {
      provider = this.registry.llmFor({
        channelAdapter: "",
        channelConfig: {},
        llmAdapter: "openai_compat",
        llmConfig: { baseURL: openaiBaseURL, apiKey: this.cfg.llm.openaiApiKey },
      });
      // Modelo COM preço no catálogo (ex.: gpt-*) cobra de verdade — o branch
      // openai-compat também atende provedor pago. O {0,0} automático vale SÓ
      // para baseURL self-hosted/local (qwen, llama…): em provedor remoto, um
      // modelo fora do catálogo (alias/snapshot tipo gpt-4o-2024-08-06) fica
      // SEM preço e o costMicros lança (fail-closed) — grátis silencioso
      // burlaria o teto de custo diário do tenant.
      pricing = {
        ...DEFAULT_PRICING,
        ...(isSelfHostedBaseURL(openaiBaseURL)
          ? Object.fromEntries(
              this.cfg.llm.defaultModels
                .filter((m) => !hasPrice(m, DEFAULT_PRICING))
                .map((m) => [m, { input: 0, output: 0 }]),
            )
          : {}),
      };
    } else {
      const tenantKey = await new TenantSecretsStore(makeCipherFromEnv()).get("llm_api_key");
      const apiKey = tenantKey ?? this.cfg.llm.anthropicApiKey;
      if (!apiKey) throw new Error("Sem chave de LLM (nem do tenant, nem da plataforma).");
      provider = this.registry.llmFor({
        channelAdapter: "",
        channelConfig: {},
        llmAdapter: "anthropic",
        llmConfig: { apiKey },
      });
    }
    const candidates = this.cfg.llm.defaultModels.map((model) => ({ provider, model }));

    return new LlmRouter(candidates, {
      ...(pricing ? { pricing } : {}),
      // Metering é BEST-EFFORT e fora do caminho crítico da resposta: não
      // aguardamos o insert (fire-and-forget com log). O contexto de tenant
      // (AsyncLocalStorage) propaga para a continuação normalmente.
      onUsage: (u) => {
        void recordUsage({
          type: "llm_call",
          model: u.model,
          tokensIn: u.usage.tokensIn,
          tokensOut: u.usage.tokensOut,
          costMicros: u.costMicros,
          metadata: { provider: u.providerId },
        }).catch((err) =>
          this.logger.warn(`recordUsage(llm_call) falhou: ${err instanceof Error ? err.message : err}`),
        );
      },
    });
  }

  /** Conveniência: roteia + completa (no contexto do tenant ativo). */
  async complete(req: Omit<CompletionRequest, "model">): Promise<RouteOutcome> {
    return (await this.routerForTenant()).complete(req);
  }
}
