import { Injectable, Logger } from "@nestjs/common";
import {
  claimAgentTurn,
  completeAgentTurnEffect,
  finishAgentTurn,
  getAgentTurn,
  getConversationWindow,
  isWithinServiceWindow,
  isContactOptedOut,
  isHumanTakeover,
  listRecoverableAgentTurns,
  markAgentTurnReply,
  releaseAgentTurnLease,
  renewAgentTurnLease,
  saveAgentTurnPlan,
  type AgentTurnPlan,
  type AgentTurnRow,
} from "@sdr/db";
import { CadenceService } from "../cadence/cadence.service";
import { isOptOutText } from "../cadence/optout";
import {
  LeadOutcomeService,
  type TurnOutcome,
} from "../crm/lead-outcome.service";
import { safeErrorFields } from "../observability/logger";
import {
  ReplyDeliveryError,
  type InboundMessageContext,
} from "../whatsapp/message-handler";

const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;

/** Persist intent before delivery; an external acceptance and a DB commit are not atomic. */
@Injectable()
export class AgentTurnService {
  private readonly logger = new Logger(AgentTurnService.name);

  constructor(
    private readonly outcome: LeadOutcomeService,
    private readonly cadence: CadenceService,
  ) {}

  async process(
    ctx: InboundMessageContext,
    buildPlan: () => Promise<AgentTurnPlan>,
  ): Promise<void> {
    const existing = await getAgentTurn(
      ctx.conversationId,
      ctx.message.externalMessageId,
    );
    if (existing?.status === "complete") return;
    // Honour a fresh opt-out before resuming older replies. Other messages wait
    // for persisted predecessors, so their lead decisions do not overtake them.
    if (
      !existing?.plan?.allowOptOutReply &&
      !(ctx.message.text && isOptOutText(ctx.message.text))
    ) {
      for (const previous of await listRecoverableAgentTurns(
        ctx.conversationId,
      )) {
        if (previous.externalMessageId === ctx.message.externalMessageId) break;
        await this.execute(this.replayContext(ctx, previous), async () => {
          throw new Error("agent_turn_plan_missing");
        });
      }
    }
    await this.execute(ctx, buildPlan);
  }

  /** Background recovery never invokes the LLM or changes the persisted plan. */
  async resume(ctx: InboundMessageContext): Promise<void> {
    if (
      !(await getAgentTurn(ctx.conversationId, ctx.message.externalMessageId))
        ?.plan
    ) {
      throw new Error("agent_turn_plan_missing");
    }
    await this.execute(ctx, async () => {
      throw new Error("agent_turn_plan_missing");
    });
  }

  private replayContext(
    ctx: InboundMessageContext,
    row: AgentTurnRow,
  ): InboundMessageContext {
    const source = row.plan?.source;
    return {
      ...ctx,
      from: source?.from ?? ctx.from,
      ...(source?.receivedAt ? { receivedAt: source.receivedAt } : {}),
      ...(source?.provider ? { provider: source.provider } : {}),
      ...(source?.channelAccountId
        ? { channelAccountId: source.channelAccountId }
        : {}),
      ...(source?.senderAddress ? { senderAddress: source.senderAddress } : {}),
      conversationKey: row.conversationKey,
      message: {
        externalMessageId: row.externalMessageId,
        type: source?.type ?? "text",
      },
      reply: async (text, options) => {
        if (!ctx.replyForTurn)
          throw new ReplyDeliveryError(
            "not_sent",
            "turn_replay_transport_unavailable",
          );
        if (options)
          await ctx.replyForTurn(row.externalMessageId, text, options);
        else await ctx.replyForTurn(row.externalMessageId, text);
      },
    };
  }

