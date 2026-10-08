import { Injectable } from "@nestjs/common";
import type { RetrievedChunk } from "@sdr/db";
import type { KnowledgeSource } from "../knowledge/knowledge-retriever.service";
import { NicheService } from "./niche.service";

/**
 * Fonte de conhecimento de NICHO para o retriever componível (ADR 0021). Somada
 * à lista de `sources` — o `KnowledgeRetriever` mescla por score. Mesma dimensão
 * (1024) do conhecimento do tenant, então os scores são comparáveis.
 */
@Injectable()
export class NicheKnowledgeSource implements KnowledgeSource {
  readonly id = "niche";

  constructor(private readonly niche: NicheService) {}

  async search(queryVector: number[], topK: number, minScore: number, queryText?: string): Promise<RetrievedChunk[]> {
    return this.niche.search(queryVector, topK, minScore, queryText);
  }
}
