"use client";

import { useMemo } from "react";
import type { CalendarEvent } from "../../lib/api";
import s from "./agenda.module.css";
import { DOW_SHORT, addDays, fmtMinutes, minutesOfDay, sameYmd, ymdKey, zonedParts, type Ymd } from "./date-utils";

const MAX_CHIPS = 3;

/** Dias-parede (no fuso) cobertos pelo evento — fim é exclusivo na meia-noite exata. */
function coveredDays(ev: CalendarEvent, tz: string): Ymd[] {
  const st = new Date(ev.startsAt);
  const en = new Date(Math.max(new Date(ev.endsAt).getTime(), st.getTime()));
  const first = zonedParts(st, tz);
  // -1ms: evento que termina exatamente às 00:00 não ocupa o dia seguinte
  const lastInstant = en.getTime() > st.getTime() ? new Date(en.getTime() - 1) : st;
  const last = zonedParts(lastInstant, tz);
  const days: Ymd[] = [];
  let cur: Ymd = { y: first.y, m: first.m, d: first.d };
  const end: Ymd = { y: last.y, m: last.m, d: last.d };
  for (let i = 0; i < 60; i++) {
    days.push(cur);
    if (sameYmd(cur, end)) break;
    cur = addDays(cur, 1);
  }
  return days;
}

export function MonthView({
  cells,
  month,
  today,
  tz,
  events,
  onEmptyClick,
  onDayNumClick,
  onEventClick,
  onMoreClick,
}: {
  /** 42 células (6 semanas) a partir do domingo da 1ª semana do mês. */
  cells: Ymd[];
  /** Mês "corrente" da visão (células fora dele ficam esmaecidas). */
  month: number;
  today: Ymd;
  tz: string;
  events: CalendarEvent[];
  onEmptyClick: (day: Ymd) => void;
  onDayNumClick: (day: Ymd) => void;
  onEventClick: (ev: CalendarEvent) => void;
  onMoreClick: (day: Ymd) => void;
}) {
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      for (const day of coveredDays(ev, tz)) {
        const key = ymdKey(day);
        const list = map.get(key) ?? [];
        list.push(ev);
        map.set(key, list);
      }
    }
    for (const list of map.values()) {
      // dia inteiro primeiro, depois por horário — mesma ordem do Google
      list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt.localeCompare(b.startsAt));
    }
    return map;
  }, [events, tz]);

  return (
    <div className={s.monthWrap}>
      <div className={s.monthDows}>
        {DOW_SHORT.map((d) => (
          <span key={d} className={s.monthDow}>{d.replace(".", "")}</span>
        ))}
      </div>
      <div className={s.monthGrid}>
        {cells.map((day) => {
          const key = ymdKey(day);
          const list = byDay.get(key) ?? [];
          const visible = list.slice(0, MAX_CHIPS);
          const hidden = list.length - visible.length;
          const isToday = sameYmd(day, today);
          const out = day.m !== month;
          return (
            <div
              key={key}
              className={[s.mCell, out ? s.mCellOut : ""].filter(Boolean).join(" ")}
              role="button"
              tabIndex={0}
              aria-label={`Criar evento em ${key}`}
              onClick={() => onEmptyClick(day)}
              onKeyDown={(e) => {
                // só a própria célula (keydown dos chips/número borbulha até aqui)
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onEmptyClick(day);
                }
              }}
            >
              <button
                type="button"
                className={[s.mDayNum, out ? s.mDayNumOut : "", isToday ? s.mDayNumToday : ""].filter(Boolean).join(" ")}
                onClick={(e) => {
                  e.stopPropagation();
                  onDayNumClick(day);
                }}
                aria-label={`Ver dia ${day.d}/${day.m}/${day.y}`}
              >
                {day.d}
              </button>
              {visible.map((ev) => {
                const sdr = ev.source === "sdr";
                // hora só no dia em que o evento COMEÇA (dias de continuação ficam sem)
                const startsHere = ymdKey(zonedParts(new Date(ev.startsAt), tz)) === key;
                if (ev.allDay) {
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      className={[s.mChip, sdr ? s.evSdr : s.evManual].join(" ")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEventClick(ev);
                      }}
                      title={ev.title}
                    >
                      {sdr && <span className={s.sdrTag}>SDR</span>}
                      {ev.title}
                    </button>
                  );
                }
                return (
                  <button
                    key={ev.id}
                    type="button"
                    className={[s.mChip, s.mChipTimed].join(" ")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(ev);
                    }}
                    title={ev.title}
                  >
                    <span className={s.mChipDot} style={{ background: sdr ? "var(--red-600)" : "var(--ink-800)" }} />
                    {startsHere && <span className={s.mChipTime}>{fmtMinutes(minutesOfDay(new Date(ev.startsAt), tz))}</span>}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{ev.title}</span>
                  </button>
                );
              })}
              {hidden > 0 && (
                <button
                  type="button"
                  className={s.mMore}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoreClick(day);
                  }}
                >
                  mais {hidden}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
