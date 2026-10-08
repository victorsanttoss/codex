import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post } from "@nestjs/common";
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { requireTenantContext } from "@sdr/core";
import { deleteKnowledgeSource, listKnowledgeSources, type KnowledgeSourceRow, type RetrievedChunk } from "@sdr/db";
import { Roles } from "../auth/roles";
import { normalizeContent } from "./chunking";
import { KnowledgeQueue } from "./knowledge.queue";
import { KnowledgeRetriever } from "./knowledge-retriever.service";

export class IngestDto {
  @IsString()
  @MinLength(1)
  externalRef!: string;

  @IsIn(["faq", "doc", "text"])
  kind!: "faq" | "doc" | "text";

  @IsString()
  @MinLength(1)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1_000_000)
  content!: string;
}

export class SearchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  query!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  topK?: number;

  @IsOptional()
  @IsNumber()
  @Min(-1)
  @Max(1)
  minScore?: number;
}

/**
 * Conhecimento do tenant (M5). Ingestão é ASSÍNCRONA (enfileira e responde
 * rápido); a busca é síncrona p/ ops/verificação (o M6 consome o
 * KnowledgeRetriever internamente). Requer papel admin; roda no contexto do
 * tenant ativo.
 */
@Controller("admin/knowledge")
export class KnowledgeController {
  constructor(
    private readonly queue: KnowledgeQueue,
    private readonly retriever: KnowledgeRetriever,
  ) {}

  /** Fontes do tenant com status/chunks — o cliente VÊ o que está na base. */
  @Roles("admin")
  @Get("sources")
  listSources(): Promise<KnowledgeSourceRow[]> {
    return listKnowledgeSources();
  }

  @Roles("admin")
  @Post("sources")
  async ingest(@Body() dto: IngestDto): Promise<{ queued: true }> {
    if (normalizeContent(dto.content).length === 0) {
      throw new BadRequestException("content vazio após normalização.");
    }
    const { tenantId } = requireTenantContext();
    await this.queue.enqueueIngest({
      tenantId,
      externalRef: dto.externalRef,
      kind: dto.kind,
      title: dto.title,
      content: dto.content,
    });
    return { queued: true };
  }

  /** Exclui a fonte + chunks — o RAG para de usar o material na hora. */
  @Roles("admin")
  @Delete("sources/:ref")
  async remove(@Param("ref") ref: string): Promise<{ deleted: true }> {
    const found = await deleteKnowledgeSource(ref);
    if (!found) throw new NotFoundException("Fonte não encontrada.");
    return { deleted: true };
  }

  @Roles("admin")
  @Post("sources/:ref/reindex")
  async reindex(@Param("ref") ref: string): Promise<{ queued: true }> {
    const { tenantId } = requireTenantContext();
    await this.queue.enqueueReindex({ tenantId, externalRef: ref });
    return { queued: true };
  }

  @Roles("agent")
  @Post("search")
  async search(@Body() dto: SearchDto): Promise<{ hits: RetrievedChunk[] }> {
    const hits = await this.retriever.search(dto.query, {
      ...(dto.topK !== undefined ? { topK: dto.topK } : {}),
      ...(dto.minScore !== undefined ? { minScore: dto.minScore } : {}),
    });
    return { hits };
  }
}
