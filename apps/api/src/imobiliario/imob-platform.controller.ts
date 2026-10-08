import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { runWithTenant } from "@sdr/core";
import {
  getImobOverview,
  getNicheByName,
  isImobTenant,
  listImobAssignments,
  listImobBrokers,
  listImobEvents,
  listImobTenants,
  provisionImobTenant,
  assignTenantNiche,
} from "@sdr/db";
import { Public } from "../auth/decorators";
import { invalidateAgentConfigCache } from "../agent/agent-config";
import { invalidateNicheCache } from "../niche/niche.service";
import { PlatformStaffGuard, RequireStaffRole, Staff, type ActingStaff } from "../platform/platform-staff.guard";
import { KitApplierService } from "../verticals/kit-applier.service";
import { ALL_KITS, IMOB_KIT_BY_PADRAO } from "../verticals/kits";
import { IMOB_CONFIG } from "./imob.config";

/**
 * Autorização de leitura por tenant: env IMOB_PLATFORM_READ_TENANTS preenchida
 * = lista ESTRITA (modo trava); vazia = qualquer tenant da VERTICAL
 * imobiliária (self-service — a Central provisiona empreendimentos sem SSH).
 * Nunca é "qualquer tenant da plataforma": a vertical é checada no banco.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function assertTenantReadable(tenantId: string): Promise<void> {
  // UUID inválido → 403 direto (o cast no SQL viraria 500 e furaria o padrão
  // de resposta — achado Codex)
  if (!UUID_RE.test(tenantId)) throw new ForbiddenException("Tenant fora da allowlist de integração.");
  const allow = new Set(
    (process.env.IMOB_PLATFORM_READ_TENANTS ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allow.size > 0) {
    if (!allow.has(tenantId)) throw new ForbiddenException("Tenant fora da allowlist de integração.");
    return;
  }
  if (!(await isImobTenant(tenantId))) {
    throw new ForbiddenException("Tenant fora da allowlist de integração.");
  }
}

class ProvisionDto {
  // ValidationPipe global tem whitelist:true — campos SEM decorator são
  // descartados do body. Contrato HTTP forte (achado Codex); o
  // provisionImobTenant re-valida (defense-in-depth).
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsString()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/, { message: "slug inválido (minúsculas/números/hífens, 3-48)" })
  slug?: string;

  @IsEmail({}, { message: "ownerEmail inválido" })
  ownerEmail?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  ownerPassword?: string;

  // padrão do empreendimento → kit de conhecimento (default: econômico/MCMV)
  @IsOptional()
  @IsIn(Object.keys(IMOB_KIT_BY_PADRAO))
  padrao?: string;
}

/**
 * PLATAFORMA ↔ integrações (ex.: Central da Parceria): leitura do atendimento
 * por tenant e PROVISIONAMENTO de empreendimentos novos. Padrão do
 * KitController (`@Public` pula o JWT de tenant; o guard resolve o staff).
 * Leitura: papel 'support' basta. Provisionar: exige 'admin' (per-handler).
 */
@Public()
@UseGuards(ThrottlerGuard, PlatformStaffGuard)
@RequireStaffRole("support")
@Controller("platform/imob")
export class ImobPlatformController {
  constructor(private readonly kitApplier: KitApplierService) {}

  private async tenant(tenantId?: string): Promise<string> {
    // canonicaliza os dois lados (UUID é case-insensitive; espaço acidental)
    const canonical = tenantId?.trim().toLowerCase();
    if (!canonical) throw new BadRequestException("Informe tenantId.");
    await assertTenantReadable(canonical);
    return canonical;
  }

  /** Empreendimentos (tenants da vertical) — a Central lista/concilia daqui.
   *  Enumerar todos exige ADMIN (achado Codex: support fica só nas leituras
   *  por tenant). */
  @Get("tenants")
  @RequireStaffRole("admin")
  async tenants() {
    return { tenants: await listImobTenants() };
  }

  /**
   * PROVISIONA um empreendimento completo: tenant + owner + kit/nicho +
   * templates. Uma chamada da Central = empreendimento pronto p/ o wizard.
   */
  @Post("tenants")
  @RequireStaffRole("admin")
  async provision(@Body() dto: ProvisionDto, @Staff() staff: ActingStaff) {
    // kit resolvido ANTES de criar o tenant (achado Codex): padrão inválido
    // não pode deixar provisionamento parcial (tenant sem nicho)
    const kit = ALL_KITS[IMOB_KIT_BY_PADRAO[dto.padrao ?? "economico"] ?? ""];
    if (!kit) throw new BadRequestException(`Padrão desconhecido: ${dto.padrao}.`);
    let result;
    try {
      result = await provisionImobTenant({
        name: dto.name ?? "",
        slug: dto.slug ?? "",
        ownerEmail: dto.ownerEmail ?? "",
        ownerPassword: dto.ownerPassword ?? "",
      });
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "Falha ao provisionar.");
    }
    // kit/nicho DEPOIS do tenant criado: falha aqui não pode sumir com o
    // tenant em silêncio (achado Codex) — devolve o tenantId + instrução de
    // recuperação (re-provisionar via "Vincular" após corrigir a causa).
    try {
      await this.kitApplier.apply(kit); // idempotente por versão
      const niche = await getNicheByName(kit.niche.name);
      if (!niche) throw new Error("nicho imobiliário indisponível após aplicar o kit");
      await runWithTenant({ tenantId: result.tenantId }, async () => {
        await assignTenantNiche(niche.id);
        await this.kitApplier.materializeTemplatesForTenant(niche.id);
      });
      invalidateNicheCache(result.tenantId);
      invalidateAgentConfigCache(result.tenantId);
    } catch (err) {
      throw new BadRequestException(
        `Tenant ${result.tenantId} criado, mas o kit/nicho falhou (${err instanceof Error ? err.message : "erro"}). ` +
          `Corrija a causa (ex.: embeddings) e re-tente o provisionamento com outro slug OU acione o suporte com esse tenantId.`,
      );
    }
    return { tenantId: result.tenantId, provisionedBy: staff.email };
  }

  @Get("overview")
  async overview(@Query("tenantId") tenantId?: string) {
    const tid = await this.tenant(tenantId);
    return runWithTenant({ tenantId: tid }, () => getImobOverview(IMOB_CONFIG.acceptSlaMinutes));
  }

  @Get("assignments")
  async assignments(
    @Query("tenantId") tenantId?: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
  ) {
    const tid = await this.tenant(tenantId);
    return runWithTenant({ tenantId: tid }, async () => ({
      assignments: await listImobAssignments({
        ...(status ? { status } : {}),
        ...(limit ? { limit: Number(limit) || 50 } : {}),
      }),
    }));
  }

  @Get("brokers")
  async brokers(@Query("tenantId") tenantId?: string) {
    const tid = await this.tenant(tenantId);
    return runWithTenant({ tenantId: tid }, async () => ({ brokers: await listImobBrokers() }));
  }

  @Get("events")
  async events(@Query("tenantId") tenantId?: string, @Query("conversationId") conversationId?: string) {
    const tid = await this.tenant(tenantId);
    if (!conversationId) throw new BadRequestException("Informe conversationId.");
    return runWithTenant({ tenantId: tid }, async () => ({
      events: await listImobEvents(conversationId),
    }));
  }
}
