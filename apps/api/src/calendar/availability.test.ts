import { describe, expect, it } from "vitest";
import {
  formatSlotLabel,
  freeSlots,
  makeZoned,
  poolFreeSlots,
  slotPeriod,
  suggestPoolSlots,
  suggestSlots,
  zonedParts,
  type BusyInterval,
  type SlotRules,
} from "./availability";
import {
  DEFAULT_SCHEDULING_SETTINGS,
  mergeSchedulingSettings,
} from "./scheduling-config.service";

const TZ = "America/Sao_Paulo"; // UTC-3 fixo (BR sem DST desde 2019)

const RULES: SlotRules = {
  hours: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
  timezone: TZ,
  durationMinutes: 60,
  slotStepMinutes: 30,
  minNoticeMinutes: 120,
};

// quarta-feira, 29/07/2026 15:00 no fuso BR
const NOW = new Date("2026-07-29T15:00:00-03:00");

describe("makeZoned / zonedParts", () => {
  it("converte hora local BR para o instante UTC certo", () => {
    const d = makeZoned(2026, 7, 31, 9, 0, TZ);
    expect(d.toISOString()).toBe("2026-07-31T12:00:00.000Z");
  });

  it("decompõe instante no fuso (dia da semana incluso)", () => {
    const p = zonedParts(new Date("2026-07-31T12:00:00Z"), TZ);
    expect(p).toMatchObject({ y: 2026, m: 7, d: 31, hour: 9, minute: 0, weekday: 5 });
  });
});

describe("freeSlots", () => {
  it("gera slots dentro da janela de atendimento, alinhados ao passo", () => {
    const from = makeZoned(2026, 7, 30, 0, 0, TZ); // quinta 00:00
    const to = makeZoned(2026, 7, 31, 0, 0, TZ);
    const slots = freeSlots({ from, to, rules: RULES, busy: [] });
    // 9h..17h de início (fim 18h) a cada 30min → 17 slots
    expect(slots).toHaveLength(17);
    expect(zonedParts(slots[0]!.start, TZ).hour).toBe(9);
    const last = slots[slots.length - 1]!;
    expect(zonedParts(last.start, TZ).hour).toBe(17);
    expect(zonedParts(last.end, TZ).hour).toBe(18);
  });

  it("pula fim de semana e horários ocupados", () => {
    const from = makeZoned(2026, 8, 1, 0, 0, TZ); // sábado
    const to = makeZoned(2026, 8, 4, 0, 0, TZ); // até terça 00:00 → só segunda gera
    const busyStart = makeZoned(2026, 8, 3, 9, 0, TZ); // segunda 9h-12h ocupado
    const busy = [{ start: busyStart, end: makeZoned(2026, 8, 3, 12, 0, TZ) }];
    const slots = freeSlots({ from, to, rules: RULES, busy });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const p = zonedParts(s.start, TZ);
      expect(p.weekday).toBe(1); // tudo na segunda
      expect(p.hour).toBeGreaterThanOrEqual(12); // manhã ocupada inteira
    }
  });

  it("colisão parcial derruba o slot (interseção, não containment)", () => {
    const from = makeZoned(2026, 7, 30, 0, 0, TZ);
    const to = makeZoned(2026, 7, 31, 0, 0, TZ);
    // ocupado 09:30-10:00 → derruba 09:00 (60min) e 09:30, mas não 10:00
    const busy = [
      { start: makeZoned(2026, 7, 30, 9, 30, TZ), end: makeZoned(2026, 7, 30, 10, 0, TZ) },
    ];
    const slots = freeSlots({ from, to, rules: RULES, busy });
    const hours = slots.map((s) => {
      const p = zonedParts(s.start, TZ);
      return `${p.hour}:${String(p.minute).padStart(2, "0")}`;
    });
    expect(hours).not.toContain("9:00");
    expect(hours).not.toContain("9:30");
    expect(hours).toContain("10:00");
  });
});

describe("suggestSlots", () => {
  it("sugere 1 manhã + 1 tarde dentro da janela de 48h", () => {
    const s = suggestSlots({ now: NOW, rules: RULES, busy: [], windowHours: 48, maxDaysAhead: 14 });
    expect(s.beyondWindow).toBe(false);
    expect(s.manha).not.toBeNull();
    expect(s.tarde).not.toBeNull();
    // agora = qua 15h, notice 2h → tarde ainda hoje (17:00), manhã só quinta
    expect(zonedParts(s.tarde!.start, TZ)).toMatchObject({ d: 29, hour: 17 });
    expect(zonedParts(s.manha!.start, TZ)).toMatchObject({ d: 30, hour: 9 });
    expect(slotPeriod(s.manha!, TZ)).toBe("manha");
    expect(slotPeriod(s.tarde!, TZ)).toBe("tarde");
  });

  it("respeita a antecedência mínima", () => {
    const s = suggestSlots({
      now: NOW,
      rules: { ...RULES, minNoticeMinutes: 240 }, // 4h → hoje só teria depois das 19h (fora)
      busy: [],
      windowHours: 48,
      maxDaysAhead: 14,
    });
    expect(zonedParts(s.manha!.start, TZ).d).toBe(30);
    expect(zonedParts(s.tarde!.start, TZ).d).toBe(30);
  });

  it("48h lotadas → estende a busca e marca beyondWindow", () => {
    // ocupa qua..sex inteiro (a janela de 48h a partir de qua 15h)
    const busy = [
      { start: makeZoned(2026, 7, 29, 0, 0, TZ), end: makeZoned(2026, 8, 1, 0, 0, TZ) },
    ];
    const s = suggestSlots({ now: NOW, rules: RULES, busy, windowHours: 48, maxDaysAhead: 14 });
    expect(s.beyondWindow).toBe(true);
    // próximo dia útil livre: segunda 03/08
    expect(zonedParts(s.manha!.start, TZ)).toMatchObject({ m: 8, d: 3, hour: 9 });
  });

  it("nenhuma vaga no horizonte → tudo null", () => {
    const busy = [
      { start: makeZoned(2026, 7, 1, 0, 0, TZ), end: makeZoned(2026, 12, 1, 0, 0, TZ) },
    ];
    const s = suggestSlots({ now: NOW, rules: RULES, busy, windowHours: 48, maxDaysAhead: 14 });
    expect(s.manha).toBeNull();
    expect(s.tarde).toBeNull();
  });
});

