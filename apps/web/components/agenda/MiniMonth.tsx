"use client";

import { useEffect, useState } from "react";
import s from "./agenda.module.css";
import { addDays, addMonths, DOW_MIN, MONTHS, sameYmd, startOfWeek, ymdKey, type Ymd } from "./date-utils";

/**
 * Mini-calendário lateral (estilo Google Agenda): navega meses com ‹ › e
 * seleciona um dia — a seleção move o período da visão principal.
 */
export function MiniMonth({ selected, today, onSelect }: { selected: Ymd; today: Ymd; onSelect: (d: Ymd) => void }) {
  const [view, setView] = useState<Ymd>({ y: selected.y, m: selected.m, d: 1 });
  // Segue a navegação feita fora daqui (setas do toolbar, botão "Hoje").
  useEffect(() => {
    setView({ y: selected.y, m: selected.m, d: 1 });
  }, [selected.y, selected.m]);

  const gridStart = startOfWeek(view);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  return (
    <div className={s.mini}>
      <div className={s.miniHead}>
        <span className={s.miniTitle}>{MONTHS[view.m - 1]} de {view.y}</span>
        <span>
          <button type="button" className={s.miniNavBtn} aria-label="Mês anterior" onClick={() => setView(addMonths(view, -1))}>‹</button>
          <button type="button" className={s.miniNavBtn} aria-label="Próximo mês" onClick={() => setView(addMonths(view, 1))}>›</button>
        </span>
      </div>
      <div className={s.miniGrid}>
        {DOW_MIN.map((d, i) => (
          <span key={i} className={s.miniDow} aria-hidden>{d}</span>
        ))}
        {cells.map((cell) => {
          const isToday = sameYmd(cell, today);
          const isSel = !isToday && sameYmd(cell, selected);
          const out = cell.m !== view.m;
          return (
            <button
              key={ymdKey(cell)}
              type="button"
              className={[s.miniDay, out ? s.miniDayOut : "", isSel ? s.miniDaySel : "", isToday ? s.miniDayToday : ""].filter(Boolean).join(" ")}
              onClick={() => onSelect(cell)}
              aria-label={`Dia ${cell.d}/${cell.m}/${cell.y}`}
            >
              {cell.d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
