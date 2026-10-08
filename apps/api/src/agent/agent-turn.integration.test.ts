import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runWithTenant } from "@sdr/core";
import {
  claimAgentTurn,
  closeDb,
  getAgentTurn,
  getLeadProfile,
  getOrCreateLeadProfile,
  listUncertainAgentTurns,
  makeMigrationClient,
  markAgentTurnReply,
  markContactOptedOut,
  recordInboundMessage,
  releaseAgentTurnLease,
  saveAgentTurnPlan,
  setHumanTakeover,
  type AgentTurnPlan,
} from "@sdr/db";
import { AgentTurnService } from "./agent-turn.service";
import { AgentMessageHandler } from "./agent-message.handler";
import { DEFAULT_AGENT_CONFIG, type AgentConfigService } from "./agent-config";
import type { AgentService } from "./agent.service";
import type { FieldExtractor } from "./field-extractor";
import type { KnowledgeRetriever } from "../knowledge/knowledge-retriever.service";
import type { NicheService } from "../niche/niche.service";
import { LeadOutcomeService } from "../crm/lead-outcome.service";
import type { CrmService } from "../crm/crm.service";
import type { CrmSyncQueue } from "../crm/crm-sync.queue";
import type { ImobDistributionService } from "../imobiliario/imob-distribution.service";
import type { CadenceService } from "../cadence/cadence.service";
import {
  ReplyDeliveryError,
  type InboundMessageContext,
} from "../whatsapp/message-handler";

