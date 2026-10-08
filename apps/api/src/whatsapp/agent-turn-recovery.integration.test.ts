import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import { runWithTenant } from "@sdr/core";
import { loadConfig } from "@sdr/config";
import {
  claimAgentTurn,
  closeDb,
  getAgentTurn,
  getConnectionForConversation,
  makeMigrationClient,
  recordInboundMessage,
  releaseAgentTurnLease,
  saveAgentTurnPlan,
  upsertChannelConnection,
  type AgentTurnRow,
  type ResolvedConnection,
} from "@sdr/db";
import { InboundCoreService } from "./inbound-core.service";
import { InboundPipelineService } from "./inbound-pipeline.service";
import type { ChannelFactory } from "./channel-factory.service";
import type { MediaService } from "./media.service";
import type { AudioEnrichmentService } from "../transcription/audio-enrichment.service";
import { SerializedRunner } from "../queue/serialized-runner";
import { OutboxService } from "../outbox/outbox.service";
import { AgentMessageHandler } from "../agent/agent-message.handler";
import { AgentTurnService } from "../agent/agent-turn.service";
import type { AgentService } from "../agent/agent.service";
import type { AgentConfigService } from "../agent/agent-config";
import type { KnowledgeRetriever } from "../knowledge/knowledge-retriever.service";
import type { LeadOutcomeService } from "../crm/lead-outcome.service";
import type { CadenceService } from "../cadence/cadence.service";
import type { NicheService } from "../niche/niche.service";
import type { FieldExtractor } from "../agent/field-extractor";

const configured = Boolean(
  process.env.DATABASE_URL &&
  process.env.MIGRATION_DATABASE_URL &&
  process.env.REDIS_URL,
);

