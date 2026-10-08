import { describe, expect, it } from "vitest";
import { CrmError } from "@sdr/core";
import { runCrmProviderContract } from "../../core/src/ports/testing/crm-provider.contract";
import { HttpCrmProvider, type CrmHttp } from "./index";

/** Mock de CRM HTTP que DEDUPLICA por telefone (simula o backend real). */
function crmBackend() {
  const byPhone = new Map<string, string>();
  const oppByContact = new Map<string, string>();
  let seq = 0;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const http: CrmHttp = {
    async post(url, _headers, body) {
      calls.push({ url, body });
      if (url.endsWith("/contacts")) {
        const phone = String(body.phone);
        const id = byPhone.get(phone) ?? `C${++seq}`;
        byPhone.set(phone, id);
        return { status: 200, json: { id } };
      }
      if (url.endsWith("/opportunities")) {
        const c = String(body.contact_id);
        const id = oppByContact.get(c) ?? `O${++seq}`;
        oppByContact.set(c, id);
        return { status: 200, json: { id } };
      }
      return { status: 200, json: { id: `X${++seq}` } };
    },
  };
  return { http, calls };
}

function make(http: CrmHttp) {
  return new HttpCrmProvider({ baseURL: "http://crm.local/v1", apiKey: "sk-crm", http });
}

// Contrato reutilizável (com backend que dedupa por telefone).
runCrmProviderContract("http", () => make(crmBackend().http));

describe("HttpCrmProvider", () => {
  it("envia phone/Bearer e extrai id", async () => {
    const { http, calls } = crmBackend();
    const r = await make(http).upsertContact({ phone: "+551199", name: "Ana" });
    expect(r.externalId).toBe("C1");
    expect(calls[0]!.url).toBe("http://crm.local/v1/contacts");
    expect(calls[0]!.body).toMatchObject({ phone: "+551199", name: "Ana" });
  });

  it("erro 401 vira CrmError permanente", async () => {
    const http: CrmHttp = { async post() { return { status: 401, json: { error: { message: "bad" } } }; } };
    await expect(make(http).upsertContact({ phone: "+5" })).rejects.toMatchObject({
      name: "CrmError",
      transient: false,
      status: 401,
    });
    expect(CrmError).toBeDefined();
  });

  it("erro 503 vira CrmError transiente", async () => {
    const http: CrmHttp = { async post() { return { status: 503, json: {} }; } };
    await expect(make(http).upsertContact({ phone: "+5" })).rejects.toMatchObject({ transient: true });
  });
});
