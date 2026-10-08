import { Module } from "@nestjs/common";
import { embeddingRegistryProvider } from "./embeddings.registry";
import { EmbeddingService } from "./embedding.service";
import { KnowledgeIngestService } from "./knowledge-ingest.service";
import { KnowledgeRetriever, type KnowledgeSource } from "./knowledge-retriever.service";
import { KnowledgeQueue } from "./knowledge.queue";
import { KnowledgeController } from "./knowledge.controller";
import { NicheModule } from "../niche/niche.module";
import { NicheKnowledgeSource } from "../niche/niche-knowledge.source";

/**
 * Conhecimento / RAG (M5). Expõe EmbeddingService + KnowledgeRetriever (o M6
 * consome) e a ingestão assíncrona. A pipeline do M2 não muda. O retriever soma
 * a fonte de NICHO (M9) à lista de fontes — composição, sem refatorar o agente.
 */
@Module({
  imports: [NicheModule],
  controllers: [KnowledgeController],
  providers: [
    embeddingRegistryProvider,
    EmbeddingService,
    KnowledgeIngestService,
    KnowledgeQueue,
    {
      provide: KnowledgeRetriever,
      inject: [EmbeddingService, NicheKnowledgeSource],
      useFactory: (embeddings: EmbeddingService, niche: NicheKnowledgeSource) =>
        new KnowledgeRetriever(embeddings, [niche as KnowledgeSource]),
    },
  ],
  exports: [EmbeddingService, KnowledgeRetriever],
})
export class KnowledgeModule {}
