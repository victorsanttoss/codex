import { Injectable } from "@nestjs/common";
import { getAgentConfig } from "@sdr/db";
import {
  safeTimezone,
  type BusinessHours,
} from "../cadence/cadence-config.service";

/**
 * Config de AGENDAMENTO por tenant (sub-objeto `scheduling` da config do agente,
 * jsonb não-confiável → merge com clamp, padrão da cadência). Janela de
 * atendimento PRÓPRIA (a da cadência é sobre quando MANDAR mensagem; esta é
 * sobre quando o profissional ATENDE — clínica que atende sábado não quer
 * follow-up de domingo).
 */
export interface SchedulingSettings {
  /** Agendamento pela SDR ligado? (opt-in por tenant, como a cadência) */
  enabled: boolean;
  /** Duração do compromisso agendado pela SDR. */
  durationMinutes: number;
  /** Granularidade dos horários sugeridos. */
  slotStepMinutes: number;
  /** Janela-ALVO: tentar agendar dentro dela (48h — velocidade fecha lead). */
  windowHours: number;
  /** Antecedência mínima para sugerir/aceitar um horário. */
  minNoticeMinutes: number;
  /** Horizonte máximo de busca quando a janela-alvo está lotada. */
  maxDaysAhead: number;
  /** Janela de atendimento do profissional (no fuso da agenda). */
  hours: BusinessHours;
  /** Título do evento/compromisso (ex.: "Avaliação"). */
  appointmentLabel: string;
}

export const DEFAULT_SCHEDULING_SETTINGS: SchedulingSettings = {
  enabled: false,
  durationMinutes: 60,
  slotStepMinutes: 30,
  windowHours: 48,
  minNoticeMinutes: 120,
  maxDaysAhead: 14,
  hours: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  appointmentLabel: "Atendimento",
};

const clampInt = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : dflt;

export function mergeSchedulingSettings(
  base: SchedulingSettings,
  o: Record<string, unknown>,
): SchedulingSettings {
  const bh = (o.hours ?? {}) as Record<string, unknown>;
  const days = Array.isArray(bh.days)
    ? (bh.days as unknown[]).filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6)
    : base.hours.days;
  const startHour = clampInt(bh.startHour, 0, 23, base.hours.startHour);
  return {
    // boolean explícito decide; omitido preserva (mesma regra da cadência).
    enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
    durationMinutes: clampInt(o.durationMinutes, 15, 240, base.durationMinutes),
    slotStepMinutes: clampInt(o.slotStepMinutes, 15, 120, base.slotStepMinutes),
    windowHours: clampInt(o.windowHours, 12, 24 * 7, base.windowHours),
    minNoticeMinutes: clampInt(o.minNoticeMinutes, 0, 24 * 60, base.minNoticeMinutes),
    maxDaysAhead: clampInt(o.maxDaysAhead, 1, 60, base.maxDaysAhead),
    hours: {
      startHour,
      // endHour sempre > startHour (janela vazia não trava — cai no default relativo)
      endHour: Math.max(clampInt(bh.endHour, 1, 24, base.hours.endHour), startHour + 1),
      days: days.length > 0 ? days : base.hours.days,
    },
    appointmentLabel:
      typeof o.appointmentLabel === "string" && o.appointmentLabel.trim()
        ? o.appointmentLabel.trim().slice(0, 80)
        : base.appointmentLabel,
  };
}

/** Fuso vem da AGENDA (calendars.timezone), validado aqui (dado do banco). */
export function schedulingTimezone(calTimezone: string): string {
  return safeTimezone(calTimezone, "America/Sao_Paulo");
}

@Injectable()
export class SchedulingConfigService {
  async forTenant(): Promise<SchedulingSettings> {
    const cfg = await getAgentConfig();
    const raw = (cfg?.scheduling ?? {}) as Record<string, unknown>;
    return mergeSchedulingSettings(DEFAULT_SCHEDULING_SETTINGS, raw);
  }
}
