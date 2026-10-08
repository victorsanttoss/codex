"use client";

import { useState, type FormEvent } from "react";
import type { CalendarEvent } from "../../lib/api";
import { Button, Field, Input, Textarea } from "../ui";
import s from "./agenda.module.css";
import {
  DOW_LONG,
  DOW_SHORT,
  MONTHS,
  MONTHS_SHORT,
  dayOfWeek,
  fmtMinutes,
  inputToYmd,
  minutesOfDay,
  sameYmd,
  timeInputToMinutes,
  ymdKey,
  zonedParts,
  type Ymd,
} from "./date-utils";

/** Valores do formulário — datas/horas são "parede" no fuso do calendário. */
export interface EventFormValues {
  title: string;
  description: string;
  startDate: Ymd;
  /** Dia inteiro: data final INCLUSIVA; com hora: dia do horário de término. */
  endDate: Ymd;
  startMin: number;
  endMin: number;
  allDay: boolean;
}
export interface EventFormInit extends EventFormValues {
  id?: string;
}

export function EventModal({
  initial,
  busy,
  error,
  onClose,
  onSave,
}: {
  initial: EventFormInit;
  busy: boolean;
  /** Erro vindo da API (o de validação local é interno ao modal). */
  error: string;
  onClose: () => void;
  onSave: (values: EventFormValues) => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [startDate, setStartDate] = useState(() => ymdKey(initial.startDate));
  const [endDate, setEndDate] = useState(() => ymdKey(initial.endDate));
  const [startTime, setStartTime] = useState(fmtMinutes(initial.startMin));
  const [endTime, setEndTime] = useState(fmtMinutes(initial.endMin));
  const [allDay, setAllDay] = useState(initial.allDay);
  const [localError, setLocalError] = useState("");

  const editing = Boolean(initial.id);

  function submit(e: FormEvent) {
    e.preventDefault();
    const sd = inputToYmd(startDate);
    const ed = inputToYmd(endDate);
    if (!title.trim()) return setLocalError("Dê um título ao evento.");
    if (!sd || !ed) return setLocalError("Escolha datas válidas.");
    const startMin = allDay ? 0 : timeInputToMinutes(startTime);
    const endMin = allDay ? 0 : timeInputToMinutes(endTime);
    // comparação em minutos "absolutos" de calendário (datas + horas de parede)
    const startAbs = Date.UTC(sd.y, sd.m - 1, sd.d) / 60000 + startMin;
    const endAbs = Date.UTC(ed.y, ed.m - 1, ed.d) / 60000 + endMin;
    if (allDay && endAbs < startAbs) return setLocalError("A data final precisa ser igual ou depois da inicial.");
    if (!allDay && endAbs <= startAbs) return setLocalError("O término precisa ser depois do início.");
    setLocalError("");
    onSave({ title: title.trim(), description: description.trim(), startDate: sd, endDate: ed, startMin, endMin, allDay });
  }

  /** Ao mudar o início, arrasta o fim junto se ele ficou para trás (UX do Google). */
  function changeStartDate(value: string) {
    setStartDate(value);
    if (endDate < value) setEndDate(value);
  }

  const err = localError || error;

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-label={editing ? "Editar evento" : "Novo evento"} onClick={onClose}>
      <form className={s.modal} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <strong className={s.modalTitle}>{editing ? "Editar evento" : "Novo evento"}</strong>
        <div className={s.formGrid}>
          <Field label="Título">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Avaliação com paciente" autoFocus />
          </Field>
          <div className={s.formRow}>
            <Field label="Data início">
              <Input type="date" value={startDate} onChange={(e) => changeStartDate(e.target.value)} required />
            </Field>
            <Field label="Data fim">
              <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} required />
            </Field>
          </div>
          <label className={s.checkRow}>
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            Dia inteiro
          </label>
          {!allDay && (
            <div className={s.formRow}>
              <Field label="Hora início">
                <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required step={300} />
              </Field>
              <Field label="Hora fim">
                <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required step={300} />
              </Field>
            </div>
          )}
          <Field label="Descrição">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Detalhes do compromisso (opcional)" rows={3} />
          </Field>
          {err && <div className={s.formError}>{err}</div>}
        </div>
        <div className={s.modalActions}>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>Cancelar</Button>
          <Button type="submit" size="sm" disabled={busy}>{busy ? "Salvando…" : "Salvar"}</Button>
        </div>
      </form>
    </div>
  );
}

