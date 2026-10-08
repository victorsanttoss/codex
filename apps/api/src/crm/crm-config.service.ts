import { Injectable } from "@nestjs/common";
import { isDisguisedNumericHost, isPrivateOrReservedIp } from "@sdr/core";
import { getAgentConfig } from "@sdr/db";

export interface CrmSettings {
  /** Qual CRM usar: 'builtin' (default), 'http' (webhook genérico) ou 'kommo'. */
  crmAdapter: "builtin" | "http" | "kommo";
  /** baseURL do CRM externo (quando crmAdapter === 'http'). */
  httpBaseURL?: string;
  /** Base da conta Kommo, ex.: https://acme.kommo.com (quando crmAdapter === 'kommo'). */
  kommoBaseURL?: string;
  /** Funil/etapa do Kommo onde o lead deve cair (opcionais). */
  kommoPipelineId?: number;
  kommoStatusId?: number;
  schedulingAdapter: "builtin";
  notificationAdapter: "builtin";
  /** Fuso dos agendamentos. */
  timezone: string;
  appointmentDurationMin: number;
}

export const DEFAULT_CRM_SETTINGS: CrmSettings = {
  crmAdapter: "builtin",
  schedulingAdapter: "builtin",
  notificationAdapter: "builtin",
  timezone: "America/Sao_Paulo",
  appointmentDurationMin: 30,
};

/**
 * Config de CRM/agendamento/notificação por tenant (data-driven, mesmo padrão do
 * AgentConfigService). Lê o sub-objeto `crm` da config do agente (jsonb
 * não-confiável) e VALIDA/CLAMPA — nunca aceita adapter desconhecido.
 */
@Injectable()
export class CrmConfigService {
  async forTenant(): Promise<CrmSettings> {
    const agentCfg = await getAgentConfig();
    const raw = ((agentCfg?.crm ?? {}) as Record<string, unknown>) || {};
    return mergeCrmSettings(DEFAULT_CRM_SETTINGS, raw);
  }
}

/**
 * Anti-SSRF (1ª barreira — validação de STRING): o `httpBaseURL` vem da config do
 * tenant (não-confiável) e levaria o Bearer da chave do CRM. Exige https + porta
 * padrão (443) e bloqueia loopback/`.internal`/`.local`, IP literal em faixa
 * privada/reservada (v4 e v6, via classificador do core) e hostnames NUMÉRICOS
 * disfarçados (decimal/hex/octal — ex.: `2130706433`, `0x7f000001`, `0177.0.0.1`),
 * que o `getaddrinfo` interpretaria como IP interno. URL inválida → undefined
 * (cai para builtin).
 *
 * ATENÇÃO: esta é só a 1ª barreira. Ela NÃO resolve DNS, então NÃO cobre rebinding
 * (`crm.evil.com` → 169.254.169.254). A 2ª barreira (definitiva) está no fetch do
 * `@sdr/crm-http` (`makeGuardedFetchCrmHttp`): resolve o DNS, valida TODOS os IPs
 * e FIXA (pin) o IP validado ao conectar.
 */
export function safeHttpBaseURL(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  // Só a porta padrão (443): evita alcançar serviços internos em portas altas.
  if (url.port !== "" && url.port !== "443") return undefined;
  // IPv6 literal: url.hostname mantém os colchetes ([::1]) — remove p/ classificar.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    isDisguisedNumericHost(host) || // decimal/hex/octal disfarçado
    isPrivateOrReservedIp(host) // IP literal (v4/v6) em faixa privada/reservada
  ) {
    return undefined;
  }
  return value;
}

/** Inteiro positivo (id de funil/etapa do Kommo) ou undefined. */
function positiveIntOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

export function mergeCrmSettings(base: CrmSettings, o: Record<string, unknown>): CrmSettings {
  const requested = o.crmAdapter === "http" ? "http" : o.crmAdapter === "kommo" ? "kommo" : "builtin";
  const httpBaseURL = safeHttpBaseURL(o.httpBaseURL);
  // O baseURL do Kommo passa pela MESMA barreira anti-SSRF de string (https:443,
  // sem IP privado/loopback/numérico disfarçado). kommo.com é público e satisfaz.
  const kommoBaseURL = safeHttpBaseURL(o.kommoBaseURL);
  const kommoPipelineId = positiveIntOrUndefined(o.kommoPipelineId);
  const kommoStatusId = positiveIntOrUndefined(o.kommoStatusId);
  const durationRaw = o.appointmentDurationMin;
  const duration =
    typeof durationRaw === "number" && Number.isFinite(durationRaw)
      ? Math.min(480, Math.max(5, Math.floor(durationRaw)))
      : base.appointmentDurationMin;
  // Adapter externo sem baseURL válido cai p/ builtin (fail-safe: não quebra o sync).
  // A chave (token) é exigida só na resolução do provider (crm.service), não aqui.
  const effective =
    requested === "http" && httpBaseURL
      ? "http"
      : requested === "kommo" && kommoBaseURL
        ? "kommo"
        : "builtin";
  return {
    crmAdapter: effective,
    ...(effective === "http" && httpBaseURL ? { httpBaseURL } : {}),
    ...(effective === "kommo" && kommoBaseURL
      ? {
          kommoBaseURL,
          ...(kommoPipelineId ? { kommoPipelineId } : {}),
          ...(kommoStatusId ? { kommoStatusId } : {}),
        }
      : {}),
    schedulingAdapter: "builtin",
    notificationAdapter: "builtin",
    timezone: typeof o.timezone === "string" && o.timezone.trim() ? o.timezone : base.timezone,
    appointmentDurationMin: duration,
  };
}
