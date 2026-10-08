import { createHash, timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { runWithTenant } from "@sdr/core";
import { isImobTenant } from "@sdr/db";
import { Public } from "../auth/decorators";
import { LeadIntakeService, type IntakeLeadInput, type IntakeLeadResult } from "./lead-intake.service";

/** Comparação timing-safe via hash (tamanhos diferentes não vazam; achado Codex). */
function tokenOk(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * ENTRADA GENÉRICA de leads de campanha — para Make/Zapier/n8n (conector Meta
 * Lead Ads), landing pages, planilhas etc. Auth fail-closed: header
 * `x-intake-token` = env LEAD_INTAKE_TOKEN e tenant dentro da allowlist
 * LEAD_INTAKE_TENANTS (sem env → endpoint desligado).
 *
 * Body: { tenantId, telefone, nome?, email?, fields?, fieldData? (formato
 * Meta field_data, pass-through), source?, externalId? }
 */
@Public()
@UseGuards(ThrottlerGuard)
@Controller("integrations")
export class IntakeController {
  constructor(private readonly service: LeadIntakeService) {}

  @Post("leads")
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async receive(
    @Headers("x-intake-token") token: string | undefined,
    @Body() body: (IntakeLeadInput & { tenantId?: string }) | undefined,
  ): Promise<IntakeLeadResult> {
    const tenantId = body?.tenantId?.trim().toLowerCase();
    const allowed = new Set(
      (process.env.LEAD_INTAKE_TENANTS ?? "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    );
    // Autorização por tenant: env preenchida = lista ESTRITA; vazia = qualquer
    // tenant da VERTICAL imobiliária (self-service via Central — sem SSH p/
    // liberar empreendimento novo). 403 GENÉRICO nos dois casos (não confirmar
    // quais tenants existem p/ quem chuta — achado Codex).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const tenantOk =
      !!tenantId &&
      UUID_RE.test(tenantId) && // uuid inválido não pode virar 500 no cast (Codex)
      (allowed.size > 0 ? allowed.has(tenantId) : await isImobTenant(tenantId));
    if (!tokenOk(token, process.env.LEAD_INTAKE_TOKEN) || !tenantOk) {
      throw new ForbiddenException("Credenciais de intake inválidas.");
    }
    if (!body?.telefone && !body?.fieldData?.length) {
      throw new BadRequestException("Informe o telefone do lead (ou fieldData da Meta).");
    }
    try {
      return await runWithTenant({ tenantId }, () => this.service.intake({ ...body, telefone: body.telefone ?? "" }));
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "Falha ao registrar o lead.");
    }
  }
}
