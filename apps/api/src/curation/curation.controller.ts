import { Body, Controller, Get, Logger, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { runWithTenant } from "@sdr/core";
import { type AuditEntry, assignTenantNiche, createNiche, insertAuditLog, listCandidates } from "@sdr/db";
import { Public } from "../auth/decorators";
import { type ActingStaff, PlatformStaffGuard, RequireStaffRole, Staff } from "../platform/platform-staff.guard";
import { invalidateAgentConfigCache } from "../agent/agent-config";
import { invalidateNicheCache } from "../niche/niche.service";
import { CurationService } from "./curation.service";
import { CurationMiningService } from "./mining.service";

/**
 * Auditoria BEST-EFFORT pós-ação: a ação sensível já foi confirmada no banco
 * (transação do service). Uma falha ao gravar a trilha NÃO deve mascarar como erro
 * uma ação bem-sucedida — logamos um warning e seguimos (RLS já corrigida em 0026,
 * então falha aqui é rara: só indisponibilidade de banco).
 */
async function auditBestEffort(logger: Logger, entry: AuditEntry): Promise<void> {
  try {
    await insertAuditLog(entry);
  } catch (e) {
    logger.warn(`audit_log falhou (${entry.action} ${entry.target}): ${(e as Error).message}`);
  }
}

class CreateNicheDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) vertical!: string;
  @IsString() @MinLength(1) motion!: string;
  @IsOptional() @IsString() @MaxLength(4000) guidance?: string;
}
class AssignDto {
  @IsString() @MinLength(1) nicheId!: string;
}
class CandidateDto {
  @IsIn(["objection_handling", "qualifying_question", "vocabulary", "faq", "document_request"]) candidateType!: string;
  @IsString() @MinLength(1) @MaxLength(8000) content!: string;
}
class ReviewDto {
  @IsOptional() @IsString() @MaxLength(8000) content?: string;
}

/**
 * Curadoria / nicho — STAFF DE PLATAFORMA (não tenant). `@Public()` pula o JWT;
 * `PlatformStaffGuard` resolve a IDENTIDADE por-staff (token pessoal) e enforça o
 * papel. A curadoria humana acontece aqui: quem aprova é o staff autenticado
 * (`@Staff()`), não um id auto-declarado — e cada ação vai para o audit_log.
 */
@Public()
// ThrottlerGuard também aqui (achado Codex): sem ele, brute-force do
// x-platform-token nestes endpoints /platform/... ficava sem rate-limit.
@UseGuards(ThrottlerGuard, PlatformStaffGuard)
@RequireStaffRole("curator") // default do controller: curador (admin passa; support não)
@Controller("platform")
export class CurationController {
  private readonly logger = new Logger(CurationController.name);
  constructor(
    private readonly curation: CurationService,
    private readonly mining: CurationMiningService,
  ) {}

  // Gestão ESTRUTURAL (criar nicho, atribuir nicho a tenant) exige ADMIN — não é
  // curadoria de conteúdo. O metadata por-handler sobrescreve o default do controller.
  @Post("niches")
  @RequireStaffRole("admin")
  createNiche(@Body() dto: CreateNicheDto) {
    return createNiche(dto);
  }

  @Post("tenants/:tenantId/niche")
  @RequireStaffRole("admin")
  async assign(@Param("tenantId") tenantId: string, @Body() dto: AssignDto): Promise<{ ok: true }> {
    await runWithTenant({ tenantId }, () => assignTenantNiche(dto.nicheId));
    // caches in-process (nicho + config resolvida usam o nicho) — invalida já.
    invalidateNicheCache(tenantId);
    invalidateAgentConfigCache(tenantId);
    return { ok: true };
  }

  @Get("niches/:nicheId/candidates")
  list(@Param("nicheId") nicheId: string, @Query("status") status?: string) {
    return listCandidates(nicheId, status);
  }

  @Post("niches/:nicheId/candidates")
  createCandidate(@Param("nicheId") nicheId: string, @Body() dto: CandidateDto) {
    return this.curation.createCandidate(nicheId, { candidateType: dto.candidateType, content: dto.content });
  }

  @Post("niches/:nicheId/candidates/:id/approve")
  async approve(
    @Param("nicheId") nicheId: string,
    @Param("id") id: string,
    @Body() dto: ReviewDto,
    @Staff() staff: ActingStaff,
  ): Promise<{ ok: true }> {
    await this.curation.approve(nicheId, id, staff.id, dto.content);
    await auditBestEffort(this.logger, {
      actor: staff.id,
      action: "curation.approve",
      target: id,
      metadata: { nicheId, staffEmail: staff.email, edited: dto.content != null },
    });
    return { ok: true };
  }

  @Post("niches/:nicheId/candidates/:id/reject")
  async reject(
    @Param("nicheId") nicheId: string,
    @Param("id") id: string,
    @Staff() staff: ActingStaff,
  ): Promise<{ ok: true }> {
    await this.curation.reject(nicheId, id, staff.id);
    await auditBestEffort(this.logger, { actor: staff.id, action: "curation.reject", target: id, metadata: { nicheId, staffEmail: staff.email } });
    return { ok: true };
  }

  @Post("niches/:nicheId/candidates/:id/promote")
  async promote(@Param("nicheId") nicheId: string, @Param("id") id: string, @Staff() staff: ActingStaff) {
    const res = await this.curation.promote(nicheId, id);
    await auditBestEffort(this.logger, { actor: staff.id, action: "curation.promote", target: id, metadata: { nicheId, staffEmail: staff.email } });
    return res;
  }

  @Post("niches/:nicheId/mine/:tenantId")
  mine(@Param("nicheId") nicheId: string, @Param("tenantId") tenantId: string) {
    return this.mining.mineTenant(nicheId, tenantId);
  }
}
