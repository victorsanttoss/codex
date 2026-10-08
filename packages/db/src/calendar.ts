import { and, eq, gt, inArray, isNull, lt, ne } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { calendarEvents, calendars } from "./schema";

// ── Agenda da plataforma (0034) ───────────────────────────────

export interface CalendarRow {
  id: string;
  name: string;
  timezone: string;
  provider: string;
  externalCalendarId: string | null;
  isDefault: boolean;
}

export interface CalendarEventRow {
  id: string;
  calendarId: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  status: string;
  source: string;
  appointmentId: string | null;
  externalEventId: string | null;
}

const calendarCols = {
  id: calendars.id,
  name: calendars.name,
  timezone: calendars.timezone,
  provider: calendars.provider,
  externalCalendarId: calendars.externalCalendarId,
  isDefault: calendars.isDefault,
};

const eventCols = {
  id: calendarEvents.id,
  calendarId: calendarEvents.calendarId,
  title: calendarEvents.title,
  description: calendarEvents.description,
  startsAt: calendarEvents.startsAt,
  endsAt: calendarEvents.endsAt,
  allDay: calendarEvents.allDay,
  status: calendarEvents.status,
  source: calendarEvents.source,
  appointmentId: calendarEvents.appointmentId,
  externalEventId: calendarEvents.externalEventId,
};

/**
 * Agenda DEFAULT do tenant — cria na primeira leitura (todo tenant tem uma).
 * onConflictDoNothing no índice parcial (tenant_id WHERE is_default) cobre a
 * corrida de duas criações simultâneas.
 */
export async function ensureDefaultCalendar(): Promise<CalendarRow> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const existing = await tx
      .select(calendarCols)
      .from(calendars)
      .where(and(eq(calendars.tenantId, tenantId), eq(calendars.isDefault, true)));
    if (existing[0]) return existing[0];
    await tx
      .insert(calendars)
      .values({ tenantId })
      .onConflictDoNothing();
    const created = await tx
      .select(calendarCols)
      .from(calendars)
      .where(and(eq(calendars.tenantId, tenantId), eq(calendars.isDefault, true)));
    return created[0]!;
  });
}

/** Vincula/desvincula a agenda externa (Google) da agenda default do tenant. */
export async function updateCalendarLink(input: {
  provider: "internal" | "google";
  externalCalendarId?: string | null;
  timezone?: string;
}): Promise<CalendarRow> {
  const { tenantId } = requireTenantContext();
  const cal = await ensureDefaultCalendar();
  return withTenant(async (tx) => {
    const rows = await tx
      .update(calendars)
      .set({
        provider: input.provider,
        externalCalendarId: input.provider === "google" ? (input.externalCalendarId ?? null) : null,
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(calendars.tenantId, tenantId), eq(calendars.id, cal.id)))
      .returning(calendarCols);
    return rows[0]!;
  });
}

// ── Pool de agendas (0036): N agendas por tenant, uma por recurso ────────────

/** Todas as agendas ATIVAS (não arquivadas) do tenant, default primeiro. */
export async function listCalendars(): Promise<CalendarRow[]> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select(calendarCols)
      .from(calendars)
      .where(and(eq(calendars.tenantId, tenantId), isNull(calendars.archivedAt)))
      .orderBy(calendars.createdAt);
    return rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  });
}

/**
 * POOL de agendamento do tenant: as agendas onde a SDR pode reservar. Regra:
 * se houver QUALQUER agenda Google vinculada e ativa, o pool são ELAS (uma por
 * recurso — doutor/vendedor/corretor); senão, cai na agenda interna default
 * (fluxo solo). Sempre retorna ≥1 (garante a default na ausência de Google).
 */
export async function listPoolCalendars(): Promise<CalendarRow[]> {
  const cals = await listCalendars();
  const google = cals.filter((c) => c.provider === "google" && c.externalCalendarId);
  if (google.length > 0) return google;
  // Fallback SOLO: a agenda interna DEFAULT (não N internas soltas — o pool
  // multi-recurso é sempre via Google; internas extras não viram recursos).
  const primary = cals.find((c) => c.isDefault && c.provider === "internal");
  return [primary ?? (await ensureDefaultCalendar())];
}

/** Agendas por id (INCLUI arquivadas) — o cancelamento precisa da agenda antiga. */
export async function getCalendarsByIds(ids: string[]): Promise<CalendarRow[]> {
  if (ids.length === 0) return [];
  const { tenantId } = requireTenantContext();
  return withTenant((tx) =>
    tx
      .select(calendarCols)
      .from(calendars)
      .where(and(eq(calendars.tenantId, tenantId), inArray(calendars.id, ids))),
  );
}

/**
 * Adiciona uma agenda ao pool (recurso extra). Entra com is_default=false (não
 * colide com o índice parcial de "1 default"). O índice único GLOBAL em
 * external_calendar_id garante que a mesma agenda Google não sirva a 2 tenants
 * (o chamador traduz a violação 23505).
 */
export async function addCalendar(input: {
  name: string;
  provider: "internal" | "google";
  externalCalendarId?: string | null;
  timezone?: string;
}): Promise<CalendarRow> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .insert(calendars)
      .values({
        tenantId,
        name: input.name,
        provider: input.provider,
        externalCalendarId:
          input.provider === "google" ? (input.externalCalendarId ?? null) : null,
        isDefault: false,
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      })
      .returning(calendarCols);
    return rows[0]!;
  });
}

