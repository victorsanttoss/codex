import type { BusinessHours } from "../cadence/cadence-config.service";

/**
 * Motor de DISPONIBILIDADE — funções puras (mesma entrada → mesma saída), sem
 * banco e sem LLM, no espírito do motor de qualificação (M6). O serviço monta a
 * lista de ocupados (eventos internos + freebusy externo) e chama estas funções.
 *
 * Toda a matemática de "que dia/hora é" acontece no FUSO DO TENANT via Intl —
 * nunca no fuso do processo. O Brasil não tem mais DST, mas o produto é
 * multi-tenant: o código não pode assumir offset fixo.
 */

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface Slot {
  start: Date;
  end: Date;
}

export type SlotPeriod = "manha" | "tarde";

export interface SlotRules {
  /** Janela de atendimento (dias/horas) no fuso do tenant. */
  hours: BusinessHours;
  timezone: string;
  durationMinutes: number;
  slotStepMinutes: number;
  /** Antecedência mínima: nada de sugerir horário daqui a 10 minutos. */
  minNoticeMinutes: number;
}

interface ZonedParts {
  y: number;
  m: number; // 1-12
  d: number;
  hour: number;
  minute: number;
  weekday: number; // 0=domingo..6=sábado
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Decompõe um instante nos componentes de calendário do fuso dado. */
export function zonedParts(date: Date, timezone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/**
 * Instante UTC correspondente a (y,m,d h:min) NO FUSO dado. Técnica padrão sem
 * lib: chuta o UTC, mede o desvio do fuso via Intl e corrige (2ª passada cobre
 * transição de DST no meio do caminho).
 */
export function makeZoned(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const adjust = (ts: number): number => {
    const p = zonedParts(new Date(ts), timezone);
    const asIf = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute);
    return ts - (asIf - guess);
  };
  const result = new Date(adjust(adjust(guess)));
  // Hora local INEXISTENTE (spring-forward em fusos com DST — achado Codex):
  // re-projeta e, se o relógio local divergiu do pedido, empurra a diferença
  // para DEPOIS do gap (comportamento Google). BR não tem DST, mas o produto
  // é multi-tenant e o fuso vem de config.
  const p = zonedParts(result, timezone);
  const desired = hour * 60 + minute;
  const got = p.hour * 60 + p.minute;
  if (got !== desired && p.d === d) {
    return new Date(result.getTime() + (desired - got) * 60_000);
  }
  return result;
}

/** Dia-parede seguinte por calendário puro (meio-dia UTC evita borda de mês). */
function nextWallDay(p: { y: number; m: number; d: number }): {
  y: number;
  m: number;
  d: number;
  weekday: number;
} {
  const u = new Date(Date.UTC(p.y, p.m - 1, p.d + 1, 12));
  return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate(), weekday: u.getUTCDay() };
}

/** [aStart,aEnd) intersecta [bStart,bEnd)? */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export function slotConflicts(slot: Slot, busy: BusyInterval[]): boolean {
  return busy.some((b) => overlaps(slot.start, slot.end, b.start, b.end));
}

/** Manhã = começa antes de 12h no fuso; tarde = 12h em diante. */
export function slotPeriod(slot: Slot, timezone: string): SlotPeriod {
  return zonedParts(slot.start, timezone).hour < 12 ? "manha" : "tarde";
}

/**
 * Núcleo da varredura de slots: percorre a grade (passo, janela de atendimento,
 * fuso do tenant) e coleta os que `accept` aprovar. `freeSlots` (uma agenda) e
 * `poolFreeSlots` (N agendas) só diferem no predicado — o resto é idêntico.
 * Limite de segurança em `maxSlots` para nunca materializar milhares de slots.
 */
function collectSlots(input: {
  from: Date;
  to: Date;
  rules: SlotRules;
  accept: (slot: Slot) => boolean;
  maxSlots?: number;
}): Slot[] {
  const { rules, accept } = input;
  const out: Slot[] = [];
  const maxSlots = input.maxSlots ?? 200;
  const stepMs = rules.slotStepMinutes * 60_000;
  const durMs = rules.durationMinutes * 60_000;
  const earliest = input.from;

  // Cursor de DIA por DATA-PAREDE no fuso do tenant (achado Codex: somar 24h
  // UTC repete o dia local quando o dia tem 25h no fall-back de DST). A data
  // avança por aritmética de calendário pura; o instante é re-projetado.
  let dayCursor: { y: number; m: number; d: number; weekday: number } = zonedParts(
    earliest,
    rules.timezone,
  );
  while (out.length < maxSlots) {
    const dayMidnight = makeZoned(dayCursor.y, dayCursor.m, dayCursor.d, 0, 0, rules.timezone);
    if (dayMidnight.getTime() >= input.to.getTime()) break;
    if (rules.hours.days.includes(dayCursor.weekday)) {
      const dayStart = makeZoned(dayCursor.y, dayCursor.m, dayCursor.d, rules.hours.startHour, 0, rules.timezone);
      const dayEnd = makeZoned(dayCursor.y, dayCursor.m, dayCursor.d, rules.hours.endHour, 0, rules.timezone);
      // primeiro slot do dia: alinhado ao passo, nunca antes de `from`
      let slotStart = dayStart.getTime();
      if (slotStart < earliest.getTime()) {
        const delta = earliest.getTime() - slotStart;
        slotStart += Math.ceil(delta / stepMs) * stepMs;
      }
      for (let s = slotStart; s + durMs <= dayEnd.getTime() && out.length < maxSlots; s += stepMs) {
        if (s + durMs > input.to.getTime()) break;
        const slot = { start: new Date(s), end: new Date(s + durMs) };
        if (accept(slot)) out.push(slot);
      }
    }
    dayCursor = nextWallDay(dayCursor);
  }
  return out;
}

