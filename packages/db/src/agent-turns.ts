import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import type { LeadDecisionUpdate } from "./agent";
import { getDb, withTenant } from "./client";

export interface AgentTurnPlan {
  replyText: string;
  outcome: Record<string, unknown> | null;
  decision: LeadDecisionUpdate | null;
  allowOptOutReply?: boolean;
  armCadence?: boolean;
  /** Replay metadata; channel is derived from the persisted conversation key. */
  source?: {
    from: string;
    receivedAt?: string;
    type: string;
    senderAddress?: string;
    provider?: string;
    channelAccountId?: string;
  };
}

export type AgentTurnReplyStatus = "pending" | "sending" | "sent" | "suppressed" | "uncertain";

export interface AgentTurnRow {
  id: string;
  conversationId: string;
  externalMessageId: string;
  conversationKey: string;
  plan: AgentTurnPlan | null;
  status: "planning" | "ready" | "complete";
  replyStatus: AgentTurnReplyStatus;
  completedEffects: string[];
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export type AgentTurnClaim =
  | { state: "owned"; turn: AgentTurnRow; token: string }
  | { state: "busy" | "complete"; turn: AgentTurnRow };

interface StoredTurn {
  id: string;
  conversation_id: string;
  external_message_id: string;
  conversation_key: string;
  plan: AgentTurnPlan | null;
  status: AgentTurnRow["status"];
  reply_status: AgentTurnReplyStatus;
  completed_effects: string[];
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  attempts: number;
  last_error: string | null;
}

const DEFAULT_LEASE_MS = 120_000;

function leaseDuration(value = DEFAULT_LEASE_MS): number {
  if (!Number.isFinite(value) || value < 1 || value > 900_000) {
    throw new Error("invalid_agent_turn_lease");
  }
  return Math.floor(value);
}

function mapTurn(row: StoredTurn): AgentTurnRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    externalMessageId: row.external_message_id,
    conversationKey: row.conversation_key,
    plan: row.plan,
    status: row.status,
    replyStatus: row.reply_status,
    completedEffects: row.completed_effects,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at === null ? null : new Date(row.lease_expires_at),
    attempts: Number(row.attempts),
    lastError: row.last_error,
  };
}

/** Atomic claim; an expired sender becomes uncertain rather than blindly resent. */
export async function claimAgentTurn(input: {
  conversationId: string;
  externalMessageId: string;
  conversationKey: string;
  leaseMs?: number;
}): Promise<AgentTurnClaim> {
  const { tenantId } = requireTenantContext();
  const token = randomUUID();
  const leaseMs = leaseDuration(input.leaseMs);
  return withTenant(async (tx) => {
    const inserted = (await tx.execute(sql`
      INSERT INTO agent_turns (tenant_id, conversation_id, external_message_id, conversation_key,
        lease_token, lease_expires_at, attempts)
      VALUES (${tenantId}, ${input.conversationId}, ${input.externalMessageId}, ${input.conversationKey},
        ${token}, clock_timestamp() + (${leaseMs} * interval '1 millisecond'), 1)
      ON CONFLICT (tenant_id, conversation_id, external_message_id) DO NOTHING
      RETURNING *
    `)) as unknown as StoredTurn[];
    if (inserted[0]) return { state: "owned", turn: mapTurn(inserted[0]), token };

    const claimed = (await tx.execute(sql`
      UPDATE agent_turns SET lease_token = ${token},
        lease_expires_at = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
        reply_status = CASE WHEN reply_status = 'sending' THEN 'uncertain' ELSE reply_status END,
        attempts = attempts + 1, updated_at = clock_timestamp(), last_error = NULL
      WHERE tenant_id = ${tenantId} AND conversation_id = ${input.conversationId}
        AND external_message_id = ${input.externalMessageId} AND status <> 'complete'
        AND (lease_token IS NULL OR lease_expires_at <= clock_timestamp())
      RETURNING *
    `)) as unknown as StoredTurn[];
    if (claimed[0]) return { state: "owned", turn: mapTurn(claimed[0]), token };

    const existing = (await tx.execute(sql`
      SELECT * FROM agent_turns WHERE tenant_id = ${tenantId}
        AND conversation_id = ${input.conversationId} AND external_message_id = ${input.externalMessageId}
    `)) as unknown as StoredTurn[];
    if (!existing[0]) throw new Error("agent_turn_claim_missing");
    const turn = mapTurn(existing[0]);
    return { state: turn.status === "complete" ? "complete" : "busy", turn };
  });
}

