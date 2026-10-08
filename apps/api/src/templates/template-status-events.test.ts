import { describe, expect, it } from "vitest";
import { parseTemplateStatusEvents } from "./template-status-events.service";

const body = (changes: unknown[]) =>
  JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA1", changes }] });

describe("parseTemplateStatusEvents (M8-ext)", () => {
  it("extrai APPROVED → approved", () => {
    const evs = parseTemplateStatusEvents(
      body([{ field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "followup_sem_resposta_1", message_template_language: "pt_BR" } }]),
    );
    expect(evs).toEqual([
      { wabaId: "WABA1", name: "followup_sem_resposta_1", languageCode: "pt_BR", status: "approved", rawEvent: "APPROVED" },
    ]);
  });

  it("REJECTED → rejected; evento desconhecido é ignorado (fail-safe)", () => {
    const evs = parseTemplateStatusEvents(
      body([
        { field: "message_template_status_update", value: { event: "REJECTED", message_template_name: "t", message_template_language: "pt_BR" } },
        { field: "message_template_status_update", value: { event: "FLAGGED_SOMETHING_NEW", message_template_name: "t2", message_template_language: "pt_BR" } },
      ]),
    );
    expect(evs.map((e) => e.status)).toEqual(["rejected"]);
  });

  it("extrai message_template_id (número ou string) para correlação", () => {
    const evs = parseTemplateStatusEvents(
      body([
        { field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "a", message_template_language: "pt_BR", message_template_id: 123456 } },
        { field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "b", message_template_language: "pt_BR", message_template_id: "789" } },
      ]),
    );
    expect(evs.map((e) => e.metaTemplateId)).toEqual(["123456", "789"]);
  });

  it("ignora outros fields (account_update/messages) e payload malformado sem lançar", () => {
    expect(parseTemplateStatusEvents(body([{ field: "account_update", value: { event: "DISABLED_UPDATE" } }]))).toEqual([]);
    expect(parseTemplateStatusEvents("not-json")).toEqual([]);
    expect(parseTemplateStatusEvents(JSON.stringify({ entry: "x" }))).toEqual([]);
    expect(
      parseTemplateStatusEvents(body([{ field: "message_template_status_update", value: { event: "APPROVED" } }])),
    ).toEqual([]); // sem nome/idioma → descarta
  });
});
