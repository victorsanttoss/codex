import { Module } from "@nestjs/common";
import { embeddingRegistryProvider } from "../knowledge/embeddings.registry";
import { llmRegistryProvider } from "../llm/llm.registry";
import { AnonymizationService } from "./anonymization.service";
import { CurationService } from "./curation.service";
import { CurationMiningService, INSIGHT_EXTRACTOR } from "./mining.service";
import { DefaultInsightExtractor } from "./default-extractor";
import { CurationController } from "./curation.controller";
import { PlatformStaffGuard } from "../platform/platform-staff.guard";

/**
 * Loop de curadoria (M9, produção). Storage de nicho + candidatos via @sdr/db;
 * embeddings/LLM de PLATAFORMA (custo da plataforma). Curadoria humana obrigatória.
 */
@Module({
  controllers: [CurationController],
  providers: [
    embeddingRegistryProvider,
    llmRegistryProvider,
    AnonymizationService,
    CurationService,
    DefaultInsightExtractor,
    PlatformStaffGuard,
    { provide: INSIGHT_EXTRACTOR, useExisting: DefaultInsightExtractor },
    {
      provide: CurationMiningService,
      inject: [CurationService, INSIGHT_EXTRACTOR],
      useFactory: (curation: CurationService, extractor: DefaultInsightExtractor) =>
        new CurationMiningService(curation, extractor),
    },
  ],
})
export class CurationModule {}