/** Save the immutable plan and its lead decision in one transaction. */
export async function saveAgentTurnPlan(id: string, token: string, plan: AgentTurnPlan): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const saved = (await tx.execute(sql`
      UPDATE agent_turns SET plan = ${JSON.stringify(plan)}::jsonb, status = 'ready', updated_at = clock_timestamp()
      WHERE tenant_id = ${tenantId} AND id = ${id} AND lease_token = ${token}
        AND lease_expires_at > clock_timestamp() AND status = 'planning' AND plan IS NULL
      RETURNING conversation_id
    `)) as unknown as Array<{ conversation_id: string }>;
    if (!saved[0]) return false;
    if (plan.decision) {
      const d = plan.decision;
      const updated = (await tx.execute(sql`
        UPDATE lead_profiles SET
          stage = CASE WHEN ${d.stage !== undefined} THEN ${d.stage ?? null} ELSE stage END,
          status = CASE WHEN ${d.status !== undefined} THEN ${d.status ?? null} ELSE status END,
          score = CASE WHEN ${d.score !== undefined} THEN ${d.score ?? null} ELSE score END,
          updated_at = clock_timestamp()
        WHERE tenant_id = ${tenantId} AND conversation_id = ${saved[0].conversation_id}
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      // Without a profile the decision cannot be applied: roll the plan back too.
      if (!updated[0]) throw new Error("agent_turn_lead_missing");
    }
    return true;
  });
}

export async function renewAgentTurnLease(id: string, token: string, leaseMs?: number): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  const duration = leaseDuration(leaseMs);
  return withTenant(async (tx) => {
    const rows = await tx.execute(sql`
      UPDATE agent_turns SET lease_expires_at = clock_timestamp() + (${duration} * interval '1 millisecond'),
        updated_at = clock_timestamp()
      WHERE tenant_id = ${tenantId} AND id = ${id} AND lease_token = ${token}
        AND lease_expires_at > clock_timestamp() AND status <> 'complete' RETURNING id
    `);
    return rows.length > 0;
  });
}

/** Terminal reply states never reopen. Only a known failed send may return to pending. */
export async function markAgentTurnReply(id: string, token: string, status: AgentTurnReplyStatus): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  const allowed: Record<AgentTurnReplyStatus, string[]> = {
    pending: ["pending", "sending"],
    sending: ["pending", "sending"],
    sent: ["pending", "sending", "sent"],
    suppressed: ["pending", "sending", "suppressed"],
    uncertain: ["sending", "uncertain"],
  };
  if (!allowed[status]) throw new Error("invalid_agent_turn_reply_status");
  return withTenant(async (tx) => {
    const rows = await tx.execute(sql`
      UPDATE agent_turns SET reply_status = ${status}, updated_at = clock_timestamp()
      WHERE tenant_id = ${tenantId} AND id = ${id} AND lease_token = ${token}
        AND lease_expires_at > clock_timestamp() AND status = 'ready'
        AND reply_status IN (${sql.join(allowed[status].map((s) => sql`${s}`), sql`, `)}) RETURNING id
    `);
    return rows.length > 0;
  });
}

/** Record stable effect names; replay skips effects already durably completed. */
export async function completeAgentTurnEffect(id: string, token: string, effectKey: string): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  if (!/^[a-z0-9_.:-]{1,100}$/i.test(effectKey)) throw new Error("invalid_agent_turn_effect_key");
  return withTenant(async (tx) => {
    const rows = await tx.execute(sql`
      UPDATE agent_turns SET completed_effects = CASE
        WHEN completed_effects ? ${effectKey} THEN completed_effects
        ELSE completed_effects || ${JSON.stringify([effectKey])}::jsonb END,
        updated_at = clock_timestamp()
      WHERE tenant_id = ${tenantId} AND id = ${id} AND lease_token = ${token}
        AND lease_expires_at > clock_timestamp() AND status = 'ready' RETURNING id
    `);
    return rows.length > 0;
  });
}

export async function finishAgentTurn(id: string, token: string): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx.execute(sql`
      UPDATE agent_turns SET status = 'complete', lease_token = NULL, lease_expires_at = NULL,
        last_error = CASE WHEN reply_status = 'uncertain' THEN 'reply_delivery_uncertain' ELSE NULL END,
        updated_at = clock_timestamp()
      WHERE tenant_id = ${tenantId} AND id = ${id} AND lease_token = ${token}
        AND lease_expires_at > clock_timestamp() AND status = 'ready'
        AND reply_status IN ('sent', 'suppressed', 'uncertain') RETURNING id
    `);
    return rows.length > 0;
  });
}

export async function releaseAgentTurnLease(id: string, token: string, errorCode?: string): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  // Error codes only. Do not persist exceptions, transport URLs or payloads.
  const code = errorCode === undefined ? null : /^[a-z0-9_.:-]{1,80}$/i.test(errorCode) ? errorCode : "turn_failed";
  return withTenant(async (tx) => {
    const rows = await tx.execute(sql`
      UPDATE agent_turns SET lease_token = NULL, lease_expires_at = NULL, last_error = ${code},
        updated_at = clock_timestamp()
      WHERE tenant_id = ${tenantId} AND id = ${id} AND lease_token = ${token}
        AND lease_expires_at > clock_timestamp() AND status <> 'complete' RETURNING id
    `);
    return rows.length > 0;
  });
}

export async function listRecoverableAgentTurns(conversationId: string, limit = 50): Promise<AgentTurnRow[]> {
  const { tenantId } = requireTenantContext();
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM agent_turns WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}
        AND status = 'ready' ORDER BY created_at ASC, id ASC LIMIT ${count}
    `)) as unknown as StoredTurn[];
    return rows.map(mapTurn);
  });
}

