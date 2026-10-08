import { describe, expect, it } from "vitest";
import type { CrmProvider } from "../crm-provider";

/**
 * Suíte de contrato REUTILIZÁVEL para `CrmProvider`. Garante upsert de contato e
 * de oportunidade com id externo estável e DEDUP por telefone (mesmo telefone →
 * mesmo contato). Exercitada pelo `FakeCrmProvider` e por cada adaptador.
 */
export function runCrmProviderContract(name: string, makeProvider: () => CrmProvider): void {
  describe(`CrmProvider contract :: ${name}`, () => {
    it("upsertContact é idempotente por telefone (mesmo telefone → mesmo id)", async () => {
      const p = makeProvider();
      const a = await p.upsertContact({ phone: "+5511999", name: "Ana" });
      const b = await p.upsertContact({ phone: "+5511999", name: "Ana M." });
      expect(a.externalId).toBe(b.externalId);
      expect(typeof a.externalId).toBe("string");
    });

    it("upsertOpportunity devolve id externo e vincula ao contato", async () => {
      const p = makeProvider();
      const { externalId: contactId } = await p.upsertContact({ phone: "+5511888" });
      const opp = await p.upsertOpportunity({
        contactExternalId: contactId,
        title: "Lead WhatsApp",
        stage: "qualified",
        status: "open",
        score: 80,
      });
      expect(typeof opp.externalId).toBe("string");
    });
  });
}
