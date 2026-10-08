import { describe, expect, it } from "vitest";
import { syncJobId, type SyncJob } from "./crm-sync.queue";

const base: SyncJob = {
  tenantId: "T1",
  conversationId: "conv-1",
  phone: "+5511999999999",
  fields: { interesse: "implante" },
  stage: "qualified",
  status: "qualified",
  score: 80,
};

describe("syncJobId (empresa, conversa e conteúdo)", () => {
  it("payload idêntico → MESMO jobId (dedup de job em voo preservado)", () => {
    expect(syncJobId({ ...base })).toBe(syncJobId({ ...base }));
  });

  it("payload que mudou → jobId NOVO (novo sync passa mesmo com job anterior retido)", () => {
    const original = syncJobId(base);
    expect(syncJobId({ ...base, status: "handoff" })).not.toBe(original);
    expect(syncJobId({ ...base, score: 95 })).not.toBe(original);
    expect(syncJobId({ ...base, fields: { interesse: "aparelho" } })).not.toBe(
      original,
    );
    expect(syncJobId({ ...base, name: "Maria" })).not.toBe(original);
    expect(syncJobId({ ...base, phone: "+5511888888888" })).not.toBe(original);
    expect(syncJobId({ ...base, stage: "visit" })).not.toBe(original);
  });

  it("inclui tenant e conversa na identidade", () => {
    expect(syncJobId({ ...base, conversationId: "conv-2" })).not.toBe(
      syncJobId(base),
    );
    expect(syncJobId({ ...base, tenantId: "T2" })).not.toBe(syncJobId(base));
  });

  it("não usa separador reservado pelo BullMQ, mesmo com ':' nos IDs de origem", () => {
    const id = syncJobId({
      ...base,
      tenantId: "tenant:1",
      conversationId: "conv:1",
    });
    expect(id).toMatch(/^crm-sync-[a-f0-9]{64}$/);
    expect(id).not.toContain(":");
  });

  it("campos com chaves em outra ordem produzem o mesmo ID, inclusive aninhados", () => {
    expect(
      syncJobId({
        ...base,
        fields: { perfil: { renda: 8000, cidade: "SP" }, quartos: 2 },
      }),
    ).toBe(
      syncJobId({
        ...base,
        fields: { quartos: 2, perfil: { cidade: "SP", renda: 8000 } },
      }),
    );
  });

  it("mantém a ordem dos arrays e distingue ausência de nome/score de valores definidos", () => {
    expect(syncJobId({ ...base, fields: { regioes: ["A", "B"] } })).not.toBe(
      syncJobId({ ...base, fields: { regioes: ["B", "A"] } }),
    );
    expect(syncJobId({ ...base, score: undefined })).not.toBe(
      syncJobId({ ...base, score: 0 }),
    );
    expect(syncJobId({ ...base, name: undefined })).not.toBe(
      syncJobId({ ...base, name: "" }),
    );
  });
});