/** Renomeia/re-vincula uma agenda específica do pool (por id). */
export async function updateCalendar(
  id: string,
  patch: {
    name?: string;
    provider?: "internal" | "google";
    externalCalendarId?: string | null;
    timezone?: string;
  },
): Promise<CalendarRow | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.timezone !== undefined) set.timezone = patch.timezone;
    if (patch.provider !== undefined) {
      set.provider = patch.provider;
      // troca de provider zera/define o vínculo externo de forma coerente
      set.externalCalendarId =
        patch.provider === "google" ? (patch.externalCalendarId ?? null) : null;
    } else if (patch.externalCalendarId !== undefined) {
      set.externalCalendarId = patch.externalCalendarId;
    }
    const rows = await tx
      .update(calendars)
      .set(set)
      .where(and(eq(calendars.tenantId, tenantId), eq(calendars.id, id)))
      .returning(calendarCols);
    return rows[0] ?? null;
  });
}

/**
 * Remove uma agenda do pool (soft): marca archived_at. NÃO deixa arquivar a
 * default (a interna de fallback) nem a última agenda ativa — o tenant sempre
 * precisa de ≥1 agenda pra SDR agendar.
 */
export async function archiveCalendar(id: string): Promise<{ ok: boolean; reason?: string }> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const target = await tx
      .select(calendarCols)
      .from(calendars)
      .where(and(eq(calendars.tenantId, tenantId), eq(calendars.id, id), isNull(calendars.archivedAt)));
    if (!target[0]) return { ok: false, reason: "not_found" };
    if (target[0].isDefault) return { ok: false, reason: "is_default" };
    const active = await tx
      .select({ id: calendars.id })
      .from(calendars)
      .where(and(eq(calendars.tenantId, tenantId), isNull(calendars.archivedAt)));
    if (active.length <= 1) return { ok: false, reason: "last_calendar" };
    await tx
      .update(calendars)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(calendars.tenantId, tenantId), eq(calendars.id, id)));
    return { ok: true };
  });
}

/** Eventos que INTERSECTAM o range [from, to) — para a UI e a disponibilidade. */
export async function listCalendarEvents(input: {
  calendarId: string;
  from: Date;
  to: Date;
  includeCancelled?: boolean;
}): Promise<CalendarEventRow[]> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const conds = [
      eq(calendarEvents.tenantId, tenantId),
      eq(calendarEvents.calendarId, input.calendarId),
      lt(calendarEvents.startsAt, input.to),
      gt(calendarEvents.endsAt, input.from),
    ];
    if (!input.includeCancelled) conds.push(ne(calendarEvents.status, "cancelled"));
    return tx
      .select(eventCols)
      .from(calendarEvents)
      .where(and(...conds))
      .orderBy(calendarEvents.startsAt);
  });
}

export interface CreateCalendarEventInput {
  calendarId: string;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
  allDay?: boolean;
  source?: "manual" | "sdr";
  appointmentId?: string;
  externalEventId?: string;
}

export async function createCalendarEvent(
  input: CreateCalendarEventInput,
): Promise<CalendarEventRow> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .insert(calendarEvents)
      .values({
        tenantId,
        calendarId: input.calendarId,
        title: input.title,
        description: input.description ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        allDay: input.allDay ?? false,
        source: input.source ?? "manual",
        appointmentId: input.appointmentId ?? null,
        externalEventId: input.externalEventId ?? null,
      })
      .returning(eventCols);
    return rows[0]!;
  });
}

export async function updateCalendarEvent(
  id: string,
  patch: Partial<{
    title: string;
    description: string | null;
    startsAt: Date;
    endsAt: Date;
    allDay: boolean;
    status: "confirmed" | "cancelled";
    externalEventId: string | null;
  }>,
): Promise<CalendarEventRow | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .update(calendarEvents)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.id, id)))
      .returning(eventCols);
    return rows[0] ?? null;
  });
}

export async function getCalendarEvent(id: string): Promise<CalendarEventRow | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select(eventCols)
      .from(calendarEvents)
      .where(and(eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.id, id)));
    return rows[0] ?? null;
  });
}

/** Evento ATIVO ligado ao appointment — o retry da reserva confere/completa por aqui. */
export async function getEventByAppointment(
  appointmentId: string,
): Promise<CalendarEventRow | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select(eventCols)
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.tenantId, tenantId),
          eq(calendarEvents.appointmentId, appointmentId),
          ne(calendarEvents.status, "cancelled"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function deleteCalendarEvent(id: string): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .delete(calendarEvents)
      .where(and(eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.id, id)))
      .returning({ id: calendarEvents.id });
    return rows.length > 0;
  });
}

/**
 * Existe evento CONFIRMADO colidindo com [startsAt, endsAt)? PRÉ-checagem da
 * reserva da SDR (cobre também eventos manuais); a corrida sdr×sdr é fechada
 * NO BANCO pela exclusion constraint da 0035 (o serviço traduz o 23P01).
 */
export async function hasEventOverlap(input: {
  calendarId: string;
  startsAt: Date;
  endsAt: Date;
}): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ id: calendarEvents.id })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.tenantId, tenantId),
          eq(calendarEvents.calendarId, input.calendarId),
          ne(calendarEvents.status, "cancelled"),
          lt(calendarEvents.startsAt, input.endsAt),
          gt(calendarEvents.endsAt, input.startsAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}

/**
 * Cancela eventos ligados a um appointment (remarcação da SDR). Retorna os
 * external_event_id para o chamador espelhar o cancelamento no provedor externo.
 */
export async function cancelEventsByAppointment(
  appointmentId: string,
): Promise<Array<{ id: string; calendarId: string; externalEventId: string | null }>> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    return tx
      .update(calendarEvents)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(calendarEvents.tenantId, tenantId),
          eq(calendarEvents.appointmentId, appointmentId),
          ne(calendarEvents.status, "cancelled"),
        ),
      )
      .returning({
        id: calendarEvents.id,
        calendarId: calendarEvents.calendarId,
        externalEventId: calendarEvents.externalEventId,
      });
  });
}
