import { describe, expect, it } from "vitest";
import { CrmError } from "@sdr/core";
import { KommoCrmProvider, type KommoHttp } from "./index";

/** Mock de HTTP que grava as chamadas e responde por uma fila roteável. */
function mockHttp(
  routes: (call: { method: string; url: string; body?: unknown }) => { status: number; json: unknown },
) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const http: KommoHttp = {
    async request(method, url, headers, body) {
      calls.push({ method, url, headers, body });
      return routes({ method, url, body });
    },
  };
  return { http, calls };
}

const BASE = "https://acme.kommo.com";
const TOKEN = "longlived-token-123";

describe("KommoCrmProvider — contato", () => {
  it("dedup por telefone: se a busca retorna um contato, NÃO cria outro", async () => {
    const { http, calls } = mockHttp(({ method, url }) => {
      if (method === "GET" && url.includes("/contacts?query=")) {
        return { status: 200, json: { _embedded: { contacts: [{ id: 777 }] } } };
      }
      throw new Error("não deveria chamar outra rota");
    });
    const p = new KommoCrmProvider({ baseURL: BASE, apiKey: TOKEN, http });
    const r = await p.upsertContact({ phone: "+5511999998888", name: "Ana" });
    expect(r.externalId).toBe("777");
    expect(calls).toHaveLength(1); // só a busca
    expect(calls[0]!.url).toBe("https://acme.kommo.com/api/v4/contacts?query=%2B5511999998888");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("204 na busca (sem match) → cria o contato com PHONE e adiciona nota de qualificação", async () => {
    const { http, calls } = mockHttp(({ method, url }) => {
      if (method === "GET" && url.includes("/contacts?query=")) return { status: 204, json: null };
      if (method === "POST" && url.endsWith("/contacts")) {
        return { status: 200, json: { _embedded: { contacts: [{ id: 42 }] } } };
      }
      if (method === "POST" && url.includes("/contacts/42/notes")) return { status: 200, json: {} };
      throw new Error("rota inesperada: " + method + " " + url);
    });
    const p = new KommoCrmProvider({ baseURL: BASE, apiKey: TOKEN, http });
    const r = await p.upsertContact({
      phone: "+5511999998888",
      name: "Ana",
      fields: { renda_familiar: 6500, possui_imovel: false },
    });
    expect(r.externalId).toBe("42");
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/contacts"))!;
    const body = create.body as Array<Record<string, unknown>>;
    expect(body[0]!.name).toBe("Ana");
    const cf = body[0]!.custom_fields_values as Array<Record<string, unknown>>;
    expect(cf[0]!.field_code).toBe("PHONE");
    expect((cf[0]!.values as Array<Record<string, unknown>>)[0]!.value).toBe("+5511999998888");
    // nota de qualificação no contato recém-criado
    const note = calls.find((c) => c.url.includes("/contacts/42/notes"))!;
    const noteBody = note.body as Array<Record<string, unknown>>;
    expect(noteBody[0]!.note_type).toBe("common");
    expect(String((noteBody[0]!.params as Record<string, unknown>).text)).toContain("renda_familiar: 6500");
  });

  it("nota de qualificação é best-effort: falha na nota NÃO derruba o upsert do contato", async () => {
    const { http } = mockHttp(({ method, url }) => {
      if (method === "GET") return { status: 204, json: null };
      if (method === "POST" && url.endsWith("/contacts")) {
        return { status: 200, json: { _embedded: { contacts: [{ id: 9 }] } } };
      }
      if (url.includes("/notes")) return { status: 500, json: { detail: "boom" } };
      throw new Error("rota inesperada");
    });
    const p = new KommoCrmProvider({ baseURL: BASE, apiKey: TOKEN, http });
    const r = await p.upsertContact({ phone: "+551190000", fields: { x: 1 } });
    expect(r.externalId).toBe("9");
  });
});

describe("KommoCrmProvider — oportunidade (lead)", () => {
  it("re-sync usa o knownExternalId DIRETO (PATCH no nosso lead, SEM adivinhar leads[0])", async () => {
    const { http, calls } = mockHttp(({ method, url }) => {
      if (method === "PATCH" && url.includes("/leads/555")) return { status: 200, json: { id: 555 } };
      throw new Error("rota inesperada: " + method + " " + url);
    });
    const p = new KommoCrmProvider({ baseURL: BASE, apiKey: TOKEN, http, pipelineId: 10, statusId: 20 });
    const r = await p.upsertOpportunity({
      contactExternalId: "42",
      knownExternalId: "555",
      title: "Lead WhatsApp",
      stage: "scheduled",
      status: "open",
    });
    expect(r.externalId).toBe("555");
    // NÃO buscou leads do contato (não adivinha) — foi direto no nosso lead.
    expect(calls.every((c) => c.method !== "GET")).toBe(true);
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ pipeline_id: 10, status_id: 20 });
  });

  it("1ª sync sem knownExternalId: se o contato já tem lead ligado, atualiza em vez de criar outro", async () => {
    const { http, calls } = mockHttp(({ method, url }) => {
      if (method === "GET" && url.includes("/contacts/42?with=leads")) {
        return { status: 200, json: { id: 42, _embedded: { leads: [{ id: 555 }] } } };
      }
      if (method === "PATCH" && url.includes("/leads/555")) return { status: 200, json: { id: 555 } };
      throw new Error("rota inesperada: " + method + " " + url);
    });
    const p = new KommoCrmProvider({ baseURL: BASE, apiKey: TOKEN, http, pipelineId: 10, statusId: 20 });
    const r = await p.upsertOpportunity({
      contactExternalId: "42",
      title: "Lead WhatsApp",
      stage: "qualified",
      status: "open",
    });
    expect(r.externalId).toBe("555");
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ pipeline_id: 10, status_id: 20 });
  });

  it("sem lead ligado → cria o lead vinculado ao contato, no funil/etapa configurados", async () => {
    const { http, calls } = mockHttp(({ method, url }) => {
      if (method === "GET" && url.includes("?with=leads")) return { status: 204, json: null };
      if (method === "POST" && url.endsWith("/leads")) {
        return { status: 200, json: { _embedded: { leads: [{ id: 888 }] } } };
      }
      throw new Error("rota inesperada: " + method + " " + url);
    });
    const p = new KommoCrmProvider({ baseURL: BASE, apiKey: TOKEN, http, pipelineId: 10, statusId: 20 });
    const r = await p.upsertOpportunity({
      contactExternalId: "42",
      title: "Lead WhatsApp",
      stage: "qualified",
      status: "open",
      value: 249900.6,
    });
    expect(r.externalId).toBe("888");
    const create = calls.find((c) => c.method === "POST")!;
    const body = (create.body as Array<Record<string, unknown>>)[0]!;
    expect(body.name).toBe("Lead WhatsApp");
    expect(body.pipeline_id).toBe(10);
    expect(body.status_id).toBe(20);
    expect(body.price).toBe(249901); // arredondado
    expect((body._embedded as { contacts: Array<{ id: number }> }).contacts[0]!.id).toBe(42); // NUMÉRICO
  });
});

