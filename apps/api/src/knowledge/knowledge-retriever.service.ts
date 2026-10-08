import { Injectable } from "@nestjs/common";
import { searchKnowledgeChunks, type RetrievedChunk } from "@sdr/db";
import { EmbeddingService } from "./embedding.service";

export interface RetrieveOptions {
  topK?: number;
  minScore?: number;
}

/**
 * Uma FONTE de conhecimento consultável por vetor. Ciente de escopo e
 * COMPONÍVEL: o retriever consulta uma lista de fontes e mescla. No M5 só a
 * fonte do TENANT é registrada; base/nicho entram depois SEM mudar a assinatura
 * nem o chamador (ver ADR 0021). A fonte de nicho terá storage próprio — não se
 * mistura conteúdo compartilhado na tabela tenant-scoped.
 */
export interface KnowledgeSource {
  readonly id: string;
  /** `queryText` habilita a perna KEYWORD da busca híbrida (M5) na fonte. */
  search(queryVector: number[], topK: number, minScore: number, queryText?: string): Promise<RetrievedChunk[]>;
}

/** Fonte do TENANT ATIVO: busca híbrida nas tabelas tenant-scoped (isolado por RLS). */
export class TenantKnowledgeSource implements KnowledgeSource {
  readonly id = "tenant";
  async search(queryVector: number[], topK: number, minScore: number, queryText?: string): Promise<RetrievedChunk[]> {
    return searchKnowledgeChunks(queryVector, { topK, minScore, ...(queryText ? { queryText } : {}) });
  }
}

const DEFAULT_TOP_K = 5;

@Injectable()
export class KnowledgeRetriever {
  /** Fonte do tenant (M5) + fontes extras componíveis (ex.: nicho — M9). */
  private readonly sources: KnowledgeSource[];

  constructor(
    private readonly embeddings: EmbeddingService,
    extraSources: KnowledgeSource[] = [],
  ) {
    this.sources = [new TenantKnowledgeSource(), ...extraSources];
  }

  /**
   * Recupera trechos relevantes p/ `query` no contexto do tenant ativo: embeda a
   * query, consulta todas as fontes (HÍBRIDO: vetor + keyword — o texto da query
   * vai junto p/ a perna FTS de cada fonte), mescla por score (desc) e corta em
   * topK. Scores seguem sendo cosseno em todas as fontes (ADR 0021).
   */
  async search(query: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
    const topK = Math.max(1, Math.floor(opts.topK ?? DEFAULT_TOP_K));
    const minScore = opts.minScore ?? -1;
    const { vectors } = await this.embeddings.embed([query], "retrieval");
    const qv = vectors[0];
    if (!qv) return [];
    const perSource = await Promise.all(this.sources.map((s) => s.search(qv, topK, minScore, query)));
    return perSource
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
