import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import { getTranscriptionByMedia, recordUsage, saveTranscription } from "@sdr/db";
import { APP_CONFIG } from "../config/config.module";
import { TranscriptionService } from "./transcription.service";

/** Áudio já baixado (M2) pronto para enriquecimento. */
export interface DownloadedAudio {
  mediaObjectId: string;
  providerMediaId: string;
  buffer: Buffer;
  mimeType: string;
}

/**
 * Passo de ENRIQUECIMENTO: áudio inbound → transcrição → texto p/ o loop do M6.
 * Robustez:
 *  - desligável por config (`enabled=false`) → cai na política não-texto do M6;
 *  - IDEMPOTENTE: cache por provider_media_id (retry não re-transcreve/re-cobra);
 *  - teto de TAMANHO pré-cobrança (freio de custo principal numa VPS);
 *  - teto de DURAÇÃO pós-transcrição (não injeta áudio longo demais no agente),
 *    avaliado também no cache-hit p/ ser consistente entre retries;
 *  - falha do provedor → null (graceful), SEM cachear (permite novo retry).
 * O custo da transcrição é metrado pelo TranscriptionService; o teto de custo por
 * conversa do M6 segue aplicado, intacto, ao turno do LLM (que recebe só texto).
 */
@Injectable()
export class AudioEnrichmentService {
  private readonly logger = new Logger(AudioEnrichmentService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly transcription: TranscriptionService,
  ) {}

  /** Transcreve (ou reaproveita cache) e devolve o texto, ou null p/ graceful. */
  async transcribeInbound(audio: DownloadedAudio): Promise<string | null> {
    const t = this.cfg.transcription;
    if (!t.enabled) return null;

    // 1) Cache (idempotência): retry do mesmo áudio não re-transcreve nem re-cobra.
    const cached = await getTranscriptionByMedia(audio.providerMediaId);
    if (cached) return this.withinDuration(cached.seconds) ? cached.text : null;

    // 2) Teto de tamanho PRÉ-cobrança: bytes além do limite não são transcritos.
    if (audio.buffer.length > t.maxBytes) {
      this.logger.warn(
        `Áudio ${audio.providerMediaId} excede ${t.maxBytes} bytes — transcrição pulada (graceful).`,
      );
      return null;
    }

    // 3) Transcrição (calcula custo, NÃO mede ainda). Falha → graceful, sem cache.
    let text: string;
    let seconds: number | null;
    let costMicros: number;
    let model: string;
    let provider: string;
    try {
      const res = await this.transcription.transcribe(audio.buffer, audio.mimeType);
      text = res.text;
      seconds = res.seconds;
      costMicros = res.costMicros;
      model = res.model;
      provider = res.provider;
    } catch (err) {
      // Categoria segura — nunca logar bytes/segredo do provedor.
      this.logger.warn(
        `Transcrição falhou p/ ${audio.providerMediaId}: ${err instanceof Error ? err.message : "erro"} — graceful.`,
      );
      return null;
    }

    // 4) Persiste o cache PRIMEIRO (durável) e SÓ ENTÃO mede — assim um crash entre
    //    transcrever e cachear não causa recobrança no retry (no pior caso, uma
    //    subcobrança única, preferível a cobrar duas vezes).
    await saveTranscription(audio.mediaObjectId, text, seconds, new Date());
    await recordUsage({
      type: "transcription",
      model,
      costMicros,
      metadata: { provider, ...(seconds != null ? { seconds } : { secondsMissing: true }) },
    });

    // 5) Teto de duração PÓS-transcrição: áudio longo demais não entra no agente.
    if (!this.withinDuration(seconds)) {
      this.logger.warn(
        `Áudio ${audio.providerMediaId} com ${seconds}s acima de ${this.cfg.transcription.maxDurationSeconds}s — não injetado.`,
      );
      return null;
    }
    return text;
  }

  private withinDuration(seconds: number | null): boolean {
    return seconds == null || seconds <= this.cfg.transcription.maxDurationSeconds;
  }
}
