"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { CalendarEvent } from "../../lib/api";
import s from "./agenda.module.css";
import {
  DOW_SHORT,
  dayOfWeek,
  fmtMinutes,
  minutesOfDay,
  sameYmd,
  startOfDayUtc,
  todayYmd,
  ymdKey,
  zonedParts,
  type Ymd,
} from "./date-utils";

const HOUR_PX = 48;
const DAY_MIN = 24 * 60;
/** Altura mínima de exibição (evento curto ainda precisa ser clicável/legível). */
const MIN_RENDER_MIN = 30;

interface Segment {
  ev: CalendarEvent;
  startMin: number;
  endMin: number;
  /** Horário real (pode diferir do recorte quando o evento cruza a meia-noite). */
  label: string;
}
interface Positioned extends Segment {
  col: number;
  cols: number;
}

/**
 * Layout de sobreposição estilo Google: eventos que se cruzam dividem a largura
 * da coluna. Clusters (componentes conexos de sobreposição) são resolvidos de
 * forma independente; dentro do cluster cada evento pega a 1ª coluna livre.
 */
function layoutSegments(segs: Segment[]): Positioned[] {
  const sorted = [...segs].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: Positioned[] = [];
  let cluster: Positioned[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const cols = Math.max(1, colEnds.length);
    for (const p of cluster) p.cols = cols;
    out.push(...cluster);
    cluster = [];
    colEnds = [];
    clusterEnd = -Infinity;
  };

  for (const seg of sorted) {
    const visEnd = Math.max(seg.endMin, seg.startMin + MIN_RENDER_MIN);
    if (cluster.length > 0 && seg.startMin >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= seg.startMin);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(0);
    }
    colEnds[col] = visEnd;
    cluster.push({ ...seg, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, visEnd);
  }
  flush();
  return out;
}

