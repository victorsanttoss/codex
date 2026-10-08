/**
 * Datas da agenda com fuso EXPLÍCITO (o do calendário do tenant, via Intl
 * nativo). O fuso do navegador nunca entra nas contas: instantes (Date/ISO)
 * viram "data-parede" {y,m,d,hh,mm} no fuso do calendário e vice-versa.
 */

/** Data-parede (dia de calendário) no fuso do calendário. m = 1–12. */
export interface Ymd {
  y: number;
  m: number;
  d: number;
}
export interface ZonedParts extends Ymd {
  hh: number;
  mm: number;
  ss: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23", // evita "24:00" à meia-noite em alguns runtimes
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Instante → data/hora-parede no fuso dado. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = dtf(tz).formatToParts(date);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour") % 24, mm: get("minute"), ss: get("second") };
}

/** Offset (ms) do fuso no instante dado — precisão de segundos basta p/ agenda. */
function tzOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Data/hora-parede no fuso → instante UTC. Duas passadas porque o offset pode
 * mudar entre o chute e o resultado (borda de DST). Hora "pulada" pelo DST
 * (nenhum instante bate) é empurrada para DEPOIS do gap, como no Google Agenda.
 */
export function zonedTimeToUtc(ymd: Ymd, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(ymd.y, ymd.m - 1, ymd.d, hh, mm);
  const o1 = tzOffsetMs(new Date(guess), tz);
  const ts1 = guess - o1;
  const o2 = tzOffsetMs(new Date(ts1), tz);
  if (o1 === o2) return new Date(ts1);
  const ts2 = guess - o2;
  const p2 = zonedParts(new Date(ts2), tz);
  const roundTrips = p2.y === ymd.y && p2.m === ymd.m && p2.d === ymd.d && p2.hh === hh && p2.mm === mm;
  return new Date(roundTrips ? ts2 : ts1);
}

/** Início do dia-parede (00:00 no fuso) como instante UTC. */
export function startOfDayUtc(ymd: Ymd, tz: string): Date {
  return zonedTimeToUtc(ymd, 0, 0, tz);
}

/** Minutos desde 00:00 do dia-parede no fuso (posição vertical na grade). */
export function minutesOfDay(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return p.hh * 60 + p.mm;
}

export function todayYmd(tz: string): Ymd {
  const p = zonedParts(new Date(), tz);
  return { y: p.y, m: p.m, d: p.d };
}

// ── Aritmética de calendário (pura, sem fuso — Ymd já é data-parede) ──
export function addDays(ymd: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** Soma meses clampando o dia (31 jan + 1 mês = 28/29 fev, como no Google Agenda). */
export function addMonths(ymd: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1 + n, 1));
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  return { y, m, d: Math.min(ymd.d, daysInMonth(y, m)) };
}
/** 0 = domingo … 6 = sábado. */
export function dayOfWeek(ymd: Ymd): number {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}
/** Domingo da semana do dia dado (semana começa no domingo, como no Google pt-BR). */
export function startOfWeek(ymd: Ymd): Ymd {
  return addDays(ymd, -dayOfWeek(ymd));
}
export function sameYmd(a: Ymd, b: Ymd): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d;
}
/** Chave estável do dia — também é o formato do <input type="date">. */
export function ymdKey(ymd: Ymd): string {
  return `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`;
}
export function inputToYmd(value: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

// ── Rótulos pt-BR (UI é só pt-BR; arrays fixos evitam variação de runtime) ──
export const MONTHS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
export const MONTHS_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
export const DOW_LONG = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
export const DOW_SHORT = ["dom.", "seg.", "ter.", "qua.", "qui.", "sex.", "sáb."];
export const DOW_MIN = ["D", "S", "T", "Q", "Q", "S", "S"];

export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
/** "HH:MM" do <input type="time"> → minutos do dia. */
export function timeInputToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
