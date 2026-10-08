import { Injectable, Logger } from "@nestjs/common";
import { runWithTenant } from "@sdr/core";
import {
  findSourceByRef,
  listSourceChunkContents,
  markSourceFailed,
  replaceSourceChunks,
  upsertKnowledgeSource,
  type ChunkInput,
  type KnowledgeSourceKind,
} from "@sdr/db";
import { EmbeddingService } from "./embedding.service";
import { chunkText, contentHash, estimateTokens } from "./chunking";

export interface IngestJob {
  tenantId: string;
  externalRef: string;
  kind: KnowledgeSourceKind;
  title: string;
  content: string;
}

export interface ReindexJob {
  tenantId: string;
  externalRef: string;
}

/**
 * Lógica de ingestão/reindex (pura e testável — a fila BullMQ apenas a invoca).
 * Tudo roda no contexto do tenant do job. Idempotente: se o conteúdo não mudou
 * (mesmo content_hash, fonte já 'ready'), não re-embeda.
 */
@Injectable()
export class KnowledgeIngestService {
  private readonly logger = new Logger(KnowledgeIngestService.name);

  constructor(private readonly embeddings: EmbeddingService) {}

  async ingest(job: IngestJob): Promise<{ ingested: boolean }> {
    return runWithTenant({ tenantId: job.tenantId }, async () => {
      const hash = contentHash(job.content);
      const { sourceId, changed } = await upsertKnowledgeSource({
        externalRef: job.externalRef,
        kind: job.kind,
        title: job.title,
        contentHash: hash,
        embeddingModel: this.embeddings.model,
      });
      if (!changed) {
        this.logger.log(`Fonte ${job.externalRef} inalterada — ingestão pulada (idempotente).`);
        return { ingested: false };
      }
      try {
        const pieces = chunkText(job.content);
        const { vectors, model } = await this.embeddings.embed(pieces, "ingest");
        const chunks: ChunkInput[] = pieces.map((content, i) => ({
          ordinal: i,
          content,
          embedding: vectors[i]!,
          tokenCount: estimateTokens(content),
          embeddingModel: model,
        }));
        // guarda contra corrida: só grava se o content_hash ainda for o nosso.
        const applied = await replaceSourceChunks(sourceId, chunks, hash);
        this.logger.log(
          applied
            ? `Fonte ${job.externalRef} ingerida: ${chunks.length} chunks.`
            : `Fonte ${job.externalRef} assumida por outra ingestão — pulada.`,
        );
        return { ingested: applied };
      } catch (err) {
        await markSourceFailed(sourceId);
        throw err;
      }
    });
  }

  /** Re-embeda os chunks existentes de uma fonte (ex.: troca de modelo). */
  async reindex(job: ReindexJob): Promise<{ reindexed: boolean }> {
    return runWithTenant({ tenantId: job.tenantId }, async () => {
      const source = await findSourceByRef(job.externalRef);
      if (!source) {
        this.logger.warn(`Reindex: fonte ${job.externalRef} não encontrada.`);
        return { reindexed: false };
      }
      const existing = await listSourceChunkContents(source.sourceId);
      if (existing.length === 0) return { reindexed: false };
      try {
        const { vectors, model } = await this.embeddings.embed(existing.map((c) => c.content));
        const chunks: ChunkInput[] = existing.map((c, i) => ({
          ordinal: c.ordinal,
          content: c.content,
          embedding: vectors[i]!,
          tokenCount: estimateTokens(c.content),
          embeddingModel: model,
        }));
        await replaceSourceChunks(source.sourceId, chunks);
        this.logger.log(`Fonte ${job.externalRef} reindexada: ${chunks.length} chunks.`);
        return { reindexed: true };
      } catch (err) {
        await markSourceFailed(source.sourceId);
        throw err;
      }
    });
  }
}
