import { Controller, Get, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import {
  listAllTenants,
  listNiches,
  listPlatformStaff,
  listPlatformTemplates,
  platformOverview,
  type PlatformNiche,
  type PlatformOverview,
  type PlatformTemplatesView,
  type PlatformTenant,
  type StaffRow,
} from "@sdr/db";
import { Public } from "../auth/decorators";
import { type ActingStaff, PlatformStaffGuard, Staff } from "./platform-staff.guard";
import { AlertsService } from "../ops/alerts.service";

/**
 * Leitura da ÁREA DA PLATAFORMA (M14) — staff. `@Public()` pula o JWT do tenant;
 * `PlatformStaffGuard` resolve a IDENTIDADE por-staff (token pessoal ou o token
 * compartilhado de bootstrap). Leituras não exigem papel específico. Cross-tenant,
 * caminho system. Curadoria/nichos de escrita ficam no CurationController (M9).
 */
@Public()
@UseGuards(ThrottlerGuard, PlatformStaffGuard)
@Controller("platform")
export class PlatformReadController {
  constructor(private readonly alerts: AlertsService) {}

  /** Quem sou eu — identidade do staff resolvida pelo guard (para a UI). */
  @Get("me")
  me(@Staff() staff: ActingStaff): ActingStaff {
    return staff;
  }

  @Get("overview")
  overview(): Promise<PlatformOverview> {
    return platformOverview();
  }

  @Get("tenants")
  tenants(): Promise<PlatformTenant[]> {
    return listAllTenants();
  }

  @Get("niches")
  niches(): Promise<PlatformNiche[]> {
    return listNiches();
  }

  @Get("templates")
  templates(): Promise<PlatformTemplatesView> {
    return listPlatformTemplates();
  }

  @Get("staff")
  staff(): Promise<StaffRow[]> {
    return listPlatformStaff();
  }

  /** Operação & alertas (read-only snapshot; não notifica). */
  @Get("operation")
  operation(): ReturnType<AlertsService["snapshot"]> {
    return this.alerts.snapshot();
  }
}
