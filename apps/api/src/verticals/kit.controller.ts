import { Controller, Logger, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { runWithTenant } from "@sdr/core";
import { getTenantNicheId, insertAuditLog } from "@sdr/db";
import { Public } from "../auth/decorators";
import { type ActingStaff, PlatformStaffGuard, RequireStaffRole, Staff } from "../platform/platform-staff.guard";
import { KitApplierService } from "./kit-applier.service";
import { ALL_KITS } from "./kits";

/**
 * Aplicação de KITS de vertical — STAFF DE PLATAFORMA (`@Public` pula o JWT;
 * `PlatformStaffGuard` resolve a identidade por-staff e enforça o papel). Aplicar
 * um kit promove conhecimento `platform_authored`: ação sensível → exige papel
 * curador/admin e vai para o audit_log.
 */
@Public()
// ThrottlerGuard também aqui (achado Codex): rate-limit do x-platform-token.
@UseGuards(ThrottlerGuard, PlatformStaffGuard)
@RequireStaffRole("curator") // admin passa; support (leitura) não
@Controller("platform/kits")
export class KitController {
  private readonly logger = new Logger(KitController.name);
  constructor(private readonly applier: KitApplierService) {}

  /** Lista os kits embutidos disponíveis. */
  @Post()
  list(): { kits: string[] } {
    return { kits: Object.keys(ALL_KITS) };
  }

  /** Aplica um kit embutido (idempotente por versão). */
  @Post(":kitId/apply")
  async apply(@Param("kitId") kitId: string, @Staff() staff: ActingStaff) {
    const kit = ALL_KITS[kitId];
    if (!kit) throw new NotFoundException(`Kit desconhecido: ${kitId}.`);
    const res = await this.applier.apply(kit);
    // Auditoria best-effort pós-ação: kit já aplicado (idempotente por versão);
    // falha na trilha não deve mascarar a aplicação bem-sucedida.
    try {
      await insertAuditLog({
        actor: staff.id,
        action: "kit.apply",
        target: kitId,
        metadata: { niche: kit.niche, version: kit.version, staffEmail: staff.email },
      });
    } catch (e) {
      this.logger.warn(`audit_log falhou (kit.apply ${kitId}): ${(e as Error).message}`);
    }
    return res;
  }

  /** Materializa os templates do nicho do tenant no catálogo dele (status pending). */
  @Post("materialize-templates/:tenantId")
  async materialize(@Param("tenantId") tenantId: string): Promise<{ count: number }> {
    const nicheId = await runWithTenant({ tenantId }, () => getTenantNicheId());
    if (!nicheId) throw new NotFoundException("Tenant sem nicho atribuído.");
    return runWithTenant({ tenantId }, () => this.applier.materializeTemplatesForTenant(nicheId));
  }
}
