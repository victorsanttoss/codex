import { describe, expect, it } from "vitest";
import type { ImobBrokerCandidate } from "@sdr/db";
import { rankBrokers } from "./imob-distribution.service";

const pickBroker = (
  candidates: ImobBrokerCandidate[],
  opts: { region: string | null; exclude: Set<string> },
): ImobBrokerCandidate | null => rankBrokers(candidates, opts)[0] ?? null;
import {
  buildAcceptedConfirmation,
  buildAcceptedConfirmationWorkspace,
  buildOfferMessage,
  buildStatusMenuMessage,
  IMOB_STAGE_MENU,
  leadDisplayName,
  parseNumericReply,
} from "./imob-messages";

describe("parseNumericReply", () => {
  it("aceita número puro, com espaços e com sufixo", () => {
    expect(parseNumericReply("1")).toBe(1);
    expect(parseNumericReply("  2 ")).toBe(2);
    expect(parseNumericReply("1 - aceito")).toBe(1);
    expect(parseNumericReply("3, vou tentar de novo")).toBe(3);
  });
  it("rejeita texto, vazio e número no meio", () => {
    expect(parseNumericReply("aceito")).toBeNull();
    expect(parseNumericReply("")).toBeNull();
    expect(parseNumericReply(undefined)).toBeNull();
    expect(parseNumericReply("ligo em 10 min")).toBeNull();
  });
});

describe("buildOfferMessage", () => {
  const base = {
    brokerName: "João",
    projectName: "Parque das Flores",
    leadName: "Carlos",
    leadPhone: "5544999112233",
    fields: {
      comprar_ou_alugar: "comprar",
      tipo_imovel: "apartamento",
      regiao: "Sarandi",
      faixa_preco: 250000,
      prazo: "3 meses",
      eh_decisor: true,
    },
    score: 6,
    attempt: 1,
    slaMinutes: 30,
  };

  it("monta a ficha com os campos qualificados e o CTA numérico", () => {
    const msg = buildOfferMessage(base);
    expect(msg).toContain("Parque das Flores");
    expect(msg).toContain("Carlos");
    expect(msg).toContain("R$ 250.000");
    expect(msg).toContain("Sarandi");
    expect(msg).toContain("1 — Aceitar");
    expect(msg).toContain("30 min");
    expect(msg).not.toContain("Reoferta");
  });

  it("omite campos ausentes e sinaliza reoferta", () => {
    const msg = buildOfferMessage({ ...base, fields: {}, leadPhone: null, score: null, attempt: 2 });
    expect(msg).not.toContain("Faixa de preço");
    expect(msg).not.toContain("Telefone");
    expect(msg).toContain("Reoferta");
  });
});

describe("confirmação de aceite por modo", () => {
  it("ficha: inclui o telefone do lead", () => {
    const msg = buildAcceptedConfirmation("Carlos", "5544999112233");
    expect(msg).toContain("5544999112233");
  });
  it("workspace: inclui o link pessoal e NUNCA o telefone", () => {
    const msg = buildAcceptedConfirmationWorkspace("Carlos", "https://imob.exemplo/corretor?t=abc");
    expect(msg).toContain("https://imob.exemplo/corretor?t=abc");
    expect(msg).toContain("PESSOAL");
    expect(msg).not.toContain("Telefone");
  });
});

describe("menu de status", () => {
  it("tem 6 opções numeradas e estágios únicos", () => {
    expect(IMOB_STAGE_MENU).toHaveLength(6);
    expect(new Set(IMOB_STAGE_MENU.map((o) => o.n)).size).toBe(6);
    expect(new Set(IMOB_STAGE_MENU.map((o) => o.stage)).size).toBe(6);
    const msg = buildStatusMenuMessage("João", "Carlos", "Parque das Flores");
    for (const o of IMOB_STAGE_MENU) expect(msg).toContain(`${o.n} — ${o.label}`);
  });
});

describe("leadDisplayName", () => {
  it("prefere campo qualificado, cai no nome do contato, depois no genérico", () => {
    expect(leadDisplayName({ nome: "Ana" }, "Perfil")).toBe("Ana");
    expect(leadDisplayName({}, "Perfil")).toBe("Perfil");
    expect(leadDisplayName(null, null)).toBe("Lead sem nome");
  });
});

describe("pickBroker (round-robin + região + capacidade)", () => {
  const mk = (over: Partial<ImobBrokerCandidate>): ImobBrokerCandidate => ({
    id: "b1",
    agencyId: null,
    agencyName: null,
    name: "B",
    whatsapp: "55440001",
    waId: null,
    regions: [],
    dailyCapacity: 10,
    active: true,
    archivedAt: null,
    offeredToday: 0,
    lastOfferedAt: null,
    pendingAccept: 0,
    ...over,
  });

  it("nunca ofertado vence; depois o há mais tempo sem receber", () => {
    const a = mk({ id: "a", lastOfferedAt: new Date("2026-08-12T10:00:00Z") });
    const b = mk({ id: "b", lastOfferedAt: null });
    const c = mk({ id: "c", lastOfferedAt: new Date("2026-08-12T09:00:00Z") });
    expect(pickBroker([a, b, c], { region: null, exclude: new Set() })?.id).toBe("b");
    expect(pickBroker([a, c], { region: null, exclude: new Set() })?.id).toBe("c");
  });

  it("capacidade cheia sai do pool; exclusão (redistribuição) idem", () => {
    const cheio = mk({ id: "cheio", offeredToday: 10, dailyCapacity: 10 });
    const livre = mk({ id: "livre" });
    expect(pickBroker([cheio, livre], { region: null, exclude: new Set() })?.id).toBe("livre");
    expect(pickBroker([cheio, livre], { region: null, exclude: new Set(["livre"]) })).toBeNull();
  });

  it("corretor com oferta pendente vai pro fim da fila (0038: 1 pendente por corretor)", () => {
    const pendente = mk({ id: "pendente", pendingAccept: 1, lastOfferedAt: null });
    const livre = mk({ id: "livre", lastOfferedAt: new Date("2026-08-12T10:00:00Z") });
    const fila = rankBrokers([pendente, livre], { region: null, exclude: new Set() });
    expect(fila.map((b) => b.id)).toEqual(["livre", "pendente"]);
  });

  it("região casa nos dois sentidos (contains) e cai no pool geral se ninguém casar", () => {
    const sarandi = mk({ id: "sarandi", regions: ["Sarandi"] });
    const maringa = mk({ id: "maringa", regions: ["Maringá"] });
    const geral = mk({ id: "geral", regions: [] });
    // lead "Sarandi - PR" casa com corretor "Sarandi"
    expect(
      pickBroker([maringa, sarandi], { region: "Sarandi - PR", exclude: new Set() })?.id,
    ).toBe("sarandi");
    // corretor sem região atende qualquer lead
    expect(pickBroker([geral], { region: "Cuiabá", exclude: new Set() })?.id).toBe("geral");
    // ninguém da região → fallback: distribui mesmo assim (atender > especializar)
    expect(pickBroker([maringa], { region: "Cuiabá", exclude: new Set() })?.id).toBe("maringa");
  });
});