export async function getAgentTurn(conversationId: string, externalMessageId: string): Promise<AgentTurnRow | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM agent_turns WHERE tenant_id = ${tenantId}
        AND conversation_id = ${conversationId} AND external_message_id = ${externalMessageId}
    `)) as unknown as StoredTurn[];
    return rows[0] ? mapTurn(rows[0]) : null;
  });
}

export interface AgentTurnRecoveryFilter {
  provider?: "cloud_api" | "baileys";
  channelAccountId?: string;
}

/**
 * Oldest ready turn per conversation, then retry fairness across conversations.
 * A leased predecessor blocks its successors. Claims/releases move failed turns
 * to the back, so permanently failed conversations cannot starve other leads.
 * Transport filters exclude malformed/inactive routes before applying the limit.
 */
export async function listPendingAgentTurns(limit = 50, filter?: AgentTurnRecoveryFilter): Promise<AgentTurnRow[]> {
  const { tenantId } = requireTenantContext();
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
  if (filter?.provider !== undefined && !["cloud_api", "baileys"].includes(filter.provider)) {
    throw new Error("invalid_agent_turn_provider");
  }
  const hasRouteFilter = filter?.provider !== undefined || filter?.channelAccountId !== undefined;
  const provider = filter?.provider === undefined
    ? sql`true`
    : sql`split_part(candidate.conversation_key, ':', 1) = ${filter.provider}`;
  const account = filter?.channelAccountId === undefined
    ? sql`true`
    : sql`split_part(candidate.conversation_key, ':', 2) = ${filter.channelAccountId}`;
  const validActiveRoute = !hasRouteFilter ? sql`true` : sql`
    cardinality(string_to_array(candidate.conversation_key, ':')) = 3
    AND length(split_part(candidate.conversation_key, ':', 1)) > 0
    AND length(split_part(candidate.conversation_key, ':', 2)) > 0
    AND jsonb_typeof(candidate.plan->'source') = 'object'
    AND jsonb_typeof(candidate.plan#>'{source,from}') = 'string'
    AND length(candidate.plan#>>'{source,from}') > 0
    AND candidate.plan#>>'{source,from}' = split_part(candidate.conversation_key, ':', 3)
    AND jsonb_typeof(candidate.plan#>'{source,type}') = 'string'
    AND length(candidate.plan#>>'{source,type}') > 0
    AND coalesce(candidate.plan#>>'{source,provider}', split_part(candidate.conversation_key, ':', 1))
      = split_part(candidate.conversation_key, ':', 1)
    AND coalesce(candidate.plan#>>'{source,channelAccountId}', split_part(candidate.conversation_key, ':', 2))
      = split_part(candidate.conversation_key, ':', 2)
    AND EXISTS (
      SELECT 1 FROM channel_connections connection
      WHERE connection.tenant_id = ${tenantId} AND connection.status = 'active'
        AND connection.provider = split_part(candidate.conversation_key, ':', 1)
        AND connection.phone_number_id = split_part(candidate.conversation_key, ':', 2)
    )`;
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      WITH first_pending AS (
        SELECT DISTINCT ON (conversation_id) * FROM agent_turns
        WHERE tenant_id = ${tenantId} AND status = 'ready'
        ORDER BY conversation_id, created_at ASC, id ASC
      )
      SELECT candidate.* FROM first_pending candidate
      WHERE (candidate.lease_token IS NULL OR candidate.lease_expires_at <= clock_timestamp())
        AND ${provider} AND ${account} AND ${validActiveRoute}
      ORDER BY candidate.updated_at ASC, candidate.created_at ASC, candidate.id ASC LIMIT ${count}
    `)) as unknown as StoredTurn[];
    return rows.map(mapTurn);
  });
}

/**
 * Explicit system scan: only active tenant ids leave this helper. Replay reads
 * the plans separately withTenant; the scan flag is local to this transaction.
 */
export async function listTenantIdsWithPendingAgentTurns(): Promise<string[]> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_scan', 'on', true)`);
    const rows = (await tx.execute(sql`
      SELECT DISTINCT turn.tenant_id AS "tenantId" FROM agent_turns turn
      JOIN tenants tenant ON tenant.id = turn.tenant_id AND tenant.status = 'active'
      WHERE turn.status = 'ready'
        AND (turn.lease_token IS NULL OR turn.lease_expires_at <= clock_timestamp())
    `)) as unknown as Array<{ tenantId: string }>;
    return rows.map((row) => row.tenantId);
  });
}

/** Tenant-visible incidents for operator reconciliation; these must never resend automatically. */
export async function listUncertainAgentTurns(limit = 50): Promise<AgentTurnRow[]> {
  const { tenantId } = requireTenantContext();
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM agent_turns WHERE tenant_id = ${tenantId} AND reply_status = 'uncertain'
      ORDER BY created_at ASC, id ASC LIMIT ${count}
    `)) as unknown as StoredTurn[];
    return rows.map(mapTurn);
  });
}
