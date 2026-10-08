import { Injectable, Logger } from "@nestjs/common";
import {
  cancelEventsByAppointment,
  createAppointment,
  createCalendarEvent,
  ensureDefaultCalendar,
  getCalendarsByIds,
  getEventByAppointment,
  hasEventOverlap,
  listAppointmentsForConversation,
  listCalendarEvents,
  listPoolCalendars,
  setAppointmentCalendar,
  setAppointmentStatus,
  updateCalendarEvent,
  type CalendarEventRow,
  type CalendarRow,
} from "@sdr/db";
import {
  formatNowLabel,
  formatSlotLabel,
  makeZoned,
  poolFreeSlots,
  slotPeriod,
  suggestPoolSlots,
  zonedParts,
  type BusyInterval,
  type Slot,
  type SlotPeriod,
  type SlotRules,
} from "./availability";
import { GoogleCalendarService } from "./google-calendar.service";
import {
  SchedulingConfigService,
  schedulingTimezone,
  type SchedulingSettings,
} from "./scheduling-config.service";

export interface LabeledSlot {
  startsAt: string; // ISO — o que a tool devolve e o book recebe de volta
  label: string; // "qui, 31/07 às 09:00" — o que o lead lê
  period: SlotPeriod;
}

export interface SuggestionPair {
  manha: LabeledSlot | null;
  tarde: LabeledSlot | null;
  beyondWindow: boolean;
  timezone: string;
  nowLabel: string;
}

export type BookResult =
  | { ok: true; label: string; appointmentId: string; googleMirrored: boolean | null; rebooked: boolean }
  | { ok: false; reason: string; alternatives: LabeledSlot[] };

/** Evento da reserva + a agenda (recurso) do pool onde ele caiu. */
interface BookedOnPool {
  event: CalendarEventRow;
  cal: CalendarRow;
}

/**
 * Orquestra o agendamento da SDR sobre o POOL de agendas do tenant (0036): uma
 * agenda por recurso (profissional/vendedor/corretor — o termo é da vertical).
 * A disponibilidade é a UNIÃO (um horário é oferecido se ao menos UM recurso
 * está livre) e a RESERVA gruda no recurso livre (balanceado entre eles). Tenant
 * com uma agenda só é o caso particular (pool de tamanho 1).
 *
 * Falha do Google na CONSULTA é fail-closed (não sugerimos horário que pode
 * colidir com a agenda real); falha do Google só no ESPELHO do evento não desfaz
 * a reserva interna — o painel/notificação são a fonte da verdade.
 */