  private async execute(
    ctx: InboundMessageContext,
    buildPlan: () => Promise<AgentTurnPlan>,
  ): Promise<void> {
    const claim = await claimAgentTurn({
      conversationId: ctx.conversationId,
      externalMessageId: ctx.message.externalMessageId,
      conversationKey: ctx.conversationKey,
      leaseMs: LEASE_MS,
    });
    if (claim.state === "complete") return;
    if (claim.state !== "owned") throw new Error("agent_turn_busy");
    const { token, turn } = claim;
    let lost = false;
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      void (async () => {
        if (ctx.isValid && !(await ctx.isValid())) return false;
        return renewAgentTurnLease(turn.id, token, LEASE_MS);
      })()
        .then((ok) => {
          if (!ok) lost = true;
        })
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          renewing = false;
        });
    }, HEARTBEAT_MS);
    heartbeat.unref();
    const assertLease = async () => {
      if (
        lost ||
        (ctx.isValid && !(await ctx.isValid())) ||
        !(await renewAgentTurnLease(turn.id, token, LEASE_MS))
      ) {
        lost = true;
        throw new Error("agent_turn_lease_lost");
      }
    };
    const checkpoint = async (key: string) => {
      if (!(await completeAgentTurnEffect(turn.id, token, key)))
        throw new Error("agent_turn_lease_lost");
      turn.completedEffects.push(key);
    };
    const markReply = async (status: AgentTurnRow["replyStatus"]) => {
      if (!(await markAgentTurnReply(turn.id, token, status)))
        throw new Error("agent_turn_lease_lost");
      turn.replyStatus = status;
    };

    try {
      let plan = turn.plan;
      if (!plan) {
        const generated = await buildPlan();
        await assertLease();
        plan = {
          ...generated,
          source: {
            from: ctx.from,
            type: ctx.message.type,
            ...(ctx.receivedAt ? { receivedAt: ctx.receivedAt } : {}),
            ...(ctx.senderAddress ? { senderAddress: ctx.senderAddress } : {}),
            ...(ctx.provider ? { provider: ctx.provider } : {}),
            ...(ctx.channelAccountId
              ? { channelAccountId: ctx.channelAccountId }
              : {}),
          },
        };
        if (!(await saveAgentTurnPlan(turn.id, token, plan)))
          throw new Error("agent_turn_lease_lost");
      }

      if (turn.replyStatus === "pending") {
        await assertLease();
        const windowClosed =
          ctx.provider === "cloud_api" &&
          !isWithinServiceWindow(
            await getConversationWindow(ctx.conversationId),
          );
        const blocked =
          windowClosed ||
          !plan.replyText ||
          (!plan.allowOptOutReply &&
            ((await isHumanTakeover(ctx.conversationId)) ||
              (await isContactOptedOut(ctx.from))));
        if (blocked) {
          await markReply("suppressed");
          if (windowClosed) await checkpoint("suppressed.window_closed");
        } else {
          await markReply("sending");
          try {
            if (plan.allowOptOutReply)
              await ctx.reply(plan.replyText, { allowOptOutReply: true });
            else await ctx.reply(plan.replyText);
          } catch (error) {
            const definite =
              error instanceof ReplyDeliveryError &&
              error.delivery === "not_sent";
            await markReply(definite ? "pending" : "uncertain");
            // Keep errors eligible for worker retry. An uncertain retry resumes
            // internal effects while leaving delivery to an operator.
            throw error;
          }
          await markReply("sent");
        }
      }

      if (turn.replyStatus === "uncertain") {
        this.logger.warn({
          event: "agent_reply_delivery_uncertain",
          turnId: turn.id,
          conversationId: ctx.conversationId,
        });
      }
      if (plan.outcome && !turn.completedEffects.includes("outcome")) {
        await assertLease();
        await this.outcome.onTurnEnd(plan.outcome as unknown as TurnOutcome, {
          completed: (key) => turn.completedEffects.includes(key),
          checkpoint,
          assertLease,
          permitted: async (key) => {
            if (key !== "scheduling" && key !== "imob_distribution")
              return true;
            return (
              !(await isContactOptedOut(ctx.from)) &&
              !(await isHumanTakeover(ctx.conversationId))
            );
          },
        });
        await checkpoint("outcome");
      }
      if (plan.armCadence && !turn.completedEffects.includes("cadence")) {
        await assertLease();
        // An uncertain response must not trigger a prospecting follow-up.
        if (
          turn.replyStatus === "sent" &&
          !(await isHumanTakeover(ctx.conversationId)) &&
          !(await isContactOptedOut(ctx.from))
        ) {
          await this.cadence.armFirstStep(ctx.conversationId);
        }
        await checkpoint("cadence");
      }
      await assertLease();
      if (!(await finishAgentTurn(turn.id, token)))
        throw new Error("agent_turn_lease_lost");
    } catch (error) {
      await releaseAgentTurnLease(
        turn.id,
        token,
        "turn_execution_failed",
      ).catch(() => undefined);
      this.logger.warn({
        event: "agent_turn_pending",
        turnId: turn.id,
        error: safeErrorFields(error),
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
