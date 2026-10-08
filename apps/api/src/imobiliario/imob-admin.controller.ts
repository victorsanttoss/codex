import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  archiveImobAgency,
  bumpImobBrokerTokenVersion,
  createImobAgency,
  createImobBroker,
  getActiveImobAssignment,
  getImobBrokerById,
  getImobBrokerMode,
  getImobOverview,
  listImobAgencies,
  listImobAssignments,
  listImobBrokers,
  listImobEvents,
  setImobBrokerMode,
  updateImobBroker,
  type ImobAssignmentJoined,
} from "@sdr/db";
import { requireTenantContext } from "@sdr/core";
import { Roles } from "../auth/roles";
import { ImobDistributionService } from "./imob-distribution.service";
import { ImobWorkspaceTokenService } from "./imob-workspace-token.service";
import { IMOB_CONFIG } from "./imob.config";

/**
 * Painel imobiliário do TENANT (JWT admin/owner): cadastro de imobiliárias e
 * corretores, acompanhamento das atribuições e disparo manual de distribuição.
 */
@Roles("admin")
@Controller("admin/imob")
export class ImobAdminController {
  constructor(
    private readonly distribution: ImobDistributionService,
    private readonly workspaceTokens: ImobWorkspaceTokenService,
  ) {}

  // ── Modo de atendimento do corretor (0040) ─────────────────────────────────

  @Get("settings")
  async settings() {
    return { brokerMode: await getImobBrokerMode() };
  }

  @Patch("settings")
  async patchSettings(@Body() body: { brokerMode?: string }) {
    if (body?.brokerMode !== "ficha" && body?.brokerMode !== "workspace") {
      throw new BadRequestException("brokerMode deve ser 'ficha' ou 'workspace'.");
    }
    await setImobBrokerMode(body.brokerMode);
    return { ok: true, brokerMode: body.brokerMode };
  }

  /**
   * (Re)gera o link pessoal do workspace de um corretor — para reenviar
   * manualmente ou REVOGAR (revoke=true invalida todos os links antigos).
   */
  @Post("brokers/:id/workspace-link")
  async workspaceLink(@Param("id") id: string, @Body() body: { revoke?: boolean }) {
    const { tenantId } = requireTenantContext();
    let broker = await getImobBrokerById(id);
    if (!broker) throw new NotFoundException("Corretor não encontrado.");
    if (body?.revoke) {
      await bumpImobBrokerTokenVersion(id);
      broker = await getImobBrokerById(id);
      if (!broker) throw new NotFoundException("Corretor não encontrado.");
    }
    const token = await this.workspaceTokens.sign({
      brokerId: id,
      tenantId,
      v: broker.accessTokenVersion,
    });
    const base = (process.env.WEB_ORIGIN ?? "http://localhost:3100").replace(/\/$/, "");
    // token no FRAGMENT (#t=): nunca chega ao servidor/proxy — não vaza em log
    return { link: `${base}/corretor#t=${token}`, revoked: !!body?.revoke };
  }

  // ── Imobiliárias ───────────────────────────────────────────────────────────

  @Get("agencies")
  async agencies() {
    return { agencies: await listImobAgencies() };
  }

  @Post("agencies")
  async createAgency(@Body() body: { name?: string }) {
    const name = body?.name?.trim();
    if (!name) throw new BadRequestException("Informe o nome da imobiliária.");
    return await createImobAgency(name);
  }

  @Patch("agencies/:id/archive")
  async archiveAgency(@Param("id") id: string) {
    const ok = await archiveImobAgency(id);
    if (!ok) throw new NotFoundException("Imobiliária não encontrada (ou já arquivada).");
    return { ok: true };
  }

  // ── Corretores ─────────────────────────────────────────────────────────────

  @Get("brokers")
  async brokers(@Query("includeArchived") includeArchived?: string) {
    return { brokers: await listImobBrokers({ includeArchived: includeArchived === "true" }) };
  }

  @Post("brokers")
  async createBroker(
    @Body()
    body: {
      name?: string;
      whatsapp?: string;
      agencyId?: string;
      regions?: string[];
      dailyCapacity?: number;
    },
  ) {
    const name = body?.name?.trim();
    const whatsapp = body?.whatsapp?.trim();
    if (!name || !whatsapp) throw new BadRequestException("Informe nome e WhatsApp do corretor.");
    if (body.regions && !Array.isArray(body.regions)) {
      throw new BadRequestException("'regions' deve ser uma lista de textos.");
    }
    return await createImobBroker({
      name,
      whatsapp,
      ...(body.agencyId ? { agencyId: body.agencyId } : {}),
      ...(body.regions ? { regions: body.regions.map((r) => String(r)) } : {}),
      ...(typeof body.dailyCapacity === "number" ? { dailyCapacity: body.dailyCapacity } : {}),
    });
  }

  @Patch("brokers/:id")
  async patchBroker(
    @Param("id") id: string,
    @Body()
    body: {
      name?: string;
      whatsapp?: string;
      agencyId?: string | null;
      waId?: string | null;
      regions?: string[];
      dailyCapacity?: number;
      active?: boolean;
      archived?: boolean;
    },
  ) {
    // valida ANTES do data-layer p/ virar 400 (não 500) — achado Codex
    if (body?.whatsapp !== undefined && body.whatsapp.replace(/\D/g, "").length < 10) {
      throw new BadRequestException("WhatsApp do corretor inválido (mínimo 10 dígitos).");
    }
    if (body?.dailyCapacity !== undefined && (!Number.isFinite(body.dailyCapacity) || body.dailyCapacity < 1)) {
      throw new BadRequestException("Capacidade diária inválida (mínimo 1).");
    }
    const ok = await updateImobBroker(id, body ?? {});
    if (!ok) throw new NotFoundException("Corretor não encontrado.");
    return { ok: true };
  }

  // ── Acompanhamento ─────────────────────────────────────────────────────────

  @Get("overview")
  async overview() {
    return await getImobOverview(IMOB_CONFIG.acceptSlaMinutes);
  }

  @Get("assignments")
  async assignments(
    @Query("status") status?: string,
    @Query("brokerId") brokerId?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<{ assignments: ImobAssignmentJoined[] }> {
    return {
      assignments: await listImobAssignments({
        ...(status ? { status } : {}),
        ...(brokerId ? { brokerId } : {}),
        ...(limit ? { limit: Number(limit) || 50 } : {}),
        ...(offset ? { offset: Number(offset) || 0 } : {}),
      }),
    };
  }

  @Get("events/:conversationId")
  async events(@Param("conversationId") conversationId: string) {
    return { events: await listImobEvents(conversationId) };
  }

  /** Distribuição manual (lead sem atribuição ativa — ex.: pós-exhausted). */
  @Post("distribute/:conversationId")
  async distribute(@Param("conversationId") conversationId: string) {
    const active = await getActiveImobAssignment(conversationId);
    if (active) throw new BadRequestException("Lead já tem atribuição ativa.");
    return await this.distribution.distribute(conversationId, { attempt: 1 });
  }
}