/**
 * Slots LIVRES entre `from` e `to`, alinhados ao passo, dentro da janela de
 * atendimento e sem colisão com `busy` (UMA agenda).
 */
export function freeSlots(input: {
  from: Date;
  to: Date;
  rules: SlotRules;
  busy: BusyInterval[];
  maxSlots?: number;
}): Slot[] {
  return collectSlots({
    from: input.from,
    to: input.to,
    rules: input.rules,
    accept: (slot) => !slotConflicts(slot, input.busy),
    ...(input.maxSlots !== undefined ? { maxSlots: input.maxSlots } : {}),
  });
}

/**
 * Slots LIVRES no POOL: um slot é oferecido se AO MENOS UMA agenda (recurso)
 * está livre nele. `busyByResource[i]` são os ocupados da agenda i. A reserva
 * depois grava numa das agendas livres — a capacidade real (quantas estão
 * livres) é reconferida no `book`, aqui basta ≥1.
 */
export function poolFreeSlots(input: {
  from: Date;
  to: Date;
  rules: SlotRules;
  busyByResource: BusyInterval[][];
  maxSlots?: number;
}): Slot[] {
  return collectSlots({
    from: input.from,
    to: input.to,
    rules: input.rules,
    accept: (slot) => input.busyByResource.some((busy) => !slotConflicts(slot, busy)),
    ...(input.maxSlots !== undefined ? { maxSlots: input.maxSlots } : {}),
  });
}

export interface SlotSuggestions {
  /** 1º slot livre de manhã e de tarde — DENTRO da janela-alvo se possível. */
  manha: Slot | null;
  tarde: Slot | null;
  /** As sugestões vieram de além da janela-alvo (ex.: 48h sem vaga)? */
  beyondWindow: boolean;
}

/**
 * Sugestão do fluxo da SDR: um horário de MANHÃ e um de TARDE, priorizando a
 * janela-alvo (48h — velocidade fecha lead). Sem vaga na janela, estende a
 * busca dia a dia até `maxDaysAhead` e sinaliza `beyondWindow` (a SDR avisa
 * "os próximos horários são..."). Períodos sem NENHUMA vaga ficam null.
 */
function suggestWindowed(input: {
  now: Date;
  rules: SlotRules;
  windowHours: number;
  maxDaysAhead: number;
  free: (from: Date, to: Date) => Slot[];
}): SlotSuggestions {
  const from = new Date(input.now.getTime() + input.rules.minNoticeMinutes * 60_000);
  const windowEnd = new Date(input.now.getTime() + input.windowHours * 60 * 60_000);
  const horizonEnd = new Date(input.now.getTime() + input.maxDaysAhead * 24 * 60 * 60_000);

  const pick = (slots: Slot[]): { manha: Slot | null; tarde: Slot | null } => {
    let manha: Slot | null = null;
    let tarde: Slot | null = null;
    for (const s of slots) {
      const p = slotPeriod(s, input.rules.timezone);
      if (p === "manha" && !manha) manha = s;
      if (p === "tarde" && !tarde) tarde = s;
      if (manha && tarde) break;
    }
    return { manha, tarde };
  };

  const inWindow = pick(input.free(from, windowEnd));
  if (inWindow.manha || inWindow.tarde) {
    return { ...inWindow, beyondWindow: false };
  }
  const beyond = pick(input.free(windowEnd, horizonEnd));
  return { ...beyond, beyondWindow: true };
}

export function suggestSlots(input: {
  now: Date;
  rules: SlotRules;
  busy: BusyInterval[];
  windowHours: number;
  maxDaysAhead: number;
}): SlotSuggestions {
  return suggestWindowed({
    now: input.now,
    rules: input.rules,
    windowHours: input.windowHours,
    maxDaysAhead: input.maxDaysAhead,
    free: (from, to) => freeSlots({ from, to, rules: input.rules, busy: input.busy }),
  });
}

/** Como `suggestSlots`, mas sobre o POOL: livre = ao menos uma agenda livre. */
export function suggestPoolSlots(input: {
  now: Date;
  rules: SlotRules;
  busyByResource: BusyInterval[][];
  windowHours: number;
  maxDaysAhead: number;
}): SlotSuggestions {
  return suggestWindowed({
    now: input.now,
    rules: input.rules,
    windowHours: input.windowHours,
    maxDaysAhead: input.maxDaysAhead,
    free: (from, to) =>
      poolFreeSlots({ from, to, rules: input.rules, busyByResource: input.busyByResource }),
  });
}

const WEEKDAY_LABEL = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "qui, 31/07 às 09:00" no fuso do tenant — o texto que o lead vê. */
export function formatSlotLabel(slot: Slot, timezone: string): string {
  const p = zonedParts(slot.start, timezone);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${WEEKDAY_LABEL[p.weekday]}, ${pad(p.d)}/${pad(p.m)} às ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Data/hora atual legível no fuso — vai no prompt (o LLM precisa saber "hoje"). */
export function formatNowLabel(now: Date, timezone: string): string {
  const p = zonedParts(now, timezone);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${WEEKDAY_LABEL[p.weekday]}, ${pad(p.d)}/${pad(p.m)}/${p.y} ${pad(p.hour)}:${pad(p.minute)}`;
}