describe("KommoCrmProvider — erros", () => {
  it("401 → CrmError PERMANENTE (não re-tenta)", async () => {
    const { http } = mockHttp(() => ({ status: 401, json: { title: "Unauthorized" } }));
    const p = new KommoCrmProvider({ baseURL: BASE, apiKey: TOKEN, http });
    await expect(p.upsertContact({ phone: "+55119" })).rejects.toMatchObject({
      name: "CrmError",
      transient: false,
      status: 401,
    });
  });

  it("429 e 5xx → CrmError TRANSIENTE (re-tenta)", async () => {
    for (const status of [429, 503]) {
      const { http } = mockHttp(() => ({ status, json: {} }));
      const p = new KommoCrmProvider({ baseURL: BASE, apiKey: TOKEN, http });
      await expect(p.upsertContact({ phone: "+55119" })).rejects.toMatchObject({
        transient: true,
        status,
      });
    }
  });

  it("erro de rede (throw do http) → CrmError TRANSIENTE", async () => {
    const http: KommoHttp = {
      async request() {
        throw new Error("ECONNRESET");
      },
    };
    const p = new KommoCrmProvider({ baseURL: BASE, apiKey: TOKEN, http });
    await expect(p.upsertContact({ phone: "+55119" })).rejects.toBeInstanceOf(CrmError);
  });

  it("construtor exige baseURL e token", () => {
    expect(() => new KommoCrmProvider({ baseURL: "", apiKey: TOKEN })).toThrow();
    expect(() => new KommoCrmProvider({ baseURL: BASE, apiKey: "" })).toThrow();
  });
});
