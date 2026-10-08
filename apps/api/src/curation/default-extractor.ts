import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import { LlmError, ProviderRegistry } from "@sdr/core";
import { recordPlatformUsage } from "@sdr/db";
import { costMicros, DEFAULT_PRICING } from "@sdr/llm-router";
import { APP_CONFIG } from "../config/config.module";
import { LLM_REGISTRY } from "../llm/llm.registry";
import type { InsightExtractor } from "./mining.service";

const ALLOWED = ["objection_handling", "qualifying_question", "vocabulary", "faq", "document_request"];

const SYSTEM =
  "Você analisa uma transcrição de atendimento de vendas (SDR) que CONVERTEU e " +
  "extrai NO MÁXIMO UM padrão GENERALIZÁVEL e reutilizável para o segmento — nunca " +
  "verbatim, nunca dados específicos. PROIBIDO incluir qualquer dado pessoal, nome, " +
  "telefone, e-mail, CPF/CNPJ, preço ou marca. Se não houver padrão claro e seguro, " +
  'responda exatamente "NONE". Senão responda em JSON: ' +
  '{"type":"<objection_handling|qualifying_question|vocabulary|faq|document_request>","content":"<padrão generalizado>"}.';

/**
 * Extrator default — usa o LLM de PLATAFORMA (não o do tenant; custo da
 * plataforma). Sem chave de plataforma → não minera (retorna null). Conservador.
 */
@Injectable()
export class DefaultInsightExtractor implements InsightExtractor {
  private readonly logger = new Logger(DefaultInsightExtractor.name);

  constructor(
    @Inject(LLM_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async extract(transcript: string): Promise<{ candidateType: string; content: string } | null> {
    const apiKey = this.cfg.llm.anthropicApiKey;
    if (!apiKey) return null; // sem provedor de plataforma → mineração desligada
    const model = this.cfg.llm.defaultModels[0] ?? "claude-haiku-4-5";
    const provider = this.registry.llmFor({
      channelAdapter: "",
      channelConfig: {},
      llmAdapter: "anthropic",
      llmConfig: { apiKey },
    });
    try {
      const res = await provider.complete({
        model,
        maxTokens: 400,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: transcript.slice(0, 8000) },
        ],
      });
      await recordPlatformUsage({
        type: "curation_llm",
        tokensIn: res.usage.tokensIn,
        tokensOut: res.usage.tokensOut,
        costMicros: costMicros(model, res.usage, DEFAULT_PRICING),
        metadata: { model },
      });
      return parseInsight(res.content);
    } catch (err) {
      if (err instanceof LlmError) {
        this.logger.warn(`Extração de insight falhou: ${err.message}`);
        return null;
      }
      throw err;
    }
  }
}

function parseInsight(text: string): { candidateType: string; content: string } | null {
  const t = text.trim();
  if (!t || /^none$/i.test(t)) return null;
  const match = t.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { type?: unknown; content?: unknown };
    const type = String(obj.type ?? "");
    const content = String(obj.content ?? "").trim();
    if (!ALLOWED.includes(type) || !content) return null;
    return { candidateType: type, content };
  } catch {
    return null;
  }
}
