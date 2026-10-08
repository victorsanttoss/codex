import { Module } from "@nestjs/common";
import { transcriptionRegistryProvider } from "./transcription.registry";
import { TranscriptionService } from "./transcription.service";
import { AudioEnrichmentService } from "./audio-enrichment.service";

/**
 * Transcrição / speech-to-text (M12). Expõe o AudioEnrichmentService que a
 * pipeline do M2 consome para enriquecer áudio inbound com texto — sem mudar o
 * loop do agente (M6). O TranscriptionService resolve provedor/chave por tenant.
 */
@Module({
  providers: [transcriptionRegistryProvider, TranscriptionService, AudioEnrichmentService],
  exports: [AudioEnrichmentService, TranscriptionService],
})
export class TranscriptionModule {}