export function WeekGrid({
  days,
  tz,
  events,
  onSlotClick,
  onEventClick,
  onDayClick,
}: {
  days: Ymd[];
  tz: string;
  events: CalendarEvent[];
  onSlotClick: (day: Ymd, startMin: number) => void;
  onEventClick: (ev: CalendarEvent) => void;
  /** Clique no cabeçalho do dia → visão de dia (ausente quando já é 1 dia). */
  onDayClick?: (day: Ymd) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Relógio p/ a linha do "agora" — sempre no fuso do CALENDÁRIO.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const nowP = zonedParts(now, tz);
  const today = todayYmd(tz);

  // Fronteiras (instantes UTC) de cada dia-parede — base de todo recorte.
  const dayBounds = useMemo(
    () => days.map((d) => ({ day: d, start: startOfDayUtc(d, tz).getTime() })),
    [days, tz],
  );
  const rangeEnds = useMemo(() => {
    // fim do dia N = início do dia N+1 (gera o último via aritmética de calendário)
    const last = days[days.length - 1];
    const next = startOfDayUtc({ y: last.y, m: last.m, d: last.d + 1 }, tz).getTime();
    return dayBounds.map((b, i) => (i + 1 < dayBounds.length ? dayBounds[i + 1].start : next));
  }, [dayBounds, days, tz]);

  const perDay = useMemo(() => {
    return dayBounds.map((bound, i) => {
      const dayStart = bound.start;
      const dayEnd = rangeEnds[i];
      const timed: Segment[] = [];
      const allDay: CalendarEvent[] = [];
      for (const ev of events) {
        const st = new Date(ev.startsAt).getTime();
        const en = Math.max(new Date(ev.endsAt).getTime(), st);
        // intervalo [start, end) — fim exatamente à meia-noite não vaza p/ o dia seguinte
        const overlaps = st < dayEnd && (en > dayStart || (en === st && st >= dayStart));
        if (!overlaps) continue;
        if (ev.allDay) {
          allDay.push(ev);
          continue;
        }
        const startsBefore = st < dayStart;
        const endsAfter = en > dayEnd;
        const startMin = startsBefore ? 0 : minutesOfDay(new Date(st), tz);
        const endMin = endsAfter ? DAY_MIN : Math.max(minutesOfDay(new Date(en), tz), startMin);
        // recorte de evento que cruza a meia-noite: o rótulo diz só o que vale NESTE dia
        const label =
          startsBefore && endsAfter
            ? "o dia todo"
            : startsBefore
              ? `até ${fmtMinutes(endMin)}`
              : endsAfter
                ? `${fmtMinutes(startMin)} →`
                : `${fmtMinutes(startMin)} – ${fmtMinutes(endMin)}`;
        timed.push({ ev, startMin, endMin, label });
      }
      allDay.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      return { day: bound.day, positioned: layoutSegments(timed), allDay };
    });
  }, [dayBounds, rangeEnds, events, tz]);

  // Abre a grade já perto do "agora" (ou das 7h quando hoje não está visível).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hasToday = days.some((d) => sameYmd(d, today));
    const targetMin = hasToday ? nowP.hh * 60 + nowP.mm : 7 * 60;
    el.scrollTop = Math.max(0, (targetMin / 60) * HOUR_PX - 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.map(ymdKey).join(",")]);

  const gridTemplate = { gridTemplateColumns: `56px repeat(${days.length}, 1fr)` };
  const hours = Array.from({ length: 24 }, (_, h) => h);

  function handleColClick(day: Ymd, e: MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const min = ((e.clientY - rect.top) / HOUR_PX) * 60;
    const snapped = Math.max(0, Math.min(DAY_MIN - 60, Math.floor(min / 30) * 30));
    onSlotClick(day, snapped);
  }

  return (
    <div className={s.gridCard}>
      <div className={s.weekScroll} ref={scrollRef}>
        <div className={s.stickyTop}>
          <div className={s.weekHead} style={gridTemplate}>
            <div className={s.gutterHead} />
            {days.map((day) => {
              const isToday = sameYmd(day, today);
              const inner = (
                <>
                  <span className={s.dowName}>{DOW_SHORT[dayOfWeek(day)]}</span>
                  <span className={[s.dayNum, isToday ? s.dayNumToday : ""].filter(Boolean).join(" ")}>{day.d}</span>
                </>
              );
              // sem onDayClick (visão de dia) não pode virar um botão sem ação
              return onDayClick ? (
                <button key={ymdKey(day)} type="button" className={s.dayHead} onClick={() => onDayClick(day)}>
                  {inner}
                </button>
              ) : (
                <div key={ymdKey(day)} className={[s.dayHead, s.dayHeadStatic].join(" ")}>
                  {inner}
                </div>
              );
            })}
          </div>
          <div className={s.allDayRow} style={gridTemplate}>
            <div className={s.allDayGutter}>dia inteiro</div>
            {perDay.map(({ day, allDay }) => (
              <div key={ymdKey(day)} className={s.allDayCell}>
                {allDay.map((ev) => (
                  <button
                    key={ev.id}
                    type="button"
                    className={[s.allDayChip, ev.source === "sdr" ? s.evSdr : s.evManual].join(" ")}
                    onClick={() => onEventClick(ev)}
                    title={ev.title}
                  >
                    {ev.source === "sdr" && <span className={s.sdrTag}>SDR</span>}
                    {ev.title}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className={s.gridBody} style={gridTemplate}>
          <div className={s.gutterCol}>
            {hours.map((h) => (
              <div key={h} className={s.hourCell}>
                {h > 0 && <span className={s.hourLabel}>{String(h).padStart(2, "0")}:00</span>}
              </div>
            ))}
          </div>
          {perDay.map(({ day, positioned }) => {
            const isToday = sameYmd(day, today);
            return (
              <div
                key={ymdKey(day)}
                className={s.dayCol}
                role="button"
                tabIndex={0}
                aria-label={`Criar evento em ${ymdKey(day)}`}
                onClick={(e) => handleColClick(day, e)}
                onKeyDown={(e) => {
                  // só o próprio slot (keydown de filhos — eventos — borbulha até aqui);
                  // teclado não tem "posição do clique" — cria no horário padrão
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onSlotClick(day, 9 * 60);
                  }
                }}
              >
                {hours.map((h) => (
                  <div key={h} className={s.hourCell} />
                ))}
                {positioned.map((p) => {
                  const top = (p.startMin / 60) * HOUR_PX;
                  const height = (Math.max(p.endMin - p.startMin, MIN_RENDER_MIN) / 60) * HOUR_PX - 2;
                  const width = 100 / p.cols;
                  return (
                    <button
                      key={`${p.ev.id}-${p.startMin}`}
                      type="button"
                      className={[s.eventBlock, p.ev.source === "sdr" ? s.evSdr : s.evManual].join(" ")}
                      style={{ top, height, left: `${p.col * width}%`, width: `calc(${width}% - 3px)` }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEventClick(p.ev);
                      }}
                      title={p.ev.title}
                    >
                      <span className={s.eventTitle}>
                        {p.ev.source === "sdr" && <span className={s.sdrTag}>SDR</span>}
                        {p.ev.title}
                      </span>
                      {height >= 34 && <span className={s.eventTime}>{p.label}</span>}
                    </button>
                  );
                })}
                {isToday && (
                  <div className={s.nowLine} style={{ top: ((nowP.hh * 60 + nowP.mm) / 60) * HOUR_PX }}>
                    <span className={s.nowDot} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