describe("formatSlotLabel", () => {
  it("formata em pt-BR curto", () => {
    const slot = {
      start: makeZoned(2026, 7, 30, 9, 0, TZ),
      end: makeZoned(2026, 7, 30, 10, 0, TZ),
    };
    expect(formatSlotLabel(slot, TZ)).toBe("qui, 30/07 às 09:00");
  });
});

describe("mergeSchedulingSettings", () => {
  it("clampa números e preserva enabled quando omitido", () => {
    const merged = mergeSchedulingSettings(
      { ...DEFAULT_SCHEDULING_SETTINGS, enabled: true },
      { durationMinutes: 10_000, windowHours: 1, hours: { startHour: 22, endHour: 5, days: [9] } },
    );
    expect(merged.enabled).toBe(true);
    expect(merged.durationMinutes).toBe(240);
    expect(merged.windowHours).toBe(12);
    // endHour nunca <= startHour (janela impossível não trava o motor)
    expect(merged.hours.endHour).toBeGreaterThan(merged.hours.startHour);
    // dias inválidos caem no default
    expect(merged.hours.days).toEqual(DEFAULT_SCHEDULING_SETTINGS.hours.days);
  });

  it("config vazia = defaults (agendamento desligado)", () => {
    const merged = mergeSchedulingSettings(DEFAULT_SCHEDULING_SETTINGS, {});
    expect(merged).toEqual(DEFAULT_SCHEDULING_SETTINGS);
  });
});

// ── Pool (0036): disponibilidade = UNIÃO (livre se ≥1 recurso livre) ─────────
describe("poolFreeSlots — união entre recursos", () => {
  // quinta 30/07/2026, 09:00→18:00 BR
  const FROM = new Date("2026-07-30T12:00:00Z"); // 09:00 BR
  const TO = new Date("2026-07-30T21:00:00Z"); // 18:00 BR
  const at = (iso: string): BusyInterval => ({
    start: new Date(iso),
    end: new Date(new Date(iso).getTime() + 60 * 60_000),
  });
  const hasStart = (slots: { start: Date }[], iso: string): boolean =>
    slots.some((s) => s.start.toISOString() === iso);

  it("um recurso ocupado, outro livre → o slot continua oferecido", () => {
    const slots = poolFreeSlots({
      from: FROM,
      to: TO,
      rules: RULES,
      busyByResource: [[at("2026-07-30T12:00:00Z")], []], // A ocupado 09-10; B livre
    });
    expect(hasStart(slots, "2026-07-30T12:00:00.000Z")).toBe(true); // 09:00 vem de B
  });

  it("TODOS os recursos ocupados no horário → slot some", () => {
    const slots = poolFreeSlots({
      from: FROM,
      to: TO,
      rules: RULES,
      busyByResource: [[at("2026-07-30T12:00:00Z")], [at("2026-07-30T12:00:00Z")]],
    });
    expect(hasStart(slots, "2026-07-30T12:00:00.000Z")).toBe(false); // 09:00 e 09:30 ocupados
    expect(hasStart(slots, "2026-07-30T13:00:00.000Z")).toBe(true); // 10:00 livre nos dois
  });

  it("pool de 1 recurso = mesmo resultado de freeSlots (compat)", () => {
    const busy = [at("2026-07-30T13:00:00Z")]; // ocupado 10-11
    const pool = poolFreeSlots({ from: FROM, to: TO, rules: RULES, busyByResource: [busy] });
    const single = freeSlots({ from: FROM, to: TO, rules: RULES, busy });
    expect(pool.map((s) => s.start.toISOString())).toEqual(
      single.map((s) => s.start.toISOString()),
    );
  });
});

describe("suggestPoolSlots — sugere de qualquer recurso livre", () => {
  it("manhã lotada no recurso A mas livre no B → ainda sugere manhã", () => {
    // A ocupado a manhã inteira (09-12) na janela-alvo; B totalmente livre
    const morningBusy: BusyInterval[] = [
      { start: new Date("2026-07-30T12:00:00Z"), end: new Date("2026-07-30T15:00:00Z") },
    ];
    const s = suggestPoolSlots({
      now: NOW,
      rules: RULES,
      busyByResource: [morningBusy, []],
      windowHours: 48,
      maxDaysAhead: 14,
    });
    expect(s.manha).not.toBeNull();
    expect(slotPeriod(s.manha!, TZ)).toBe("manha");
  });
});
