import { describe, expect, it } from "vitest";
import { isOptOutText } from "./optout";
import {
  DEFAULT_CADENCE_SETTINGS,
  mergeCadenceSettings,
  withinBusinessHours,
} from "./cadence-config.service";

describe("isOptOutText (LGPD)", () => {
  it("detecta frases de saída", () => {
    for (const t of ["pare", "PARE", "pode parar de me mandar mensagem", "não quero receber mensagens", "me descadastra", "stop"]) {
      expect(isOptOutText(t), t).toBe(true);
    }
  });
  it("não dispara em conversa normal", () => {
    for (const t of ["quero saber o preço", "qual o horário?", "obrigado!", "vou parar no mercado e já te respondo sobre o orçamento que pedi"]) {
      expect(isOptOutText(t), t).toBe(false);
    }
  });
});

describe("mergeCadenceSettings (config não-confiável)", () => {
  it("default é desabilitado (opt-in)", () => {
    expect(mergeCadenceSettings(DEFAULT_CADENCE_SETTINGS, {}).enabled).toBe(false);
  });
  it("clampa passos absurdos e limita o número de passos", () => {
    const many = Array.from({ length: 50 }, () => ({ delayMinutes: 0, templateName: "t", languageCode: "pt_BR" }));
    const s = mergeCadenceSettings(DEFAULT_CADENCE_SETTINGS, { enabled: true, steps: many });
    expect(s.steps.length).toBeLessThanOrEqual(10);
    expect(s.steps[0]!.delayMinutes).toBeGreaterThanOrEqual(5); // piso
  });
  it("habilita só com passos válidos", () => {
    expect(mergeCadenceSettings(DEFAULT_CADENCE_SETTINGS, { enabled: true, steps: [] }).enabled).toBe(false);
    expect(
      mergeCadenceSettings(DEFAULT_CADENCE_SETTINGS, {
        enabled: true,
        steps: [{ delayMinutes: 60, templateName: "x", languageCode: "pt_BR" }],
      }).enabled,
    ).toBe(true);
  });
});

describe("withinBusinessHours (fuso America/Sao_Paulo)", () => {
  const s = { ...DEFAULT_CADENCE_SETTINGS, businessHours: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] } };
  it("dentro: quarta 14h BRT (17:00 UTC)", () => {
    expect(withinBusinessHours(s, new Date("2026-06-17T17:00:00Z"))).toBe(true);
  });
  it("fora: madrugada (06:00 UTC = 03:00 BRT)", () => {
    expect(withinBusinessHours(s, new Date("2026-06-17T06:00:00Z"))).toBe(false);
  });
  it("fora: domingo", () => {
    expect(withinBusinessHours(s, new Date("2026-06-14T17:00:00Z"))).toBe(false);
  });
});