describe.skipIf(
  !process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL,
)("D06 — persisted turn recovery", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId: string;
  beforeAll(async () => {
    mig = makeMigrationClient();
    const [tenant] = await mig.sql<
      { id: string }[]
    >`INSERT INTO tenants (name, slug) VALUES ('TURN TEST', ${`turn-test-${randomUUID()}`}) RETURNING id`;
    tenantId = tenant!.id;
  });
  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await closeDb();
  });

  async function seed(): Promise<InboundMessageContext> {
    const key = `turn-${randomUUID()}`;
    const externalMessageId = randomUUID();
    const rec = await recordInboundMessage({
      conversationKey: key,
      waId: key,
      externalMessageId,
      type: "text",
      content: { text: "Olá" },
    });
    await getOrCreateLeadProfile(rec.conversationId);
    return {
      tenantId,
      conversationId: rec.conversationId,
      conversationKey: key,
      from: key,
      message: { externalMessageId, type: "text", text: "Olá" },
      reply: vi.fn(async () => {}),
    };
  }
  function services() {
    const notify = vi.fn(async () => {});
    const scheduling = vi.fn(async () => {});
    const enqueue = vi.fn(async () => {});
    const distribute = vi.fn(async () => {});
    const arm = vi.fn(async () => {});
    const outcome = new LeadOutcomeService(
      {
        notificationForTenant: async () => ({ notify }),
        schedulingForTenant: async () => ({ createAppointment: scheduling }),
      } as unknown as CrmService,
      { enqueueSync: enqueue } as unknown as CrmSyncQueue,
      { onHandoff: distribute } as unknown as ImobDistributionService,
    );
    const cadence = { armFirstStep: arm } as unknown as CadenceService;
    return {
      notify,
      scheduling,
      enqueue,
      distribute,
      arm,
      outcome,
      cadence,
      fresh: () => new AgentTurnService(outcome, cadence),
    };
  }
  function plan(ctx: InboundMessageContext, status = "handoff"): AgentTurnPlan {
    return {
      replyText: "Vou encaminhar você à equipe.",
      decision: { status, stage: status },
      armCadence: status === "new",
      outcome: {
        conversationId: ctx.conversationId,
        phone: ctx.from,
        fields: {},
        status,
        stage: status,
        handoff: status === "handoff",
      },
    };
  }

  it("retoma resposta salva após transição para handoff, sem repetir geração ou efeitos", async () =>
    runWithTenant({ tenantId }, async () => {
      const ctx = await seed();
      const s = services();
      const generate = vi.fn(async () => plan(ctx));
      ctx.reply = vi.fn(async () => {
        throw new ReplyDeliveryError("not_sent");
      });
      await expect(s.fresh().process(ctx, generate)).rejects.toThrow(
        "reply_delivery_failed",
      );
      expect((await getLeadProfile(ctx.conversationId))?.status).toBe(
        "handoff",
      );
      expect(
        (await getAgentTurn(ctx.conversationId, ctx.message.externalMessageId))
          ?.replyStatus,
      ).toBe("pending");
      const send = vi.fn(async () => {});
      await s.fresh().process({ ...ctx, reply: send }, generate);
      await s.fresh().process({ ...ctx, reply: send }, generate);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("Vou encaminhar você à equipe.");
      expect(s.notify).toHaveBeenCalledTimes(1);
      expect(s.enqueue).toHaveBeenCalledTimes(1);
      expect(
        (await getAgentTurn(ctx.conversationId, ctx.message.externalMessageId))
          ?.status,
      ).toBe("complete");
    }));

  it("checkpoint de cada efeito evita repetir agenda, notificações e distribuição após erro CRM", async () =>
    runWithTenant({ tenantId }, async () => {
      const ctx = await seed();
      const s = services();
      s.enqueue.mockRejectedValueOnce(new Error("queue_down"));
      const p = plan(ctx);
      p.outcome = {
        ...p.outcome!,
        scheduling: { details: "Visita", when: "2026-10-09T12:00:00Z" },
        booked: {
          appointmentId: randomUUID(),
          label: "Sexta às 9h",
          googleMirrored: true,
          rebooked: false,
        },
      };
      const generate = vi.fn(async () => p);
      await expect(s.fresh().process(ctx, generate)).rejects.toThrow(
        "queue_down",
      );
      const pending = await getAgentTurn(
        ctx.conversationId,
        ctx.message.externalMessageId,
      );
      expect(pending?.replyStatus).toBe("sent");
      expect(pending?.completedEffects).toEqual(
        expect.arrayContaining([
          "scheduling",
          "handoff_notification",
          "booking_notification",
          "imob_distribution",
        ]),
      );
      await s.fresh().resume(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(s.scheduling).toHaveBeenCalledTimes(1);
      expect(s.notify).toHaveBeenCalledTimes(2);
      expect(s.distribute).toHaveBeenCalledTimes(1);
      expect(s.enqueue).toHaveBeenCalledTimes(2);
    }));

  it("timeout ambíguo permanece consultável e não provoca reenvio ou cadência", async () =>
    runWithTenant({ tenantId }, async () => {
      const ctx = await seed();
      const s = services();
      ctx.reply = vi.fn(async () => {
        throw new Error("unknown_acceptance");
      });
      const generate = vi.fn(async () => plan(ctx, "new"));
      await expect(s.fresh().process(ctx, generate)).rejects.toThrow(
        "unknown_acceptance",
      );
      await s.fresh().resume(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(s.arm).not.toHaveBeenCalled();
      expect(await listUncertainAgentTurns()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversationId: ctx.conversationId,
            status: "complete",
            replyStatus: "uncertain",
            lastError: "reply_delivery_uncertain",
          }),
        ]),
      );
    }));

  it("queda durante envio é recuperada como uncertain sem emitir outra resposta", async () =>
    runWithTenant({ tenantId }, async () => {
      const ctx = await seed();
      const c = await claimAgentTurn({
        ...ctx,
        externalMessageId: ctx.message.externalMessageId,
      });
      if (c.state !== "owned") throw new Error("seed_claim_failed");
      await saveAgentTurnPlan(c.turn.id, c.token, plan(ctx));
      await markAgentTurnReply(c.turn.id, c.token, "sending");
      await releaseAgentTurnLease(c.turn.id, c.token);
      const s = services();
      await s.fresh().resume(ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
      expect(s.enqueue).toHaveBeenCalledTimes(1);
      expect(
        (await getAgentTurn(ctx.conversationId, ctx.message.externalMessageId))
          ?.replyStatus,
      ).toBe("uncertain");
    }));

  it.each(["human", "optout"])(
    "revalida %s antes de retomar envio e cadência",
    async (guard) =>
      runWithTenant({ tenantId }, async () => {
        const ctx = await seed();
        const s = services();
        const fail = {
          ...ctx,
          reply: async () => {
            throw new ReplyDeliveryError("not_sent");
          },
        };
        await expect(
          s.fresh().process(fail, async () => plan(ctx, "new")),
        ).rejects.toThrow();
        if (guard === "human") await setHumanTakeover(ctx.conversationId, true);
        else await markContactOptedOut(ctx.from);
        await s.fresh().resume(ctx);
        expect(ctx.reply).not.toHaveBeenCalled();
        expect(s.arm).not.toHaveBeenCalled();
        expect(
          (
            await getAgentTurn(
              ctx.conversationId,
              ctx.message.externalMessageId,
            )
          )?.replyStatus,
        ).toBe("suppressed");
      }),
  );

  it("fence perdido impede persistência do plano e todos os efeitos", async () =>
    runWithTenant({ tenantId }, async () => {
      const ctx = await seed();
      const s = services();
      await expect(
        s
          .fresh()
          .process({ ...ctx, isValid: async () => false }, async () =>
            plan(ctx),
          ),
      ).rejects.toThrow("agent_turn_lease_lost");
      expect(ctx.reply).not.toHaveBeenCalled();
      expect(s.notify).not.toHaveBeenCalled();
      expect(
        (await getAgentTurn(ctx.conversationId, ctx.message.externalMessageId))
          ?.plan,
      ).toBeNull();
      expect((await getLeadProfile(ctx.conversationId))?.status).toBe("new");
    }));

  it("uma nova entrada retoma o predecessor com sua identidade antes de gerar o novo turno", async () =>
    runWithTenant({ tenantId }, async () => {
      const ctx = await seed();
      const s = services();
      await expect(
        s.fresh().process(
          {
            ...ctx,
            reply: async () => {
              throw new ReplyDeliveryError("not_sent");
            },
          },
          async () => plan(ctx),
        ),
      ).rejects.toThrow();
      const order: string[] = [];
      const next = {
        ...ctx,
        message: { ...ctx.message, externalMessageId: randomUUID() },
        replyForTurn: async (eventId: string) => {
          order.push(eventId);
        },
      };
      await s.fresh().process(next, async () => {
        order.push("new_generation");
        return { replyText: "", outcome: null, decision: null };
      });
      expect(order).toEqual([ctx.message.externalMessageId, "new_generation"]);
    }));

  it("opt-out persistido bloqueia LLM/tools e efeitos prospectivos de planos antigos", async () =>
    runWithTenant({ tenantId }, async () => {
      const ctx = await seed();
      const s = services();
      const p = plan(ctx);
      p.outcome = { ...p.outcome!, scheduling: { details: "Visita pendente" } };
      await expect(
        s.fresh().process(
          {
            ...ctx,
            reply: async () => {
              throw new ReplyDeliveryError("not_sent");
            },
          },
          async () => p,
        ),
      ).rejects.toThrow();
      await markContactOptedOut(ctx.from);
      await s.fresh().resume(ctx);
      expect(s.scheduling).not.toHaveBeenCalled();
      expect(s.distribute).not.toHaveBeenCalled();
      expect(s.notify).toHaveBeenCalledTimes(1);
      expect(s.enqueue).toHaveBeenCalledTimes(1);
      const row = await getAgentTurn(
        ctx.conversationId,
        ctx.message.externalMessageId,
      );
      expect(row?.completedEffects).toEqual(
        expect.arrayContaining([
          "suppressed.scheduling",
          "suppressed.imob_distribution",
        ]),
      );
      const run = vi.fn(async () => {
        throw new Error("unexpected_llm");
      });
      const handler = new AgentMessageHandler(
        { run } as unknown as AgentService,
        {
          forTenant: async () => DEFAULT_AGENT_CONFIG,
        } as unknown as AgentConfigService,
        {} as KnowledgeRetriever,
        s.outcome,
        { onInbound: async () => {} } as unknown as CadenceService,
        {} as NicheService,
        {} as FieldExtractor,
      );
      await handler.handle({
        ...ctx,
        message: {
          ...ctx.message,
          externalMessageId: randomUUID(),
          text: "Olá novamente",
        },
      });
      expect(run).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    }));

  it("retry da confirmação de opt-out não depende de desfecho anterior indisponível", async () =>
    runWithTenant({ tenantId }, async () => {
      const ctx = await seed();
      const s = services();
      s.enqueue.mockRejectedValue(new Error("crm_unavailable"));
      await expect(
        s.fresh().process(ctx, async () => plan(ctx)),
      ).rejects.toThrow("crm_unavailable");
      const event = randomUUID();
      const confirmation = {
        ...ctx,
        message: { externalMessageId: event, type: "text", text: "pare" },
        reply: async () => {
          throw new ReplyDeliveryError("not_sent");
        },
      };
      await expect(
        s.fresh().process(confirmation, async () => {
          await markContactOptedOut(ctx.from);
          return {
            replyText: "Sua saída foi registrada.",
            outcome: null,
            decision: null,
            allowOptOutReply: true,
          };
        }),
      ).rejects.toThrow("reply_delivery_failed");
      const reply = vi.fn(async () => {});
      await s
        .fresh()
        .process(
          {
            ...confirmation,
            message: { externalMessageId: event, type: "text" },
            reply,
          },
          async () => {
            throw new Error("unexpected_regeneration");
          },
        );
      expect(reply).toHaveBeenCalledTimes(1);
      expect(s.enqueue).toHaveBeenCalledTimes(1);
      expect((await getAgentTurn(ctx.conversationId, event))?.status).toBe(
        "complete",
      );
    }));

  it("janela Cloud encerrada finaliza entrega suprimida e preserva os efeitos internos", async () =>
    runWithTenant({ tenantId }, async () => {
      const key = `cloud_api:test-account:${randomUUID()}`;
      const externalMessageId = randomUUID();
      const from = key.split(":")[2]!;
      const rec = await recordInboundMessage({
        conversationKey: key,
        waId: from,
        externalMessageId,
        type: "text",
        content: { text: "Olá" },
        receivedAt: new Date(Date.now() - 25 * 60 * 60_000),
      });
      await getOrCreateLeadProfile(rec.conversationId);
      const ctx: InboundMessageContext = {
        tenantId,
        conversationId: rec.conversationId,
        conversationKey: key,
        from,
        provider: "cloud_api",
        message: { externalMessageId, type: "text" },
        reply: vi.fn(async () => {}),
      };
      const s = services();
      await s.fresh().process(ctx, async () => plan(ctx));
      expect(ctx.reply).not.toHaveBeenCalled();
      expect(s.enqueue).toHaveBeenCalledTimes(1);
      expect(
        await getAgentTurn(ctx.conversationId, externalMessageId),
      ).toMatchObject({
        status: "complete",
        replyStatus: "suppressed",
        completedEffects: expect.arrayContaining(["suppressed.window_closed"]),
      });
    }));
});
