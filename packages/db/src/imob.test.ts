import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient } from "./client";
import {
  acceptImobAssignment,
  brPhoneVariants,
  claimImobDueStatusFollowups,
  createImobAgency,
  createImobAssignment,
  createImobBroker,
  declineImobAssignment,
  expireImobAssignment,
  findImobAssignmentAwaitingReply,
  findImobBrokerByWa,
  getActiveImobAssignment,
  getImobOverview,
  isUniqueViolation,
  listImobAssignments,
  listImobBrokerCandidates,
  listImobDueAcceptExpiries,
  listImobDueStatusFollowups,
  listImobPriorBrokerIds,
  listTenantsWithImobDue,
  markImobStatusPrompt,
  recordImobEvent,
  revertImobStatusPrompt,
  setImobAssignmentStage,
  updateImobBroker,
} from "./imob";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("Imobiliário: corretores + distribuição + SLA (RLS)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA = "";
  let tenantB = "";

  async function seedConversation(tenantId: string): Promise<string> {
    return mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO contacts (tenant_id, wa_id) VALUES (${tenantId}, ${"wa-" + randomUUID()}) RETURNING id`;
      const [conv] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, contact_id, conversation_key)
        VALUES (${tenantId}, ${c!.id}, ${"ck-" + randomUUID()}) RETURNING id`;
      return conv!.id;
    }) as Promise<string>;
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('IMOB-A', ${"imoba-" + randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('IMOB-B', ${"imobb-" + randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id in (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  it("variantes BR do nono dígito cobrem os dois formatos", () => {
    expect(brPhoneVariants("5544999001234").sort()).toEqual(["554499001234", "5544999001234"].sort());
    expect(brPhoneVariants("554499001234").sort()).toEqual(["554499001234", "5544999001234"].sort());
    // não-BR fica intacto
    expect(brPhoneVariants("14155550123")).toEqual(["14155550123"]);
  });

  it("corretor é encontrado por qualquer variante e some quando arquivado", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const { agencyId } = await createImobAgency("Imobiliária Alfa");
      const { brokerId } = await createImobBroker({
        name: "João",
        whatsapp: "5544999001234",
        agencyId,
        regions: ["Sarandi"],
      });

      const semNove = await findImobBrokerByWa("554499001234");
      expect(semNove?.id).toBe(brokerId);
      const comNove = await findImobBrokerByWa("5544999001234");
      expect(comNove?.id).toBe(brokerId);
      expect(comNove?.agencyName).toBe("Imobiliária Alfa");

      await updateImobBroker(brokerId, { archived: true });
      expect(await findImobBrokerByWa("5544999001234")).toBeNull();
      await updateImobBroker(brokerId, { archived: false });
    });
  });

  it("ciclo da atribuição: oferta → aceite (guard) → estágio → terminal fecha", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const conv = await seedConversation(tenantA);
      const brokers = await listImobBrokerCandidates();
      const broker = brokers[0]!;

      const a = await createImobAssignment({
        conversationId: conv,
        brokerId: broker.id,
        attempt: 1,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
      expect(a.status).toBe("offered");
      expect(a.awaitingReply).toBe("accept");

      // awaiting: aceite tem prioridade
      const waiting = await findImobAssignmentAwaitingReply(broker.id);
      expect(waiting?.id).toBe(a.id);

      const accepted = await acceptImobAssignment(a.id);
      expect(accepted?.status).toBe("accepted");
      expect(accepted?.stage).toBe("em_atendimento");
      // aceitar duas vezes não re-transiciona (guard por status)
      expect(await acceptImobAssignment(a.id)).toBeNull();
      expect(await declineImobAssignment(a.id)).toBeNull();

      // uma ativa por conversa: nova oferta p/ mesma conversa viola o índice parcial
      await expect(
        createImobAssignment({
          conversationId: conv,
          brokerId: broker.id,
          attempt: 2,
          expiresAt: new Date(Date.now() + 30 * 60_000),
        }),
      ).rejects.toThrow();

      // follow-up: cobra status → corretor responde estágio → ciclo zera
      await markImobStatusPrompt(a.id);
      const waiting2 = await findImobAssignmentAwaitingReply(broker.id);
      expect(waiting2?.awaitingReply).toBe("status");
      const staged = await setImobAssignmentStage(a.id, "visita_agendada");
      expect(staged?.stage).toBe("visita_agendada");
      expect(staged?.followupCount).toBe(0);

      // estágio terminal fecha a atribuição (libera o lead p/ nova rodada)
      const closed = await setImobAssignmentStage(a.id, "contrato");
      expect(closed?.status).toBe("closed");
      expect(await getActiveImobAssignment(conv)).toBeNull();

      await recordImobEvent({ conversationId: conv, assignmentId: a.id, brokerId: broker.id, type: "accepted" });
      expect(await listImobPriorBrokerIds(conv)).toContain(broker.id);
    });
  });

  it("expiração: oferta vencida entra na varredura e expira só de offered", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const conv = await seedConversation(tenantA);
      const { brokerId } = await createImobBroker({ name: "Maria", whatsapp: "5544999005678" });
      const a = await createImobAssignment({
        conversationId: conv,
        brokerId,
        attempt: 1,
        expiresAt: new Date(Date.now() - 60_000), // já vencida
      });
      const due = await listImobDueAcceptExpiries();
      expect(due.map((d) => d.id)).toContain(a.id);
      // guard temporal: oferta VENCIDA não pode mais ser aceita (janela de até
      // 60s antes do sweep do worker — importa com SLA de 5min)
      expect(await acceptImobAssignment(a.id)).toBeNull();
      const expired = await expireImobAssignment(a.id);
      expect(expired?.status).toBe("expired");
      expect(await expireImobAssignment(a.id)).toBeNull();
    });
  });

  it("follow-up devido: aceito parado além do prazo aparece; recém-atualizado não", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const conv = await seedConversation(tenantA);
      const { brokerId } = await createImobBroker({ name: "Pedro", whatsapp: "5544999009999" });
      const a = await createImobAssignment({
        conversationId: conv,
        brokerId,
        attempt: 1,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
      await acceptImobAssignment(a.id);

      // recém-aceito: NÃO deve aparecer com inatividade de 1h
      const dueRecent = await listImobDueStatusFollowups({ inactivityMs: 3_600_000, maxFollowups: 3 });
      expect(dueRecent.map((d) => d.id)).not.toContain(a.id);

      // com inatividade zero, aparece
      const dueNow = await listImobDueStatusFollowups({ inactivityMs: 0, maxFollowups: 3 });
      expect(dueNow.map((d) => d.id)).toContain(a.id);
    });
  });

  it("0038: um corretor não recebe DUAS ofertas pendentes; claim de follow-up é atômico e reversível", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const { brokerId } = await createImobBroker({ name: "Rita", whatsapp: "5544999112200" });
      const conv1 = await seedConversation(tenantA);
      const conv2 = await seedConversation(tenantA);
      await createImobAssignment({
        conversationId: conv1,
        brokerId,
        attempt: 1,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
      // segunda oferta pendente pro MESMO corretor → violação do índice 0038
      try {
        await createImobAssignment({
          conversationId: conv2,
          brokerId,
          attempt: 1,
          expiresAt: new Date(Date.now() + 30 * 60_000),
        });
        expect.unreachable("deveria violar imob_assignments_one_pending_accept_per_broker");
      } catch (err) {
        expect(isUniqueViolation(err, "imob_assignments_one_pending_accept_per_broker")).toBe(true);
      }

      // claim atômico: aceito parado é reivindicado UMA vez (2ª chamada vazia)
      const conv3 = await seedConversation(tenantA);
      const { brokerId: b2 } = await createImobBroker({ name: "Saulo", whatsapp: "5544999112211" });
      const a3 = await createImobAssignment({
        conversationId: conv3,
        brokerId: b2,
        attempt: 1,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
      await acceptImobAssignment(a3.id);
      const claimed = await claimImobDueStatusFollowups({ inactivityMs: 0, maxFollowups: 3 });
      const mine = claimed.filter((c) => c.id === a3.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.followupCount).toBe(1);
      expect(mine[0]!.awaitingReply).toBe("status");
      // janela de 1min: prompted_at recém-setado bloqueia a re-reivindicação
      const again = await claimImobDueStatusFollowups({ inactivityMs: 60_000, maxFollowups: 3 });
      expect(again.map((c) => c.id)).not.toContain(a3.id);

      // revert (compensação de enqueue falho): volta a ser reivindicável e o
      // contador não avança em dobro (1 de novo, não 2)
      await revertImobStatusPrompt(a3.id);
      const reclaimed = await claimImobDueStatusFollowups({ inactivityMs: 0, maxFollowups: 3 });
      const mine2 = reclaimed.filter((c) => c.id === a3.id);
      expect(mine2).toHaveLength(1);
      expect(mine2[0]!.followupCount).toBe(1);
    });
  });

  it("RLS: tenant B não enxerga corretores/atribuições do tenant A", async () => {
    await runWithTenant({ tenantId: tenantB }, async () => {
      const candidates = await listImobBrokerCandidates();
      expect(candidates).toHaveLength(0);
      const assignments = await listImobAssignments();
      expect(assignments).toHaveLength(0);
      expect(await findImobBrokerByWa("5544999001234")).toBeNull();
    });
  });

  it("overview agrega sem vazar entre tenants e o system-scan acha o tenant A", async () => {
    await runWithTenant({ tenantId: tenantA }, async () => {
      const ov = await getImobOverview();
      expect(ov.today.offered).toBeGreaterThan(0);
      expect(ov.byBrokerToday.length).toBeGreaterThan(0);
    });
    await runWithTenant({ tenantId: tenantB }, async () => {
      const ov = await getImobOverview();
      expect(ov.today.offered).toBe(0);
    });
    // tenant A tem 'accepted' ativo (teste do follow-up) → entra na varredura
    const tenants = await listTenantsWithImobDue();
    expect(tenants).toContain(tenantA);
    expect(tenants).not.toContain(tenantB);
  });
});