/** "ter., 29 de jul · 14:00 – 15:00" / dia inteiro com datas por extenso. */
export function fmtEventWhen(ev: CalendarEvent, tz: string): string {
  const st = new Date(ev.startsAt);
  const en = new Date(Math.max(new Date(ev.endsAt).getTime(), st.getTime()));
  const a = zonedParts(st, tz);
  const dayA: Ymd = { y: a.y, m: a.m, d: a.d };
  if (ev.allDay) {
    // fim exclusivo: -1ms para não "vazar" o dia seguinte na meia-noite exata
    const b = zonedParts(en.getTime() > st.getTime() ? new Date(en.getTime() - 1) : st, tz);
    const dayB: Ymd = { y: b.y, m: b.m, d: b.d };
    const one = `${DOW_LONG[dayOfWeek(dayA)]}, ${dayA.d} de ${MONTHS[dayA.m - 1]} de ${dayA.y}`;
    if (sameYmd(dayA, dayB)) return one;
    return `${dayA.d} de ${MONTHS_SHORT[dayA.m - 1]} – ${dayB.d} de ${MONTHS_SHORT[dayB.m - 1]} de ${dayB.y}`;
  }
  const b = zonedParts(en, tz);
  const dayB: Ymd = { y: b.y, m: b.m, d: b.d };
  const time = `${fmtMinutes(minutesOfDay(st, tz))} – ${fmtMinutes(minutesOfDay(en, tz))}`;
  if (sameYmd(dayA, dayB)) return `${DOW_SHORT[dayOfWeek(dayA)]} ${dayA.d} de ${MONTHS_SHORT[dayA.m - 1]} · ${time}`;
  return `${dayA.d} ${MONTHS_SHORT[dayA.m - 1]}, ${fmtMinutes(minutesOfDay(st, tz))} – ${dayB.d} ${MONTHS_SHORT[dayB.m - 1]}, ${fmtMinutes(minutesOfDay(en, tz))}`;
}

/** Modal de detalhes ao clicar num evento: ver, editar, excluir. */
export function EventDetails({
  event,
  tz,
  busy,
  onEdit,
  onDelete,
  onClose,
}: {
  event: CalendarEvent;
  tz: string;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const sdr = event.source === "sdr";
  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-label={event.title} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()}>
        <div className={s.detHead}>
          <span className={s.detDot} style={{ background: sdr ? "var(--red-600)" : "var(--ink-800)" }} />
          <div style={{ minWidth: 0 }}>
            <h3 className={s.detTitle}>{event.title}</h3>
            <p className={s.detWhen}>{event.allDay ? "Dia inteiro · " : ""}{fmtEventWhen(event, tz)}</p>
            {sdr && (
              <span className="muted" style={{ display: "inline-block", marginTop: 6, fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", background: "rgba(229, 9, 20, 0.1)", color: "var(--red-700)", borderRadius: 999, padding: "3px 10px" }}>
                Agendado pela SDR
              </span>
            )}
          </div>
        </div>
        {event.description && <p className={s.detDesc}>{event.description}</p>}
        <div className={s.modalActions}>
          <span className={s.modalActionsLeft}>
            <Button type="button" variant="danger" size="sm" disabled={busy} onClick={onDelete}>Excluir</Button>
          </span>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>Fechar</Button>
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onEdit}>Editar</Button>
        </div>
      </div>
    </div>
  );
}
