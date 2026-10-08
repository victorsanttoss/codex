import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import { ProviderRegistry, requireTenantContext, type TranscriptionProvider } from "@sdr/core";
import { makeCipherFromEnv, TenantSecretsStore } from "@sdr/db";
import { DEFAULT_TRANSCRIPTION_PRICING, transcriptionCostMicros } from "@sdr/llm-router";
import { APP_CONFIG } from "../config/config.module";
import { TRANSCRIPTION_REGISTRY } from "./transcription.registry";

export interface TranscribeOutcome {
  text: string;
  /** Duração arredondada para segundos inteiros (casa com a coluna integer). */
  seconds: number | null;
  model: string;
  provider: string;
  /** Custo em micros (USD), fail-closed. Quem chama mede APÓS cachear (ordem importa). */
  costMicros: number;
}

/**
 * Serviço de transcrição (STT) por tenant. Resolve a chave (tenant:
 * transcription_api_key → llm_api_key; senão plataforma; Whisper self-hosted pode
 * não ter), monta o adaptador openai-compatible e grava metering (type
 * 'transcription', fail-closed de preço por minuto). Espelha o EmbeddingService.
 */
@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  constructor(
    @Inject(TRANSCRIPTION_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get model(): string {
    return this.cfg.transcription.defaultModel;
  }

  private async providerForTenant(): Promise<TranscriptionProvider> {
    requireTenantContext();
    const store = new TenantSecretsStore(makeCipherFromEnv());
    // self-hosted pode não ter chave — apiKey é opcional (adapter omite Bearer).
    const apiKey =
      (await store.get("transcription_api_key")) ??
      (await store.get("llm_api_key")) ??
      this.cfg.transcription.apiKey;
    return this.registry.transcriptionFor({
      transcriptionAdapter: "openai_compat",
      transcriptionConfig: {
        baseURL: this.cfg.transcription.baseURL,
        model: this.cfg.transcription.defaultModel,
        defaultLanguage: this.cfg.transcription.languageHint,
        ...(apiKey ? { apiKey } : {}),
      },
    });
  }

  /**
   * Transcreve um áudio no contexto do tenant e CALCULA o custo (por minuto,
   * fail-closed) — mas NÃO grava metering: quem chama (enriquecimento) mede só
   * APÓS persistir o cache, para que um crash entre transcrever e cachear não
   * leve a recobrança no retry. Erros do provedor sobem como `TranscriptionError`.
   */
  async transcribe(data: Buffer, mimeType: string): Promise<TranscribeOutcome> {
    const provider = await this.providerForTenant();
    const res = await provider.transcribe({
      data,
      mimeType,
      languageHint: this.cfg.transcription.languageHint,
    });
    // Segundos inteiros (casa com a coluna integer; evita falha de insert pós-cobrança).
    const seconds = res.usage.seconds != null ? Math.round(res.usage.seconds) : null;
    // Fail-closed de duração: modelo PAGO sem duração reportada cobra pelo TETO
    // (nunca subcobra), nunca 0 silencioso. Self-hosted ({perMinute:0}) cobra 0.
    // Modelo sem preço cadastrado faz transcriptionCostMicros LANÇAR (fail-closed).
    let billedSeconds = seconds;
    if (billedSeconds == null) {
      const perMinute = DEFAULT_TRANSCRIPTION_PRICING[this.model]?.perMinute ?? 0;
      billedSeconds = perMinute > 0 ? this.cfg.transcription.maxDurationSeconds : 0;
      if (perMinute > 0) {
        this.logger.warn(
          `Transcrição sem duração (modelo pago ${this.model}) — cobrando pelo teto ${billedSeconds}s.`,
        );
      }
    }
    const costMicros = transcriptionCostMicros(this.model, billedSeconds, DEFAULT_TRANSCRIPTION_PRICING);
    return { text: res.text, seconds, model: this.model, provider: provider.id, costMicros };
  }
}
