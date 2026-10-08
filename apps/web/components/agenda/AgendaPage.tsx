"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendar,
  getCalendarEvents,
  updateCalendarEvent,
  type CalendarEvent,
  type CalendarInfo,
} from "../../lib/api";
import { Button, ConfirmDialog, ErrorState, SkeletonBlock } from "../ui";
import { useToast } from "../toast";
import s from "./agenda.module.css";
import { MiniMonth } from "./MiniMonth";
import { WeekGrid } from "./WeekGrid";
import { MonthView } from "./MonthView";
import { EventDetails, EventModal, type EventFormInit, type EventFormValues } from "./EventModal";
import {
  DOW_LONG,
  MONTHS,
  MONTHS_SHORT,
  addDays,
  addMonths,
  dayOfWeek,
  startOfDayUtc,
  startOfWeek,
  todayYmd,
  zonedParts,
  zonedTimeToUtc,
  type Ymd,
} from "./date-utils";

type ViewMode = "month" | "week" | "day";
const VIEW_LABELS: Array<{ v: ViewMode; l: string }> = [
  { v: "month", l: "Mês" },
  { v: "week", l: "Semana" },
  { v: "day", l: "Dia" },
];
const FALLBACK_TZ = "America/Sao_Paulo";

/** Página da Agenda (área do cliente) — visão mês/semana/dia estilo Google Agenda. */
export function AgendaPage() {
  const toast = useToast();

  const [calendar, setCalendar] = useState<CalendarInfo | null>(null);
  const [calError, setCalError] = useState("");
  const [view, setView] = useState<ViewMode>("week");
  // Dia "âncora" (selecionado) — só nasce depois do calendário, pois o "hoje"
  // depende do FUSO do calendário, não do navegador.
  const [anchor, setAnchor] = useState<Ymd | null>(null);

  const loadCalendar = useCallback(() => {
    setCalError("");
    getCalendar()
      .then((res) => {
        setCalendar(res.calendar);
        setAnchor((prev) => prev ?? todayYmd(res.calendar.timezone || FALLBACK_TZ));
      })
      .catch((e: Error) => setCalError(e.message));
  }, []);
  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  const tz = calendar?.timezone || FALLBACK_TZ;

  // Período visível → dias-parede da grade + janela [from, to) em instantes UTC.
  const range = useMemo(() => {
    if (!anchor) return null;
    if (view === "day") {
      return { days: [anchor], from: startOfDayUtc(anchor, tz), to: startOfDayUtc(addDays(anchor, 1), tz) };
    }
    if (view === "week") {
      const ws = startOfWeek(anchor);
      const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
      return { days, from: startOfDayUtc(ws, tz), to: startOfDayUtc(addDays(ws, 7), tz) };
    }
    const gs = startOfWeek({ y: anchor.y, m: anchor.m, d: 1 });
    const days = Array.from({ length: 42 }, (_, i) => addDays(gs, i)); // 6 semanas fixas
    return { days, from: startOfDayUtc(gs, tz), to: startOfDayUtc(addDays(gs, 42), tz) };
  }, [anchor, view, tz]);

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [evError, setEvError] = useState("");
  const fromIso = range?.from.toISOString() ?? "";
  const toIso = range?.to.toISOString() ?? "";
  // Guarda de sequência: navegação rápida entre períodos não pode deixar uma
  // resposta atrasada sobrescrever os eventos do período atual.
  const seqRef = useRef(0);
  const loadEvents = useCallback(() => {
    if (!fromIso || !toIso) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setEvError("");
    getCalendarEvents(fromIso, toIso)
      .then((res) => {
        if (seqRef.current === seq) setEvents(res.events.filter((ev) => ev.status !== "cancelled"));
      })
      .catch((e: Error) => {
        if (seqRef.current === seq) setEvError(e.message);
      })
      .finally(() => {
        if (seqRef.current === seq) setLoading(false);
      });
  }, [fromIso, toIso]);
  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const title = useMemo(() => {
    if (!anchor || !range) return "";
    if (view === "month") return `${MONTHS[anchor.m - 1]} de ${anchor.y}`;
    if (view === "day") return `${DOW_LONG[dayOfWeek(anchor)]}, ${anchor.d} de ${MONTHS[anchor.m - 1]} de ${anchor.y}`;
    const a = range.days[0];
    const b = range.days[range.days.length - 1];
    if (a.m === b.m) return `${a.d} – ${b.d} de ${MONTHS_SHORT[a.m - 1]} de ${a.y}`;
    if (a.y === b.y) return `${a.d} ${MONTHS_SHORT[a.m - 1]} – ${b.d} ${MONTHS_SHORT[b.m - 1]} ${a.y}`;
    return `${a.d} ${MONTHS_SHORT[a.m - 1]} ${a.y} – ${b.d} ${MONTHS_SHORT[b.m - 1]} ${b.y}`;
  }, [anchor, range, view]);

  function navigate(dir: -1 | 1) {
    if (!anchor) return;
    setAnchor(view === "month" ? addMonths(anchor, dir) : addDays(anchor, dir * (view === "week" ? 7 : 1)));
  }

  // ── Criar / editar / excluir ──
  const [form, setForm] = useState<EventFormInit | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [details, setDetails] = useState<CalendarEvent | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [delBusy, setDelBusy] = useState(false);

  function openCreate(day?: Ymd, startMin = 9 * 60) {
    const date = day ?? anchor ?? todayYmd(tz);
    const crossesDay = startMin + 60 >= 24 * 60; // 23:30 → termina 00:30 do dia seguinte
    setFormError("");
    setForm({
      title: "",
      description: "",
      startDate: date,
      endDate: crossesDay ? addDays(date, 1) : date,
      startMin,
      endMin: (startMin + 60) % (24 * 60),
      allDay: false,
    });
  }

  function openEdit(ev: CalendarEvent) {
    const st = new Date(ev.startsAt);
    const en = new Date(Math.max(new Date(ev.endsAt).getTime(), st.getTime()));
    const p = zonedParts(st, tz);
    // dia inteiro tem fim EXCLUSIVO (meia-noite) — -1ms devolve a data final inclusiva
    const pe = zonedParts(ev.allDay && en.getTime() > st.getTime() ? new Date(en.getTime() - 1) : en, tz);
    setDetails(null);
    setFormError("");
    setForm({
      id: ev.id,
      title: ev.title,
      description: ev.description ?? "",
      startDate: { y: p.y, m: p.m, d: p.d },
      endDate: { y: pe.y, m: pe.m, d: pe.d },
      startMin: ev.allDay ? 9 * 60 : p.hh * 60 + p.mm,
      endMin: ev.allDay ? 10 * 60 : pe.hh * 60 + pe.mm,
      allDay: ev.allDay,
    });
  }

  async function saveForm(values: EventFormValues) {
    setFormBusy(true);
    setFormError("");
    const startsAt = values.allDay
      ? startOfDayUtc(values.startDate, tz)
      : zonedTimeToUtc(values.startDate, Math.floor(values.startMin / 60), values.startMin % 60, tz);
    const endsAt = values.allDay
      ? startOfDayUtc(addDays(values.endDate, 1), tz) // data final inclusiva → fim exclusivo
      : zonedTimeToUtc(values.endDate, Math.floor(values.endMin / 60), values.endMin % 60, tz);
    try {
      if (form?.id) {
        await updateCalendarEvent(form.id, {
          title: values.title,
          description: values.description,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          allDay: values.allDay,
        });
        toast("✓ Evento atualizado");
      } else {
        await createCalendarEvent({
          title: values.title,
          ...(values.description ? { description: values.description } : {}),
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          allDay: values.allDay,
        });
        toast("✓ Evento criado");
      }
      setForm(null);
      loadEvents();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setFormBusy(false);
    }
  }

  async function doDelete() {
    if (!details) return;
    setDelBusy(true);
    try {
      await deleteCalendarEvent(details.id);
      toast("✓ Evento excluído");
      setDetails(null);
      loadEvents();
    } catch (e) {
      toast((e as Error).message || "Não foi possível excluir o evento");
    } finally {
      setDelBusy(false);
      setConfirmDel(false);
    }
  }

  function goToDay(day: Ymd) {
    setAnchor(day);
    setView("day");
  }

  // ── Estados de página (calendário ainda não carregou) ──
  if (calError && !calendar) {
    return (
      <div>
        <h1 className="h1-page" style={{ marginBottom: 18 }}>Agenda</h1>
        <ErrorState message="Não conseguimos carregar sua agenda agora." detail={calError} onRetry={loadCalendar} />
      </div>
    );
  }
  if (!calendar || !anchor || !range) {
    return (
      <div>
        <h1 className="h1-page" style={{ marginBottom: 18 }}>Agenda</h1>
        <div className={s.layout} aria-busy="true">
          <div className={s.side}>
            <SkeletonBlock height={38} style={{ borderRadius: 9 }} />
            <SkeletonBlock height={230} style={{ borderRadius: 12 }} />
          </div>
          <div className={s.mainCol}>
            <SkeletonBlock height={32} width={340} style={{ marginBottom: 14, borderRadius: 8 }} />
            <SkeletonBlock height={460} style={{ borderRadius: 12 }} />
          </div>
        </div>
      </div>
    );
  }

  const today = todayYmd(tz);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
        <h1 className="h1-page">Agenda</h1>
        <span className="caption">{calendar.name} · fuso {calendar.timezone}</span>
      </div>

      <div className={s.layout}>
        <div className={s.side}>
          <Button onClick={() => openCreate()}>＋ Criar</Button>
          <MiniMonth selected={anchor} today={today} onSelect={setAnchor} />
        </div>

        <div className={s.mainCol}>
          <div className={s.toolbar}>
            <Button variant="secondary" size="sm" onClick={() => setAnchor(todayYmd(tz))}>Hoje</Button>
            <button type="button" className={s.navArrow} aria-label="Período anterior" onClick={() => navigate(-1)}>‹</button>
            <button type="button" className={s.navArrow} aria-label="Próximo período" onClick={() => navigate(1)}>›</button>
            <h2 className={s.periodTitle}>{title}</h2>
            <div className={s.viewSwitch} role="group" aria-label="Modo de visão">
              {VIEW_LABELS.map(({ v, l }) => (
                <button
                  key={v}
                  type="button"
                  className={[s.viewBtn, view === v ? s.viewBtnOn : ""].filter(Boolean).join(" ")}
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>

          {evError && (
            <div style={{ marginBottom: 12 }}>
              <ErrorState message="Não conseguimos buscar os eventos deste período." detail={evError} onRetry={loadEvents} />
            </div>
          )}
          {loading && (
            <div className={s.loadingBar} aria-hidden>
              <div className={s.loadingBarFill} />
            </div>
          )}

          {view === "month" ? (
            <MonthView
              cells={range.days}
              month={anchor.m}
              today={today}
              tz={tz}
              events={events}
              onEmptyClick={(day) => openCreate(day)}
              onDayNumClick={goToDay}
              onMoreClick={goToDay}
              onEventClick={setDetails}
            />
          ) : (
            <WeekGrid
              days={range.days}
              tz={tz}
              events={events}
              onSlotClick={(day, startMin) => openCreate(day, startMin)}
              onEventClick={setDetails}
              onDayClick={view === "week" ? goToDay : undefined}
            />
          )}
        </div>
      </div>

      {form && (
        <EventModal
          initial={form}
          busy={formBusy}
          error={formError}
          onClose={() => setForm(null)}
          onSave={(values) => void saveForm(values)}
        />
      )}
      {details && !confirmDel && (
        <EventDetails
          event={details}
          tz={tz}
          busy={delBusy}
          onEdit={() => openEdit(details)}
          onDelete={() => setConfirmDel(true)}
          onClose={() => setDetails(null)}
        />
      )}
      <ConfirmDialog
        open={confirmDel}
        title="Excluir evento"
        message={details ? `Excluir "${details.title}"? Essa ação não pode ser desfeita.` : ""}
        confirmLabel="Excluir"
        danger
        busy={delBusy}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDel(false)}
      />
    </div>
  );
}
