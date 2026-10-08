import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulingService } from "./scheduling.service";
import {
  DEFAULT_SCHEDULING_SETTINGS,
  type SchedulingConfigService,
} from "./scheduling-config.service";
import type { GoogleCalendarService } from "./google-calendar.service";

// @sdr/db mockado — o teste exercita a lógica do pool sem tocar banco.
const db = {
  ensureDefaultCalendar: vi.fn(),
  listPoolCalendars: vi.fn(),
  listCalendarEvents: vi.fn(),
  getEventByAppointment: vi.fn(),
  hasEventOverlap: vi.fn(),
  createCalendarEvent: vi.fn(),
  createAppointment: vi.fn(),
  setAppointmentStatus: vi.fn(),
  setAppointmentCalendar: vi.fn(),
  listAppointmentsForConversation: vi.fn(),
  cancelEventsByAppointment: vi.fn(),
  getCalendarsByIds: vi.fn(),
  updateCalendarEvent: vi.fn(),
};
vi.mock("@sdr/db", () => ({
  ensureDefaultCalendar: (...a: unknown[]) => db.ensureDefaultCalendar(...a),
  listPoolCalendars: (...a: unknown[]) => db.listPoolCalendars(...a),
  listCalendarEvents: (...a: unknown[]) => db.listCalendarEvents(...a),
  getEventByAppointment: (...a: unknown[]) => db.getEventByAppointment(...a),
  hasEventOverlap: (...a: unknown[]) => db.hasEventOverlap(...a),
  createCalendarEvent: (...a: unknown[]) => db.createCalendarEvent(...a),
  createAppointment: (...a: unknown[]) => db.createAppointment(...a),
  setAppointmentStatus: (...a: unknown[]) => db.setAppointmentStatus(...a),
  setAppointmentCalendar: (...a: unknown[]) => db.setAppointmentCalendar(...a),
  listAppointmentsForConversation: (...a: unknown[]) => db.listAppointmentsForConversation(...a),
  cancelEventsByAppointment: (...a: unknown[]) => db.cancelEventsByAppointment(...a),
  getCalendarsByIds: (...a: unknown[]) => db.getCalendarsByIds(...a),
  updateCalendarEvent: (...a: unknown[]) => db.updateCalendarEvent(...a),
}));

const TZ = "America/Sao_Paulo";
const calA = { id: "cal-a", name: "Recurso A", timezone: TZ, provider: "internal", externalCalendarId: null, isDefault: true };
const calB = { id: "cal-b", name: "Recurso B", timezone: TZ, provider: "internal", externalCalendarId: null, isDefault: false };
const SETTINGS = { ...DEFAULT_SCHEDULING_SETTINGS, enabled: true };

const NOW = new Date("2026-07-29T15:00:00-03:00"); // quarta 15:00 BR
const SLOT_ISO = "2026-07-30T12:00:00.000Z"; // quinta 09:00 BR — dentro da grade/janela

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeEvent = (input: any) => ({
  id: `ev-${input.calendarId}`,
  calendarId: input.calendarId,
  title: input.title,
  description: input.description ?? null,
  startsAt: input.startsAt,
  endsAt: input.endsAt,
  allDay: false,
  status: "confirmed",
  source: "sdr",
  appointmentId: input.appointmentId ?? null,
  externalEventId: null,
});

const google = {
  getBusyMulti: vi.fn(async () => new Map()),
  createEvent: vi.fn(),
  deleteEvent: vi.fn(async () => undefined),
  isConfigured: () => false,
  serviceAccountEmail: () => null,
} as unknown as GoogleCalendarService;

const config = { forTenant: async () => SETTINGS } as unknown as SchedulingConfigService;

function makeService(): SchedulingService {
  return new SchedulingService(config, google);
}

beforeEach(() => {
  db.ensureDefaultCalendar.mockResolvedValue(calA);
  db.listPoolCalendars.mockResolvedValue([calA, calB]);
  db.listCalendarEvents.mockResolvedValue([]);
  db.getEventByAppointment.mockResolvedValue(null);
  db.hasEventOverlap.mockResolvedValue(false);
  db.listAppointmentsForConversation.mockResolvedValue([]);
  db.cancelEventsByAppointment.mockResolvedValue([]);
  db.getCalendarsByIds.mockResolvedValue([]);
  db.setAppointmentStatus.mockResolvedValue(true);
  db.setAppointmentCalendar.mockResolvedValue(undefined);
  db.updateCalendarEvent.mockResolvedValue(null);
  db.createAppointment.mockResolvedValue({ appointmentId: "appt1", created: true, calendarId: null });
  db.createCalendarEvent.mockImplementation(async (input: unknown) => makeEvent(input));
});

afterEach(() => vi.clearAllMocks());

describe("SchedulingService.book — pool de recursos (0036)", () => {
  it("escolhe um recurso livre e grava o calendar_id da reserva", async () => {
    const r = await makeService().book({ conversationId: "c1", startsAtIso: SLOT_ISO, now: NOW });
    expect(r.ok).toBe(true);
    // ambos carga 0 → desempate estável por id (cal-a < cal-b)
    expect(db.createCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: "cal-a", source: "sdr", appointmentId: "appt1" }),
    );
    expect(db.setAppointmentCalendar).toHaveBeenCalledWith("appt1", "cal-a");
  });

  it("recurso tomado no insert (exclusion) → cai no próximo livre do pool", async () => {
    db.createCalendarEvent.mockImplementation(async (input: unknown) => {
      const calendarId = (input as { calendarId: string }).calendarId;
      if (calendarId === "cal-a") {
        const e = new Error("conflita: calendar_events_sdr_no_overlap") as Error & { code?: string };
        e.code = "23P01";
        throw e;
      }
      return makeEvent(input);
    });
    const r = await makeService().book({ conversationId: "c1", startsAtIso: SLOT_ISO, now: NOW });
    expect(r.ok).toBe(true);
    expect(db.setAppointmentCalendar).toHaveBeenCalledWith("appt1", "cal-b");
  });

  it("nenhum recurso livre → recusa ANTES de criar appointment, com alternativas", async () => {
    db.hasEventOverlap.mockResolvedValue(true); // todo o pool ocupado no horário
    const r = await makeService().book({ conversationId: "c1", startsAtIso: SLOT_ISO, now: NOW });
    expect(r.ok).toBe(false);
    expect(db.createAppointment).not.toHaveBeenCalled();
  });

  it("horário fora da grade não passa mesmo com recurso livre", async () => {
    const r = await makeService().book({
      conversationId: "c1",
      startsAtIso: "2026-07-30T12:17:00.000Z", // 09:17 — desalinhado do passo de 30min
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(db.createCalendarEvent).not.toHaveBeenCalled();
  });
});

describe("SchedulingService.suggest — união do pool", () => {
  it("um recurso lotado no horizonte não bloqueia: sugere do outro", async () => {
    db.listCalendarEvents.mockImplementation(async (input: unknown) => {
      const calendarId = (input as { calendarId: string }).calendarId;
      if (calendarId !== "cal-a") return [];
      return [
        {
          id: "busyA",
          calendarId: "cal-a",
          title: "cheio",
          description: null,
          startsAt: new Date("2026-07-01T00:00:00Z"),
          endsAt: new Date("2026-09-01T00:00:00Z"),
          allDay: false,
          status: "confirmed",
          source: "manual",
          appointmentId: null,
          externalEventId: null,
        },
      ];
    });
    const s = await makeService().suggest(NOW);
    expect(Boolean(s.manha || s.tarde)).toBe(true);
  });
});