describe.skipIf(!configured)(
  "durable Cloud transport recovery — DB/Redis reais",
  () => {
    let migration: ReturnType<typeof makeMigrationClient>;
    let redis: Redis;
    let tenantId: string;
    const accountId = `recovery-account-${randomUUID()}`;
    const runModel = vi
      .fn()
      .mockRejectedValue(new Error("LLM must not run during recovery"));
    const loadAgentConfig = vi
      .fn()
      .mockRejectedValue(
        new Error("config must not be rebuilt during recovery"),
      );
    const outcome = {
      onTurnEnd: vi.fn().mockResolvedValue(undefined),
    } as unknown as LeadOutcomeService;
    const cadence = {
      armFirstStep: vi.fn().mockResolvedValue(undefined),
    } as unknown as CadenceService;

    beforeAll(async () => {
      const config = loadConfig();
      migration = makeMigrationClient();
      redis = new Redis(config.redis.url, { maxRetriesPerRequest: null });
      const [tenant] = await migration.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('Recovery', ${`recovery-${randomUUID()}`}) RETURNING id`;
      tenantId = tenant!.id;
      await runWithTenant({ tenantId }, () =>
        upsertChannelConnection({
          phoneNumberId: accountId,
          provider: "cloud_api",
        }),
      );
    });

    afterAll(async () => {
      if (tenantId)
        await migration.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
      await migration?.sql.end();
      await redis?.quit();
      await closeDb();
    });

    async function storedPlan(): Promise<{
      turn: AgentTurnRow;
      conn: ResolvedConnection;
    }> {
      return runWithTenant({ tenantId }, async () => {
        const from = `5511${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0")}`;
        const externalMessageId = `recovery-inbound-${randomUUID()}`;
        const conversationKey = `cloud_api:${accountId}:${from}`;
        const { conversationId } = await recordInboundMessage({
          conversationKey,
          waId: from,
          externalMessageId,
          type: "text",
          content: { text: "synthetic inbound" },
          receivedAt: new Date(),
        });
        const claim = await claimAgentTurn({
          conversationId,
          externalMessageId,
          conversationKey,
        });
        if (claim.state !== "owned") throw new Error("test claim not owned");
        await saveAgentTurnPlan(claim.turn.id, claim.token, {
          replyText:
            "Sua solicitação foi recebida e registrada para atendimento.",
          decision: null,
          outcome: null,
          // A newer inbound reopened the current persisted window. Old source
          // metadata never creates a synthetic inbound/window during recovery.
          source: {
            from,
            type: "text",
            provider: "cloud_api",
            channelAccountId: accountId,
            receivedAt: "2020-01-01T00:00:00.000Z",
          },
        });
        await releaseAgentTurnLease(claim.turn.id, claim.token);
        const conn = await getConnectionForConversation(conversationId);
        return {
          turn: (await getAgentTurn(conversationId, externalMessageId))!,
          conn: {
            tenantId,
            connectionId: conn!.connectionId,
            secretRef: conn!.secretRef,
          },
        };
      });
    }

    /** New instances discard all handler/service/core process memory. */
    function freshPipeline(
      sendMessage: ReturnType<typeof vi.fn>,
      failLedgerReference = false,
    ): InboundPipelineService {
      const turns = new AgentTurnService(outcome, cadence);
      const handler = new AgentMessageHandler(
        { run: runModel } as unknown as AgentService,
        { forTenant: loadAgentConfig } as unknown as AgentConfigService,
        {} as KnowledgeRetriever,
        outcome,
        cadence,
        {} as NicheService,
        {} as FieldExtractor,
        undefined,
        undefined,
        undefined,
        turns,
      );
      const channels = {
        tenantSender: vi.fn().mockResolvedValue({ sendMessage }),
      } as unknown as ChannelFactory;
      const core = new InboundCoreService(
        {} as MediaService,
        {} as AudioEnrichmentService,
        new SerializedRunner(redis),
        handler,
      );
      const outbox = new OutboxService(channels);
      if (failLedgerReference) {
        // Fault injection: the real ledger INSERT references a missing conversation
        // and is rejected by PostgreSQL after the real transcript INSERT succeeded.
        const record = outbox.recordReactiveDelivery.bind(outbox);
        vi.spyOn(outbox, "recordReactiveDelivery").mockImplementation(
          (payload, options) =>
            record({ ...payload, conversationId: randomUUID() }, options),
        );
      }
      const pipeline = new InboundPipelineService(channels, core, outbox);
      pipeline.bubblePause = async () => {};
      return pipeline;
    }

    it("persisted plan survives restart, routes through core/handler, records delivery and is not sent twice", async () => {
      const { turn, conn } = await storedPlan();
      const send = vi
        .fn()
        .mockResolvedValue({
          externalMessageId: `recovery-out-${randomUUID()}`,
          acceptedAt: new Date().toISOString(),
        });
      await freshPipeline(send).recoverTurn(turn, conn, accountId);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({
        to: turn.plan!.source!.from,
        text: turn.plan!.replyText,
      });
      const persisted = await runWithTenant({ tenantId }, () =>
        getAgentTurn(turn.conversationId, turn.externalMessageId),
      );
      expect(persisted).toMatchObject({
        status: "complete",
        replyStatus: "sent",
      });
      await freshPipeline(send).recoverTurn(turn, conn, accountId);
      expect(send).toHaveBeenCalledTimes(1);
      expect(runModel).not.toHaveBeenCalled();
      expect(loadAgentConfig).not.toHaveBeenCalled();
    });

    it("uncertain transport outcome survives restart; recovery completes internally without a blind resend", async () => {
      const { turn, conn } = await storedPlan();
      const send = vi
        .fn()
        .mockRejectedValue(
          new Error("network timed out after possible acceptance"),
        );
      await expect(
        freshPipeline(send).recoverTurn(turn, conn, accountId),
      ).rejects.toMatchObject({ delivery: "uncertain" });
      const pending = await runWithTenant({ tenantId }, () =>
        getAgentTurn(turn.conversationId, turn.externalMessageId),
      );
      expect(pending).toMatchObject({
        status: "ready",
        replyStatus: "uncertain",
        leaseToken: null,
      });
      await freshPipeline(send).recoverTurn(pending!, conn, accountId);
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        await runWithTenant({ tenantId }, () =>
          getAgentTurn(turn.conversationId, turn.externalMessageId),
        ),
      ).toMatchObject({ status: "complete", replyStatus: "uncertain" });
      expect(runModel).not.toHaveBeenCalled();
      expect(loadAgentConfig).not.toHaveBeenCalled();
    });

    it("real post-acceptance ledger failure remains uncertain across restart", async () => {
      const { turn, conn } = await storedPlan();
      const send = vi
        .fn()
        .mockResolvedValue({
          externalMessageId: `recovery-out-${randomUUID()}`,
          acceptedAt: new Date().toISOString(),
        });
      await expect(
        freshPipeline(send, true).recoverTurn(turn, conn, accountId),
      ).rejects.toMatchObject({ delivery: "uncertain" });
      const pending = await runWithTenant({ tenantId }, () =>
        getAgentTurn(turn.conversationId, turn.externalMessageId),
      );
      expect(pending).toMatchObject({
        replyStatus: "uncertain",
        status: "ready",
      });
      await freshPipeline(send).recoverTurn(pending!, conn, accountId);
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        await runWithTenant({ tenantId }, () =>
          getAgentTurn(turn.conversationId, turn.externalMessageId),
        ),
      ).toMatchObject({ status: "complete", replyStatus: "uncertain" });
      expect(runModel).not.toHaveBeenCalled();
      expect(loadAgentConfig).not.toHaveBeenCalled();
    });
  },
);
