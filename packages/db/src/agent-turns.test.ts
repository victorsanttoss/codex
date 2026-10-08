import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { runWithTenant } from "@sdr/core";
import { closeDb, makeMigrationClient, withSystem, withTenant } from "./client";
import { getLeadProfile } from "./agent";
import {
  type AgentTurnClaim,
  type AgentTurnPlan,
  claimAgentTurn,
  completeAgentTurnEffect,
  finishAgentTurn,
  getAgentTurn,
  listRecoverableAgentTurns,
  listPendingAgentTurns,
  listTenantIdsWithPendingAgentTurns,
  listUncertainAgentTurns,
  markAgentTurnReply,
  releaseAgentTurnLease,
  renewAgentTurnLease,
  saveAgentTurnPlan,
} from "./agent-turns";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

describe.skipIf(!dbConfigured)("durable agent turns (real PostgreSQL + RLS)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantA: string;
  let tenantB: string;
  let conversationA: string;
  let conversationB: string;

  const plan: AgentTurnPlan = {
    replyText: "Vamos continuar o atendimento.",
    outcome: { type: "qualified", score: 80 },
    decision: { stage: "qualified", status: "qualified", score: 80 },
    armCadence: false,
  };

  function owned(claim: AgentTurnClaim) {
    expect(claim.state).toBe("owned");
    if (claim.state !== "owned") throw new Error("expected_owned_claim");
    return claim;
  }

  function input(externalMessageId = randomUUID()) {
    return { conversationId: conversationA, externalMessageId, conversationKey: "turn-test-a" };
  }

  function a<T>(fn: () => Promise<T>) {
    return runWithTenant({ tenantId: tenantA }, fn);
  }

  async function expire(id: string) {
    await a(() => withTenant(async (tx) => {
      await tx.execute(sql`
        UPDATE agent_turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${id}
      `);
    }));
  }

  async function seed(tenantId: string, key: string, withLead = true): Promise<string> {
    return mig.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const [contact] = await tx<{ id: string }[]>`
        INSERT INTO contacts (tenant_id, wa_id) VALUES (${tenantId}, ${randomUUID()}) RETURNING id`;
      const [conversation] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, contact_id, conversation_key)
        VALUES (${tenantId}, ${contact!.id}, ${key}) RETURNING id`;
      if (withLead) {
        await tx`INSERT INTO lead_profiles (tenant_id, conversation_id) VALUES (${tenantId}, ${conversation!.id})`;
      }
      return conversation!.id;
    }) as Promise<string>;
  }

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [a] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('Turn-A', ${randomUUID()}) RETURNING id`;
    const [b] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('Turn-B', ${randomUUID()}) RETURNING id`;
    tenantA = a!.id;
    tenantB = b!.id;
    conversationA = await seed(tenantA, "turn-test-a");
    conversationB = await seed(tenantB, "turn-test-b");
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await mig.sql.end();
    await closeDb();
  });

  it("one concurrent claimant owns the event; other workers cannot overwrite the lease", async () => {
    const event = input();
    const claims = await a(() => Promise.all(Array.from({ length: 8 }, () => claimAgentTurn(event))));
    expect(claims.filter((c) => c.state === "owned")).toHaveLength(1);
    expect(claims.filter((c) => c.state === "busy")).toHaveLength(7);
    expect(new Set(claims.map((c) => c.turn.id)).size).toBe(1);
    expect(claims.every((c) => c.turn.attempts === 1)).toBe(true);
  });

  it("plan + lead decision commit together, stay immutable, and preserve the response after terminal decision", async () => {
    const event = input();
    await a(async () => {
      const c = owned(await claimAgentTurn(event));
      expect(await saveAgentTurnPlan(c.turn.id, c.token, plan)).toBe(true);
      expect(await getLeadProfile(conversationA)).toMatchObject({ stage: "qualified", status: "qualified", score: 80 });
      expect(await saveAgentTurnPlan(c.turn.id, c.token, { ...plan, replyText: "replacement", decision: { score: 1 } })).toBe(false);
      expect((await getAgentTurn(conversationA, event.externalMessageId))?.plan).toEqual(plan);
      expect((await getLeadProfile(conversationA))?.score).toBe(80);
      expect(await releaseAgentTurnLease(c.turn.id, c.token, "send_failed")).toBe(true);
      const retry = owned(await claimAgentTurn(event));
      expect(retry.turn).toMatchObject({ status: "ready", plan, replyStatus: "pending", attempts: 2 });
      expect(retry.token).not.toBe(c.token);
    });
  });

  it("decision failure rolls back the saved plan, allowing a valid plan to be retried", async () => {
    const conversation = await seed(tenantA, randomUUID(), false);
    const event = { ...input(), conversationId: conversation };
    await a(async () => {
      const c = owned(await claimAgentTurn(event));
      await expect(saveAgentTurnPlan(c.turn.id, c.token, plan)).rejects.toThrow("agent_turn_lead_missing");
      expect(await getAgentTurn(conversation, event.externalMessageId)).toMatchObject({ status: "planning", plan: null });
      expect(await saveAgentTurnPlan(c.turn.id, c.token, { ...plan, decision: null })).toBe(true);
    });
  });

  it("expired lease cannot write/renew/release; the new token fences every old operation", async () => {
    const event = input();
    const first = await a(async () => owned(await claimAgentTurn(event)));
    await expire(first.turn.id);
    await a(async () => {
      expect(await saveAgentTurnPlan(first.turn.id, first.token, plan)).toBe(false);
      expect(await renewAgentTurnLease(first.turn.id, first.token)).toBe(false);
      expect(await releaseAgentTurnLease(first.turn.id, first.token)).toBe(false);
      const retry = owned(await claimAgentTurn(event));
      expect(retry.turn.attempts).toBe(2);
      expect(retry.turn.leaseExpiresAt).toBeInstanceOf(Date);
      expect(retry.token).not.toBe(first.token);
      expect(await saveAgentTurnPlan(retry.turn.id, retry.token, plan)).toBe(true);
      expect(await markAgentTurnReply(first.turn.id, first.token, "sent")).toBe(false);
      expect(await completeAgentTurnEffect(first.turn.id, first.token, "crm")).toBe(false);
      expect(await finishAgentTurn(first.turn.id, first.token)).toBe(false);
      expect(await renewAgentTurnLease(first.turn.id, first.token)).toBe(false);
      expect(await releaseAgentTurnLease(first.turn.id, first.token)).toBe(false);
      expect(await renewAgentTurnLease(retry.turn.id, retry.token, 60_000)).toBe(true);
      expect(await claimAgentTurn(event)).toMatchObject({ state: "busy", turn: { attempts: 2 } });
    });
  });

  it("definite send failure returns to pending; a crashed sending turn becomes uncertain and never reopens", async () => {
    const event = input();
    const first = await a(async () => {
      const c = owned(await claimAgentTurn(event));
      await saveAgentTurnPlan(c.turn.id, c.token, plan);
      expect(await markAgentTurnReply(c.turn.id, c.token, "sending")).toBe(true);
      expect(await markAgentTurnReply(c.turn.id, c.token, "pending")).toBe(true);
      expect(await releaseAgentTurnLease(c.turn.id, c.token, "transport_failed")).toBe(true);
      const retry = owned(await claimAgentTurn(event));
      expect(retry.turn.replyStatus).toBe("pending");
      await markAgentTurnReply(retry.turn.id, retry.token, "sending");
      return retry;
    });
    await expire(first.turn.id);
    await a(async () => {
      const retry = owned(await claimAgentTurn(event));
      expect(retry.turn).toMatchObject({ replyStatus: "uncertain", status: "ready", plan });
      expect(await markAgentTurnReply(retry.turn.id, retry.token, "pending")).toBe(false);
      expect(await markAgentTurnReply(retry.turn.id, retry.token, "sending")).toBe(false);
      expect(await finishAgentTurn(retry.turn.id, retry.token)).toBe(true);
      expect(await claimAgentTurn(event)).toMatchObject({
        state: "complete", turn: { replyStatus: "uncertain", lastError: "reply_delivery_uncertain" },
      });
      expect((await listUncertainAgentTurns()).some((r) => r.id === retry.turn.id)).toBe(true);
      await runWithTenant({ tenantId: tenantB }, async () => {
        expect(await listUncertainAgentTurns()).toEqual([]);
      });
    });
  });

  it("effects are idempotent and durable; completed turns cannot be reclaimed or sent again", async () => {
    const event = input();
    await a(async () => {
      const c = owned(await claimAgentTurn(event));
      expect(await finishAgentTurn(c.turn.id, c.token)).toBe(false);
      expect(await completeAgentTurnEffect(c.turn.id, c.token, "crm")).toBe(false);
      await saveAgentTurnPlan(c.turn.id, c.token, plan);
      expect(await finishAgentTurn(c.turn.id, c.token)).toBe(false);
      expect(await completeAgentTurnEffect(c.turn.id, c.token, "crm")).toBe(true);
      expect(await completeAgentTurnEffect(c.turn.id, c.token, "crm")).toBe(true);
      await markAgentTurnReply(c.turn.id, c.token, "sent");
      expect(await markAgentTurnReply(c.turn.id, c.token, "pending")).toBe(false);
      await releaseAgentTurnLease(c.turn.id, c.token);
      const retry = owned(await claimAgentTurn(event));
      expect(retry.turn.completedEffects).toEqual(["crm"]);
      expect(retry.turn.replyStatus).toBe("sent");
      await completeAgentTurnEffect(retry.turn.id, retry.token, "handoff");
      expect(await finishAgentTurn(retry.turn.id, retry.token)).toBe(true);
      const complete = await claimAgentTurn(event);
      expect(complete).toMatchObject({ state: "complete", turn: { attempts: 2, leaseToken: null, completedEffects: ["crm", "handoff"] } });
      expect(await markAgentTurnReply(retry.turn.id, retry.token, "sending")).toBe(false);
      expect(await renewAgentTurnLease(retry.turn.id, retry.token)).toBe(false);
      expect(await releaseAgentTurnLease(retry.turn.id, retry.token)).toBe(false);
    });
  });

  it("recovery lists only persisted incomplete plans in creation order, scoped to conversation", async () => {
    const conversation = await seed(tenantA, randomUUID());
    const events = Array.from({ length: 4 }, () => ({ ...input(), conversationId: conversation }));
    await a(async () => {
      for (let i = 0; i < events.length; i++) {
        const c = owned(await claimAgentTurn(events[i]!));
        if (i > 0) await saveAgentTurnPlan(c.turn.id, c.token, plan);
        if (i === 3) {
          await markAgentTurnReply(c.turn.id, c.token, "suppressed");
          await finishAgentTurn(c.turn.id, c.token);
        } else {
          await releaseAgentTurnLease(c.turn.id, c.token);
        }
      }
      expect((await listRecoverableAgentTurns(conversation)).map((r) => r.externalMessageId))
        .toEqual([events[1]!.externalMessageId, events[2]!.externalMessageId]);
      expect((await listRecoverableAgentTurns(conversation, 1)).map((r) => r.externalMessageId))
        .toEqual([events[1]!.externalMessageId]);
    });
  });

  it("tenant isolation applies to reads, writes, raw system access and same-tenant conversation FK", async () => {
    const event = input();
    const c = await a(async () => {
      const c = owned(await claimAgentTurn(event));
      await saveAgentTurnPlan(c.turn.id, c.token, plan);
      return c;
    });
    await runWithTenant({ tenantId: tenantB }, async () => {
      expect(await getAgentTurn(conversationA, event.externalMessageId)).toBeNull();
      expect(await listRecoverableAgentTurns(conversationA)).toEqual([]);
      expect(await saveAgentTurnPlan(c.turn.id, c.token, plan)).toBe(false);
      expect(await renewAgentTurnLease(c.turn.id, c.token)).toBe(false);
      expect(await markAgentTurnReply(c.turn.id, c.token, "sent")).toBe(false);
      expect(await completeAgentTurnEffect(c.turn.id, c.token, "crm")).toBe(false);
      expect(await finishAgentTurn(c.turn.id, c.token)).toBe(false);
      expect(await releaseAgentTurnLease(c.turn.id, c.token)).toBe(false);
      await expect(claimAgentTurn(event)).rejects.toMatchObject({ cause: { code: "23503" } });
      // The external event id may be reused by another company/conversation.
      const other = owned(await claimAgentTurn({ ...event, conversationId: conversationB, conversationKey: "turn-test-b" }));
      expect(other.turn.id).not.toBe(c.turn.id);
    });
    const raw = await withSystem((db) => db.execute(sql`SELECT id FROM agent_turns`));
    expect(raw).toHaveLength(0);
  });

  it("only generic error codes are persisted and invalid lease duration is rejected", async () => {
    const event = input();
    await a(async () => {
      const c = owned(await claimAgentTurn(event));
      await releaseAgentTurnLease(c.turn.id, c.token, "Error: token=confidential lead +55119999");
      expect((await getAgentTurn(conversationA, event.externalMessageId))?.lastError).toBe("turn_failed");
      await expect(claimAgentTurn({ ...input(), leaseMs: Number.NaN })).rejects.toThrow("invalid_agent_turn_lease");
    });
  });

  it("system recovery returns active tenant ids only and does not leak the scan flag; tenant recovery skips active leases", async () => {
    const event = { ...input(), conversationId: await seed(tenantA, randomUUID()) };
    const claim = await a(async () => {
      const c = owned(await claimAgentTurn(event));
      await saveAgentTurnPlan(c.turn.id, c.token, { ...plan, source: { from: "synthetic-contact", type: "text" } });
      expect((await listPendingAgentTurns()).some((r) => r.id === c.turn.id)).toBe(false);
      return c;
    });
    await expire(claim.turn.id);
    await a(async () => {
      expect((await listPendingAgentTurns()).some((r) => r.id === claim.turn.id)).toBe(true);
      expect((await listPendingAgentTurns()).every((r) => r.conversationId !== conversationB)).toBe(true);
    });
    expect(await listTenantIdsWithPendingAgentTurns()).toContain(tenantA);
    expect(await listTenantIdsWithPendingAgentTurns()).not.toContain(tenantB);
    await mig.sql`UPDATE tenants SET status = 'suspended' WHERE id = ${tenantA}`;
    expect(await listTenantIdsWithPendingAgentTurns()).not.toContain(tenantA);
    await mig.sql`UPDATE tenants SET status = 'active' WHERE id = ${tenantA}`;
    const raw = await withSystem((db) => db.execute(sql`SELECT id FROM agent_turns`));
    expect(raw).toHaveLength(0);
    // Setting the scan flag in a helper never enables a cross-tenant write.
    await runWithTenant({ tenantId: tenantB }, async () => {
      await listTenantIdsWithPendingAgentTurns();
      expect(await getAgentTurn(conversationA, event.externalMessageId)).toBeNull();
      expect(await releaseAgentTurnLease(claim.turn.id, claim.token)).toBe(false);
    });
  });

  it("retry fairness rotates more than a batch of failed conversations while preserving each predecessor", async () => {
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('Turn-Fair', ${randomUUID()}) RETURNING id`;
    const tenantId = t!.id;
    try {
      const conversations = await Promise.all(Array.from({ length: 6 }, () => seed(tenantId, randomUUID())));
      const events = conversations.map((conversationId) => ({ ...input(), conversationId }));
      await runWithTenant({ tenantId }, async () => {
        for (const event of events) {
          const c = owned(await claimAgentTurn(event));
          await saveAgentTurnPlan(c.turn.id, c.token, plan);
          await releaseAgentTurnLease(c.turn.id, c.token, "permanent_failure");
        }
        // A later ready turn on the first conversation must not jump its failed predecessor.
        const successor = { ...events[0]!, externalMessageId: randomUUID() };
        const later = owned(await claimAgentTurn(successor));
        await saveAgentTurnPlan(later.turn.id, later.token, plan);
        await releaseAgentTurnLease(later.turn.id, later.token);
        const visited = new Set<string>();
        for (let batch = 0; batch < 3; batch++) {
          const rows = await listPendingAgentTurns(2);
          expect(rows).toHaveLength(2);
          expect(rows.some((row) => row.externalMessageId === successor.externalMessageId)).toBe(false);
          for (const row of rows) {
            expect(visited.has(row.conversationId)).toBe(false);
            visited.add(row.conversationId);
            const c = owned(await claimAgentTurn({
              conversationId: row.conversationId, externalMessageId: row.externalMessageId,
              conversationKey: row.conversationKey,
            }));
            await releaseAgentTurnLease(c.turn.id, c.token, "permanent_failure");
          }
        }
        expect(visited.size).toBe(6);
        const predecessor = owned(await claimAgentTurn(events[0]!));
        // Even if successor has no lease, the active predecessor blocks this conversation.
        expect((await listPendingAgentTurns(50)).some((row) => row.conversationId === events[0]!.conversationId)).toBe(false);
        await markAgentTurnReply(predecessor.turn.id, predecessor.token, "suppressed");
        await finishAgentTurn(predecessor.turn.id, predecessor.token);
        expect((await listPendingAgentTurns(50)).some((row) => row.externalMessageId === successor.externalMessageId)).toBe(true);
      });
    } finally {
      await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
  });

  it("transport filters apply before the limit, match active connections and exclude malformed or mismatched source routes", async () => {
    const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('Turn-Routes', ${randomUUID()}) RETURNING id`;
    const tenantId = t!.id;
    const cloudAccount = "cloud-" + randomUUID();
    const baileysAccount = "baileys-" + randomUUID();
    const pausedAccount = "paused-" + randomUUID();
    try {
      await mig.sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`INSERT INTO channel_connections (tenant_id, phone_number_id, provider, status, secret_ref)
          VALUES (${tenantId}, ${cloudAccount}, 'cloud_api', 'active', 'whatsapp_token'),
                 (${tenantId}, ${baileysAccount}, 'baileys', 'active', 'whatsapp_token'),
                 (${tenantId}, ${pausedAccount}, 'cloud_api', 'disconnected', 'whatsapp_token')`;
      });
      const specs = [
        { provider: "baileys", account: baileysAccount, source: true },
        { provider: "cloud_api", account: pausedAccount, source: true },
        { provider: "cloud_api", account: cloudAccount, source: false },
        { provider: "cloud_api", account: cloudAccount, source: true, mismatch: true },
        { provider: "cloud_api", account: cloudAccount, source: true, wrongFrom: true },
        { provider: "cloud_api", account: cloudAccount, source: true, extraSegment: true },
        { provider: "cloud_api", account: cloudAccount, source: true },
      ];
      const events: ReturnType<typeof input>[] = [];
      await runWithTenant({ tenantId }, async () => {
        for (const spec of specs) {
          const from = randomUUID();
          const conversationKey = `${spec.provider}:${spec.account}:${from}${spec.extraSegment ? ":extra" : ""}`;
          const conversationId = await seed(tenantId, conversationKey);
          const event = { ...input(), conversationId, conversationKey };
          events.push(event);
          const c = owned(await claimAgentTurn(event));
          await saveAgentTurnPlan(c.turn.id, c.token, {
            ...plan,
            ...(spec.source ? { source: {
              from: spec.wrongFrom ? "wrong-contact" : from, type: "text", provider: spec.provider,
              channelAccountId: spec.mismatch ? "wrong-account" : spec.account,
            } } : {}),
          });
          await releaseAgentTurnLease(c.turn.id, c.token);
        }
        expect((await listPendingAgentTurns(1, { provider: "cloud_api" })).map((row) => row.externalMessageId))
          .toEqual([events[6]!.externalMessageId]);
        expect((await listPendingAgentTurns(1, { provider: "baileys", channelAccountId: baileysAccount })).map((row) => row.externalMessageId))
          .toEqual([events[0]!.externalMessageId]);
        expect(await listPendingAgentTurns(10, { provider: "baileys", channelAccountId: cloudAccount })).toEqual([]);
      });
    } finally {
      await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
  });
});
