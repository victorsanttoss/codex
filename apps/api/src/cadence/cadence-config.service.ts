import { Injectable } from "@nestjs/common";
import { getAgentConfig } from "@sdr/db";

export interface CadenceStep {
  /** Atraso (minutos) a partir do passo anterior (ou do arme, p/ o passo 0). */
  delayMinutes: number;
  templateName: string;
  languageCode: string;
}

export interface BusinessHours {
  /** Hora de início/fim (0-23) no fuso. Envio proativo só nesta janela. */
  startHour: number;
  endHour: number;
  /** Dias da semana permitidos (0=domingo..6=sábado). */
  days: number[];
}

export interface CadenceSettings {
  enabled: boolean;
  steps: CadenceStep[];
  businessHours: BusinessHours;
  timezone: string;
  /** Teto de envios proativos por contato dentro de `frequencyWindowHours`. */
  frequencyCap: number;
  frequencyWindowHours: number;
}

export const DEFAULT_CADENCE_SETTINGS: CadenceSettings = {
  enabled: false, // opt-in: o tenant precisa habilitar conscientemente
  steps: [
    { delayMinutes: 60, templateName: "followup_1", languageCode: "pt_BR" },
    { delayMinutes: 1440, templateName: "followup_2", languageCode: "pt_BR" },
    { delayMinutes: 4320, templateName: "followup_3", languageCode: "pt_BR" },
  ],
  businessHours: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  timezone: "America/Sao_Paulo",
  frequencyCap: 1,
  frequencyWindowHours: 24,
};

/**
 * Config de cadência por tenant (data-driven, mesmo padrão dos outros configs).
 * Lê o sub-objeto `cadence` da config do agente (jsonb não-confiável) e VALIDA/
 * CLAMPA — passos absurdos não viram spam.
 */
@Injectable()
export class CadenceConfigService {
  async forTenant(): Promise<CadenceSettings> {
    const cfg = await getAgentConfig();
    const raw = (cfg?.cadence ?? {}) as Record<string, unknown>;
    return mergeCadenceSettings(DEFAULT_CADENCE_SETTINGS, raw);
  }
}

const clampInt = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : dflt;

/** Valida o timezone (config não-confiável) via Intl; inválido → default. */
export function safeTimezone(v: unknown, dflt: string): string {
  if (typeof v !== "string" || !v.trim()) return dflt;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return v;
  } catch {
    return dflt;
  }
}

export function mergeCadenceSettings(base: CadenceSettings, o: Record<string, unknown>): CadenceSettings {
  const steps = Array.isArray(o.steps)
    ? (o.steps as unknown[])
        .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
        .map((s) => ({
          delayMinutes: clampInt(s.delayMinutes, 5, 60 * 24 * 30, 60), // 5min..30d
          templateName: typeof s.templateName === "string" ? s.templateName : "",
          languageCode: typeof s.languageCode === "string" ? s.languageCode : "pt_BR",
        }))
        .filter((s) => s.templateName)
        .slice(0, 10) // máximo de passos (anti-spam)
    : base.steps;
  const bh = (o.businessHours ?? {}) as Record<string, unknown>;
  const days = Array.isArray(bh.days)
    ? (bh.days as unknown[]).filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6)
    : base.businessHours.days;
  return {
    // enabled omitido no patch PRESERVA o valor atual (achado Codex: PUT parcial
    // não pode desligar por omissão); boolean explícito decide.
    enabled: (typeof o.enabled === "boolean" ? o.enabled : base.enabled) && steps.length > 0,
    steps: steps.length > 0 ? steps : base.steps,
    businessHours: {
      startHour: clampInt(bh.startHour, 0, 23, base.businessHours.startHour),
      endHour: clampInt(bh.endHour, 1, 24, base.businessHours.endHour),
      days: days.length > 0 ? days : base.businessHours.days,
    },
    timezone: safeTimezone(o.timezone, base.timezone),
    frequencyCap: clampInt(o.frequencyCap, 1, 10, base.frequencyCap),
    frequencyWindowHours: clampInt(o.frequencyWindowHours, 1, 720, base.frequencyWindowHours),
  };
}

/** Está dentro da janela comercial (hora + dia da semana) no fuso do tenant? */
export function withinBusinessHours(settings: CadenceSettings, now: Date): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: settings.timezone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = Number(hourStr) % 24;
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[weekdayStr] ?? 0;
  if (!settings.businessHours.days.includes(day)) return false;
  return hour >= settings.businessHours.startHour && hour < settings.businessHours.endHour;
}
