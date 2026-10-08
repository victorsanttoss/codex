import { Body, Controller, Get, Put } from "@nestjs/common";
import { IsObject } from "class-validator";
import { complianceSummary, getAgentConfig, getNiche, getTenantNicheId, listTenantMembers, putAgentConfig, type ComplianceSummary, type MemberRow } from "@sdr/db";
import { Roles } from "../auth/roles";
import { resourceNounForVertical, type ResourceNoun } from "../verticals/kits";
import { AgentConfigService, DEFAULT_AGENT_CONFIG, invalidateAgentConfigCache, mergeConfig } from "../agent/agent-config";
import { CadenceConfigService, DEFAULT_CADENCE_SETTINGS, mergeCadenceSettings, type CadenceSettings } from "../cadence/cadence-config.service";
import { SchedulingConfigService, DEFAULT_SCHEDULING_SETTINGS, mergeSchedulingSettings, type SchedulingSettings } from "../calendar/scheduling-config.service";

class PatchConfigDto {
  @IsObject()
  patch!: Record<string, unknown>;
}

const MAX_STR = 4000;
/** Limita o tamanho das strings do patch (anti-inflar prompt/custo). */
function clampStrings(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === "string" ? v.slice(0, MAX_STR) : v;
  return out;
}

/**
 * Configuração & Conta (M14). Leitura/escrita do config do agente (persona/
 * guardrails/qualificação) — a validação/clamp acontece no `AgentConfigService`
 * (data-driven, dado não-confiável). Reusa cadência (M8) e contas (membros/
 * compliance). Tudo tenant-scoped; admin para escrever.
 */
@Controller("admin")
export class SettingsController {
  constructor(
    private readonly agentConfig: AgentConfigService,
    private readonly cadenceConfig: CadenceConfigService,
    private readonly schedulingConfig: SchedulingConfigService,
  ) {}

  /**
   * Vertical do tenant (via nicho atribuído) — o front adapta os textos do
   * wizard/Configuração ao segmento (ex.: imobiliário mostra a etapa de
   * corretores parceiros). Sem nicho: vertical null + termos genéricos.
   */
  @Get("settings/vertical")
  async vertical(): Promise<{ vertical: string | null; nicheName: string | null; resourceNoun: ResourceNoun }> {
    const nicheId = await getTenantNicheId();
    const niche = nicheId ? await getNiche(nicheId) : null;
    return {
      vertical: niche?.vertical ?? null,
      nicheName: niche?.name ?? null,
      resourceNoun: resourceNounForVertical(niche?.vertical ?? ""),
    };
  }

  /** Config RESOLVIDO do agente (com defaults/clamps aplicados). */
  @Roles("admin")
  @Get("settings/agent")
  agent(): ReturnType<AgentConfigService["forTenant"]> {
    return this.agentConfig.forTenant();
  }

  /** Mescla um patch no config armazenado (persona/guardrails/mensagens). O read
   *  re-valida e clampa — não confiamos no patch cru. */
  @Roles("admin")
  @Put("settings/agent")
  async saveAgent(@Body() dto: PatchConfigDto): Promise<{ ok: true }> {
    const stored = (await getAgentConfig()) ?? {};
    // VALIDA/CLAMPA na ESCRITA (achado Codex M14): mescla com defaults + clampa
    // guardrails/qualificação e limita strings — não persiste patch cru.
    const merged = mergeConfig(DEFAULT_AGENT_CONFIG, clampStrings({ ...stored, ...dto.patch }));
    // BUG latente corrigido: mergeConfig devolve SÓ o shape de AgentConfig e
    // descartava os sub-objetos `cadence` (M8) e `scheduling` (0034) — todo save
    // de Configuração apagava essas configs. Preserva as chaves explicitamente.
    const cadence = (stored as Record<string, unknown>).cadence;
    const scheduling = (stored as Record<string, unknown>).scheduling;
    await putAgentConfig({
      ...(cadence !== undefined ? { cadence } : {}),
      ...(scheduling !== undefined ? { scheduling } : {}),
      ...(merged as unknown as Record<string, unknown>),
    });
    invalidateAgentConfigCache(); // o cache TTL não pode servir config velha após o save
    return { ok: true };
  }

  @Roles("admin")
  @Get("settings/cadence")
  cadence(): ReturnType<CadenceConfigService["forTenant"]> {
    return this.cadenceConfig.forTenant();
  }

  /**
   * Escreve a config de CADÊNCIA (M8-ext). Valida/clampa via mergeCadenceSettings
   * (passos 5min..30d, máx 10, template obrigatório) e preserva o restante da
   * config do agente — cadence é um sub-objeto do mesmo jsonb.
   */
  @Roles("admin")
  @Put("settings/cadence")
  async saveCadence(@Body() dto: PatchConfigDto): Promise<{ ok: true; applied: CadenceSettings }> {
    const stored = ((await getAgentConfig()) ?? {}) as Record<string, unknown>;
    const current = (stored.cadence ?? {}) as Record<string, unknown>;
    const applied = mergeCadenceSettings(
      mergeCadenceSettings(DEFAULT_CADENCE_SETTINGS, current),
      dto.patch,
    );
    await putAgentConfig({ ...stored, cadence: applied as unknown as Record<string, unknown> });
    invalidateAgentConfigCache();
    return { ok: true, applied };
  }

  @Roles("admin")
  @Get("settings/scheduling")
  scheduling(): ReturnType<SchedulingConfigService["forTenant"]> {
    return this.schedulingConfig.forTenant();
  }

  /**
   * Escreve a config de AGENDAMENTO (0034) — sub-objeto `scheduling` do mesmo
   * jsonb, validado/clampado via mergeSchedulingSettings (mesmo padrão da
   * cadência). Habilitar aqui liga as tools de agenda da SDR.
   */
  @Roles("admin")
  @Put("settings/scheduling")
  async saveScheduling(
    @Body() dto: PatchConfigDto,
  ): Promise<{ ok: true; applied: SchedulingSettings }> {
    const stored = ((await getAgentConfig()) ?? {}) as Record<string, unknown>;
    const current = (stored.scheduling ?? {}) as Record<string, unknown>;
    const applied = mergeSchedulingSettings(
      mergeSchedulingSettings(DEFAULT_SCHEDULING_SETTINGS, current),
      dto.patch,
    );
    await putAgentConfig({ ...stored, scheduling: applied as unknown as Record<string, unknown> });
    invalidateAgentConfigCache();
    return { ok: true, applied };
  }

  // ── Conta ──
  @Roles("admin")
  @Get("account/members")
  members(): Promise<MemberRow[]> {
    return listTenantMembers();
  }

  @Roles("admin")
  @Get("account/compliance")
  compliance(): Promise<ComplianceSummary> {
    return complianceSummary();
  }
}