@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name);

  constructor(
    private readonly configSvc: SchedulingConfigService,
    private readonly google: GoogleCalendarService,
  ) {}

  async settings(): Promise<SchedulingSettings> {
    return this.configSvc.forTenant();
  }

  /** Sugestão do fluxo: 1 horário de manhã + 1 de tarde (janela-alvo primeiro). */
  async suggest(now = new Date()): Promise<SuggestionPair> {
    const { settings, pool, rules } = await this.context();
    const horizon = new Date(now.getTime() + settings.maxDaysAhead * 24 * 60 * 60_000);
    const busyByResource = await this.busyByResource(pool, now, horizon);
    const s = suggestPoolSlots({
      now,
      rules,
      busyByResource,
      windowHours: settings.windowHours,
      maxDaysAhead: settings.maxDaysAhead,
    });
    const tz = rules.timezone;
    return {
      manha: s.manha ? toLabeled(s.manha, tz) : null,
      tarde: s.tarde ? toLabeled(s.tarde, tz) : null,
      beyondWindow: s.beyondWindow,
      timezone: tz,
      nowLabel: formatNowLabel(now, tz),
    };
  }

  /** Lista horários livres no pool (para a tool: outro período/dia que o lead pedir). */
  async listSlots(input: {
    period?: SlotPeriod;
    fromDayOffset?: number;
    days?: number;
    limit?: number;
    /** true = retorna os horários MAIS TARDE (fim do expediente), não os mais cedo. */
    latest?: boolean;
    now?: Date;
  }): Promise<LabeledSlot[]> {
    const now = input.now ?? new Date();
    const { settings, pool, rules } = await this.context();
    const offset = Math.min(Math.max(input.fromDayOffset ?? 0, 0), settings.maxDaysAhead);
    const spanDays = Math.min(Math.max(input.days ?? 7, 1), settings.maxDaysAhead);
    const from = new Date(
      Math.max(
        now.getTime() + rules.minNoticeMinutes * 60_000,
        now.getTime() + offset * 24 * 60 * 60_000,
      ),
    );
    const to = new Date(from.getTime() + spanDays * 24 * 60 * 60_000);
    const busyByResource = await this.busyByResource(pool, from, to);
    const limit = Math.min(Math.max(input.limit ?? 6, 1), 12);
    const slots = poolFreeSlots({ from, to, rules, busyByResource });
    const filtered = input.period
      ? slots.filter((s) => slotPeriod(s, rules.timezone) === input.period)
      : slots;
    // `latest`: pega os MAIS TARDE (fim do expediente) p/ lead que só pode à noite/
    // tarde — mantém a ordem cronológica (ex.: [16h, 17h]). Senão, os mais cedo.
    const picked = input.latest ? filtered.slice(-limit) : filtered.slice(0, limit);
    return picked.map((s) => toLabeled(s, rules.timezone));
  }

  /**
   * RESERVA o horário para a conversa. Valida janela/antecedência/colisão de
   * novo (o lead pode confirmar minutos depois da sugestão). Reserva anterior
   * da MESMA conversa é cancelada (remarcação) — inclusive o espelho no Google.
   */
  async book(input: {
    conversationId: string;
    startsAtIso: string;
    contactName?: string;
    details?: string;
    dryRun?: boolean;
    now?: Date;
  }): Promise<BookResult> {
    const now = input.now ?? new Date();
    const { settings, pool, rules } = await this.context();
    const startsAt = new Date(input.startsAtIso);
    if (Number.isNaN(startsAt.getTime())) {
      return this.reject(now, "Horário inválido (use um dos horários oferecidos).");
    }
    const slot: Slot = {
      start: startsAt,
      end: new Date(startsAt.getTime() + settings.durationMinutes * 60_000),
    };
    const label = formatSlotLabel(slot, rules.timezone);
    const title = `${settings.appointmentLabel}${input.contactName ? ` — ${input.contactName}` : ""} (SDR)`;
    const details =
      input.details?.trim() ||
      `${settings.appointmentLabel}${input.contactName ? ` — ${input.contactName}` : ""}`;

    // RETRY idempotente ANTES das checagens de colisão (achados Codex): a MESMA
    // reserva confirmada nesta conversa (mesmo horário) retorna ok — depois das
    // checagens, o retry do worker colidiria com o PRÓPRIO evento e responderia
    // "ocupado" ao lead. E o caminho COMPLETA o que um crash no meio deixou
    // faltando: evento na agenda, espelho no Google e cancelamento da anterior.
    if (!input.dryRun) {
      const appts = await listAppointmentsForConversation(input.conversationId);
      const active = appts.filter(
        (a) => a.status === "confirmed" && a.startsAt && a.startsAt.getTime() > now.getTime(),
      );
      const existing = active.find((a) => a.startsAt!.getTime() === slot.start.getTime());
      if (existing) {
        const booked = await this.ensurePoolBooking(existing.id, slot, title, details, pool, rules);
        if (!booked) return this.reject(now, "Esse horário acabou de ser ocupado.");
        await setAppointmentCalendar(existing.id, booked.event.calendarId);
        const rebooked = await this.cancelActiveBooking(input.conversationId, existing.id);
        const googleMirrored = await this.mirrorToGoogle(booked, rules, slot, title, details);
        return { ok: true, label: existing.whenText ?? label, appointmentId: existing.id, googleMirrored, rebooked };
      }
      // Remarcação SOBREPONDO a reserva atual do próprio lead: recusa com motivo
      // honesto (decisão do ADR 0045). A exclusion 0035 impede criar o novo
      // evento antes de cancelar o antigo, e cancelar antes reabre o achado da
      // rodada 1 — e as sugestões nunca oferecem slot que colide com o atual,
      // então este caminho só ocorre com horário inventado fora das opções.
      for (const a of active) {
        const ev = await getEventByAppointment(a.id);
        if (ev && ev.startsAt < slot.end && ev.endsAt > slot.start) {
          return this.reject(
            now,
            `O lead já tem ${a.whenText ?? "um horário"} reservado e o novo horário conflita com ele. Mantenha o atual ou ofereça um horário fora desse intervalo (a remarcação cancela o antigo sozinha).`,
          );
        }
      }
    }

    // mesmas regras da sugestão: antecedência, horizonte e janela de atendimento
    if (slot.start.getTime() < now.getTime() + settings.minNoticeMinutes * 60_000) {
      return this.reject(now, "Esse horário é muito em cima da hora.");
    }
    if (slot.start.getTime() > now.getTime() + settings.maxDaysAhead * 24 * 60 * 60_000) {
      return this.reject(now, "Esse horário está longe demais no futuro.");
    }
    const p = zonedParts(slot.start, rules.timezone);
    const dayStart = makeZoned(p.y, p.m, p.d, rules.hours.startHour, 0, rules.timezone);
    const dayEnd = makeZoned(p.y, p.m, p.d, rules.hours.endHour, 0, rules.timezone);
    const withinHours =
      rules.hours.days.includes(p.weekday) && slot.start >= dayStart && slot.end <= dayEnd;
    if (!withinHours) {
      return this.reject(now, "Esse horário fica fora da janela de atendimento.");
    }

    // GRADE (achado Codex): só horários alinhados ao passo — a IA deve repassar
    // um starts_at emitido pelas sugestões; "09:17" não passa mesmo se livre.
    const minutesFromDayStart = Math.round((slot.start.getTime() - dayStart.getTime()) / 60_000);
    if (minutesFromDayStart < 0 || minutesFromDayStart % settings.slotStepMinutes !== 0) {
      return this.reject(now, "Esse horário não está na grade de horários disponíveis.");
    }

    // ao menos UM recurso do pool livre neste horário?
    const free = await this.freeCalendarsAt(pool, slot, rules);
    if (free.length === 0) {
      return this.reject(now, "Esse horário acabou de ser ocupado.");
    }

    if (input.dryRun) {
      return { ok: true, label, appointmentId: "(simulação)", googleMirrored: null, rebooked: false };
    }

    const { appointmentId, created } = await createAppointment({
      conversationId: input.conversationId,
      idempotencyKey: `${input.conversationId}:booking:${slot.start.toISOString()}`,
      startsAt: slot.start,
      whenText: label,
      details,
      status: "confirmed",
    });
    // A chave idempotente pode devolver um appointment CANCELADO (remarcação de
    // volta p/ um slot antigo, ou limpeza pós-conflito) — re-confirma (achado
    // Codex), senão o "ok" apontaria p/ um registro cancelled.
    if (!created) await setAppointmentStatus(appointmentId, "confirmed");

    const booked = await this.ensurePoolBooking(appointmentId, slot, title, details, pool, rules, free);
    if (!booked) {
      // nenhuma agenda livre venceu (corrida) — cancela o appointment sem evento
      await setAppointmentStatus(appointmentId, "cancelled").catch(() => undefined);
      return this.reject(now, "Esse horário acabou de ser ocupado.");
    }
    await setAppointmentCalendar(appointmentId, booked.event.calendarId);

    // remarcação: a reserva anterior só é cancelada DEPOIS de a nova existir
    // (achado Codex: cancelar antes perdia o horário antigo se o insert novo
    // falhasse — o lead ficava sem nenhum).
    const rebooked = await this.cancelActiveBooking(input.conversationId, appointmentId);
    const googleMirrored = await this.mirrorToGoogle(booked, rules, slot, title, details);

    return { ok: true, label, appointmentId, googleMirrored, rebooked };
  }

  /**
   * Garante a reserva do appointment em ALGUMA agenda livre do pool. Se o
   * appointment já tem evento ativo (retry/crash), reusa-o. Senão percorre as
   * agendas livres (balanceadas) tentando gravar; a agenda tomada por OUTRO
   * appointment nesse meio-tempo (exclusion 0035) é pulada e tenta-se a próxima.
   * Retorna null só quando NENHUMA agenda livre restou (chamador reoferece).
   */
  private async ensurePoolBooking(
    appointmentId: string,
    slot: Slot,
    title: string,
    details: string,
    pool: CalendarRow[],
    rules: SlotRules,
    precomputedFree?: CalendarRow[],
  ): Promise<BookedOnPool | null> {
    const existing = await getEventByAppointment(appointmentId);
    if (existing) {
      // Só reusa se for o MESMO horário. A chave idempotente inclui o slot, então
      // no fluxo normal sempre bate; um evento ativo com OUTRO intervalo é
      // inconsistência (crash/dado legado) — recusa em vez de espelhar errado.
      const sameSlot =
        existing.startsAt.getTime() === slot.start.getTime() &&
        existing.endsAt.getTime() === slot.end.getTime();
      if (sameSlot) {
        const cal = await this.resolveCalendar(existing.calendarId, pool);
        if (cal) return { event: existing, cal };
      } else {
        this.logger.error(
          `Appointment ${appointmentId} já tem evento ativo em horário diferente do pedido — reserva recusada por segurança.`,
        );
        return null;
      }
    }
    const free = precomputedFree ?? (await this.freeCalendarsAt(pool, slot, rules));
    for (const cal of free) {
      const r = await this.insertBookingEvent(appointmentId, cal, slot, title, details);
      if (r.kind === "event") return { event: r.event, cal };
      if (r.kind === "twin") {
        const winner = await this.resolveCalendar(r.event.calendarId, pool);
        return { event: r.event, cal: winner ?? cal };
      }
      // kind === "taken": esta agenda foi ocupada por outro appointment — próxima
    }
    return null;
  }

  /**
   * Insere o evento da reserva na agenda `cal`. Distingue:
   * - "twin": o appointment JÁ tem evento ativo (concorrência/retry) → reusa;
   * - "taken": esta agenda+horário foi tomada por OUTRO appointment (exclusion) →
   *   o chamador tenta a próxima agenda do pool;
   * - "event": criou agora.
   */
  private async insertBookingEvent(
    appointmentId: string,
    cal: CalendarRow,
    slot: Slot,
    title: string,
    details: string,
  ): Promise<{ kind: "event" | "twin"; event: CalendarEventRow } | { kind: "taken" }> {
    const existing = await getEventByAppointment(appointmentId);
    if (existing) return { kind: "twin", event: existing };
    try {
      const event = await createCalendarEvent({
        calendarId: cal.id,
        title,
        description: details,
        startsAt: slot.start,
        endsAt: slot.end,
        source: "sdr",
        appointmentId,
      });
      return { kind: "event", event };
    } catch (err) {
      // O appointment ganhou um evento concorrente em ALGUMA agenda (índice
      // "1 ativo por appointment", 0036) → reusa o vencedor.
      if (isOneActivePerAppointment(err)) {
        const twin = await getEventByAppointment(appointmentId);
        if (twin) return { kind: "twin", event: twin };
        return { kind: "taken" };
      }
      // Double-booking desta agenda+horário por OUTRO appointment (exclusion
      // 0035): se for o gêmeo do próprio appointment, reusa; senão, agenda tomada.
      if (isExclusionViolation(err)) {
        const twin = await getEventByAppointment(appointmentId);
        if (twin) return { kind: "twin", event: twin };
        return { kind: "taken" };
      }
      throw err;
    }
  }

  /** Agendas do pool LIVRES em [slot), ordenadas por menor carga no dia (balanceio). */
  private async freeCalendarsAt(
    pool: CalendarRow[],
    slot: Slot,
    rules: SlotRules,
  ): Promise<CalendarRow[]> {
    const googleCals = pool.filter((c) => c.provider === "google" && c.externalCalendarId);
    const gBusy = googleCals.length
      ? await this.google.getBusyMulti(
          googleCals.map((c) => c.externalCalendarId!),
          slot.start,
          slot.end,
        )
      : new Map<string, BusyInterval[]>();

    const free: CalendarRow[] = [];
    for (const c of pool) {
      if (c.provider === "google" && c.externalCalendarId) {
        const busy = gBusy.get(c.externalCalendarId) ?? [];
        if (busy.some((b) => b.start < slot.end && b.end > slot.start)) continue;
      }
      if (await hasEventOverlap({ calendarId: c.id, startsAt: slot.start, endsAt: slot.end })) continue;
      free.push(c);
    }

    // Balanceio: recurso com MENOS eventos no dia primeiro; id como desempate
    // estável (turnos concorrentes tentam a mesma ordem → a exclusion serializa).
    if (free.length > 1) {
      const p = zonedParts(slot.start, rules.timezone);
      const dayStart = makeZoned(p.y, p.m, p.d, rules.hours.startHour, 0, rules.timezone);
      const dayEnd = makeZoned(p.y, p.m, p.d, rules.hours.endHour, 0, rules.timezone);
      const load = new Map<string, number>();
      for (const c of free) {
        const evs = await listCalendarEvents({ calendarId: c.id, from: dayStart, to: dayEnd });
        load.set(c.id, evs.length);
      }
      free.sort((a, b) => (load.get(a.id)! - load.get(b.id)!) || a.id.localeCompare(b.id));
    }
    return free;
  }

  /** Resolve a CalendarRow por id (pool primeiro; senão banco, inclui arquivada). */
  private async resolveCalendar(id: string, pool: CalendarRow[]): Promise<CalendarRow | null> {
    const inPool = pool.find((c) => c.id === id);
    if (inPool) return inPool;
    const rows = await getCalendarsByIds([id]);
    return rows[0] ?? null;
  }

  /**
   * Espelho no Google (quando a agenda vencedora é Google): falha NÃO desfaz a
   * reserva interna. Idempotente — evento já espelhado (retry) não duplica.
   */
  private async mirrorToGoogle(
    booked: BookedOnPool,
    rules: SlotRules,
    slot: Slot,
    title: string,
    details: string,
  ): Promise<boolean | null> {
    const { event, cal } = booked;
    if (!(cal.provider === "google" && cal.externalCalendarId)) return null;
    if (event.externalEventId) return true;
    try {
      const g = await this.google.createEvent(cal.externalCalendarId, {
        summary: title,
        description: details,
        start: slot.start,
        end: slot.end,
        timezone: rules.timezone,
      });
      await updateCalendarEvent(event.id, { externalEventId: g.id });
      return true;
    } catch (err) {
      this.logger.error(
        `Reserva ${event.appointmentId} feita, mas falhou o espelho no Google: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  /** Rótulo da reserva ATIVA da conversa (para o prompt do estado "scheduled"). */
  async activeBookingLabel(conversationId: string): Promise<string | null> {
    const appts = await listAppointmentsForConversation(conversationId);
    const active = appts.find(
      (a) => a.status === "confirmed" && a.startsAt && a.startsAt.getTime() > Date.now(),
    );
    return active?.whenText ?? null;
  }

  // ── internos ────────────────────────────────────────────────

  private async context(): Promise<{
    settings: SchedulingSettings;
    pool: CalendarRow[];
    rules: SlotRules;
  }> {
    const [settings, primary, pool] = await Promise.all([
      this.configSvc.forTenant(),
      ensureDefaultCalendar(),
      listPoolCalendars(),
    ]);
    const rules: SlotRules = {
      hours: settings.hours,
      // fuso da CLÍNICA (agenda default) — v1 assume um fuso por tenant.
      timezone: schedulingTimezone(primary.timezone),
      durationMinutes: settings.durationMinutes,
      slotStepMinutes: settings.slotStepMinutes,
      minNoticeMinutes: settings.minNoticeMinutes,
    };
    return { settings, pool, rules };
  }

  /** Ocupados por recurso (alinhado a `pool`): eventos internos + freebusy do Google. */
  private async busyByResource(
    pool: CalendarRow[],
    from: Date,
    to: Date,
  ): Promise<BusyInterval[][]> {
    const googleCals = pool.filter((c) => c.provider === "google" && c.externalCalendarId);
    const gBusy = googleCals.length
      ? await this.google.getBusyMulti(
          googleCals.map((c) => c.externalCalendarId!),
          from,
          to,
        )
      : new Map<string, BusyInterval[]>();

    const result: BusyInterval[][] = [];
    for (const c of pool) {
      const events = await listCalendarEvents({ calendarId: c.id, from, to });
      const busy: BusyInterval[] = events.map((e) => ({ start: e.startsAt, end: e.endsAt }));
      if (c.provider === "google" && c.externalCalendarId) {
        busy.push(...(gBusy.get(c.externalCalendarId) ?? []));
      }
      result.push(busy);
    }
    return result;
  }

  /**
   * Cancela a reserva SDR ativa da conversa (appointment + eventos + espelho
   * Google na agenda de CADA evento), EXCETO a recém-criada — chamado depois de
   * a nova reserva existir.
   */
  private async cancelActiveBooking(
    conversationId: string,
    excludeAppointmentId: string,
  ): Promise<boolean> {
    const appts = await listAppointmentsForConversation(conversationId);
    const active = appts.filter(
      (a) =>
        a.id !== excludeAppointmentId &&
        a.status === "confirmed" &&
        a.startsAt &&
        a.startsAt.getTime() > Date.now(),
    );
    let cancelled = false;
    for (const a of active) {
      await setAppointmentStatus(a.id, "cancelled");
      const events = await cancelEventsByAppointment(a.id);
      cancelled = true;
      const mirrored = events.filter((e) => e.externalEventId);
      if (mirrored.length === 0) continue;
      // resolve o external_calendar_id de cada agenda (pode estar arquivada)
      const cals = await getCalendarsByIds([...new Set(mirrored.map((e) => e.calendarId))]);
      const extById = new Map(
        cals
          .filter((c) => c.provider === "google" && c.externalCalendarId)
          .map((c) => [c.id, c.externalCalendarId!]),
      );
      for (const e of mirrored) {
        const ext = extById.get(e.calendarId);
        if (!ext) continue;
        await this.google
          .deleteEvent(ext, e.externalEventId!)
          .catch((err) =>
            this.logger.warn(
              `Falha ao cancelar espelho Google do evento ${e.id}: ${err instanceof Error ? err.message : err}`,
            ),
          );
      }
    }
    return cancelled;
  }

  /** Recusa com alternativas atuais — a SDR reoferece na mesma resposta. */
  private async reject(now: Date, reason: string): Promise<BookResult> {
    const s = await this.suggest(now).catch(() => null);
    const alternatives = s ? [s.manha, s.tarde].filter((x): x is LabeledSlot => x !== null) : [];
    return { ok: false, reason, alternatives };
  }
}

/** Violação da exclusion constraint (23P01) — em qualquer nível do wrap. */
function isExclusionViolation(err: unknown): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === "23P01") return true;
    if (e instanceof Error && e.message.includes("calendar_events_sdr_no_overlap")) return true;
  }
  return false;
}

/** Violação do índice "1 evento ativo por appointment" (23505, 0036). */
function isOneActivePerAppointment(err: unknown): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    // o driver pode expor a constraint sem repeti-la na message — cobre os dois.
    if ((e as { constraint?: string }).constraint === "calendar_events_one_active_per_appt") return true;
    if (e instanceof Error && e.message.includes("calendar_events_one_active_per_appt")) return true;
  }
  return false;
}

function toLabeled(slot: Slot, timezone: string): LabeledSlot {
  return {
    startsAt: slot.start.toISOString(),
    label: formatSlotLabel(slot, timezone),
    period: slotPeriod(slot, timezone),
  };
}
