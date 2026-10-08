import { and, eq, lte, or, sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import {
  getActiveConnectionForTenant,
  getConnectionForConversation,
} from "./channel-connections";
import { getDb, withTenant } from "./client";
import { messages, outboxMessages } from "./schema";

export type OutboxKind = "template" | "free_form";
export type OutboxBilling = "template" | "service";

export interface EnqueueOutboxInput {
  conversationId?: string;
  /** Conexão de SAÍDA explícita; se ausente, deriva da conversa → tenant. */
  connectionId?: string;
  toPhone: string;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  clientMessageId: string;
  billing: OutboxBilling;
  scheduledFor?: Date;
  maxAttempts?: number;
}

/**
 * Enfileira uma mensagem de saída como `pending`. A unique `(tenant, idempotency_key)`
 * REIVINDICA o envio — re-enfileirar a mesma chave NÃO cria duplicata.
 * Multi-conexão (migration 0030): a linha nasce com a conexão da CONVERSA
 * (derivada da conversation_key); sem vínculo, registra a conexão ativa do
 * tenant NO MOMENTO do enqueue; sem nenhuma, fica NULL (fallback no envio).
 */
export async function enqueueOutbox(
  input: EnqueueOutboxInput,
): Promise<{ outboxId: string; created: boolean }> {
  // Namespaces reservados: 'reactive:' pertence ao ledger do reply do agente e
  // 'human:' ao envio manual do painel (recordSentOutbox). Uma colisão aqui
  // esconderia a perda do ledger via onConflictDoNothing (revisão Codex).
  if (/^(reactive|human):/.test(input.idempotencyKey)) {
    throw new Error("idempotencyKey com prefixo reservado 'reactive:'/'human:' (uso exclusivo do ledger de envios já realizados).");
  }
  const { tenantId } = requireTenantContext();
  // Roteamento: conexão explícita > conexão da conversa > conexão ativa do tenant.
  let connectionId = input.connectionId ?? null;
  if (!connectionId && input.conversationId) {
    connectionId = (await getConnectionForConversation(input.conversationId))?.connectionId ?? null;
  }
  if (!connectionId) {
    connectionId = (await getActiveConnectionForTenant())?.connectionId ?? null;
  }
  return withTenant(async (tx) => {
    const inserted = await tx
      .insert(outboxMessages)
      .values({
        tenantId,
        conversationId: input.conversationId ?? null,
        connectionId,
        toPhone: input.toPhone,
        kind: input.kind,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        clientMessageId: input.clientMessageId,
        billing: input.billing,
        scheduledFor: input.scheduledFor ?? new Date(),
        maxAttempts: input.maxAttempts ?? 5,
      })
      .onConflictDoNothing({ target: [outboxMessages.tenantId, outboxMessages.idempotencyKey] })
      .returning({ id: outboxMessages.id });
    if (inserted[0]) return { outboxId: inserted[0].id, created: true };
    const existing = await tx
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.tenantId, tenantId),
          eq(outboxMessages.idempotencyKey, input.idempotencyKey),
        ),
      );
    return { outboxId: existing[0]!.id, created: false };
  });
}

/** Conexão da LINHA do outbox (join no claim) — roteia o envio multi-conexão. */
export interface ClaimedConnection {
  connectionId: string;
  phoneNumberId: string;
  secretRef: string;
  provider: string;
  status: string;
}

export interface ClaimedOutbox {
  id: string;
  conversationId: string | null;
  toPhone: string;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  clientMessageId: string;
  billing: OutboxBilling;
  attempts: number;
  maxAttempts: number;
  /** Conexão explícita da linha (0030); null = rotear pelo fallback do tenant. */
  connection: ClaimedConnection | null;
}

/**
 * Partição do claim por PROVEDOR, linha a linha (multi-conexão): o scheduler só
 * reivindica linhas Cloud; o session-worker só linhas Baileys cujos sockets são
 * DELE. Sem starvation quando o tenant tem os dois provedores.
 */
export interface ClaimRouting {
  /** Provedor que ESTE processo sabe enviar ('cloud_api' | 'baileys'). */
  provider: string;
  /** Baileys: restringe às conexões cujo socket vive NESTE worker. */
  phoneNumberIds?: string[];
  /** Reivindicar também linhas SEM connection_id (fallback por tenant)? */
  includeUnrouted: boolean;
}

function routingCondition(routing: ClaimRouting) {
  const routed =
    routing.phoneNumberIds !== undefined
      ? routing.phoneNumberIds.length > 0
        ? sql`(cc.provider = ${routing.provider} AND cc.phone_number_id IN (${sql.join(
            routing.phoneNumberIds.map((p) => sql`${p}`),
            sql`, `,
          )}))`
        : sql`false`
      : sql`cc.provider = ${routing.provider}`;
  return routing.includeUnrouted
    ? sql`(o.connection_id IS NULL OR ${routed})`
    : sql`(o.connection_id IS NOT NULL AND ${routed})`;
}

/**
 * Reivindica atomicamente linhas a enviar → `sending` (FOR UPDATE SKIP LOCKED:
 * vários workers não pegam a mesma). Pega `pending` vencidas E linhas `sending`
 * ÓRFÃS (worker morreu no meio): `updated_at` mais velho que `staleSendingMs`.
 * É AT-LEAST-ONCE: reenviar uma órfã PODE duplicar (a Cloud API não deduplica por
 * client_message_id); o lease longo minimiza a janela. Com `routing`, o claim é
 * PARTICIONADO pela conexão da linha (sem routing = comportamento clássico).
 */
export async function claimDueOutbox(
  limit: number,
  staleSendingMs = 300_000, // 5min: lease longo minimiza reenvio de órfã (at-least-once)
  routing?: ClaimRouting,
): Promise<ClaimedOutbox[]> {
  const staleSec = Math.max(0, Math.floor(staleSendingMs / 1000));
  const partition = routing ? routingCondition(routing) : sql`true`;
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      UPDATE outbox_messages SET status = 'sending', attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT o.id FROM outbox_messages o
        LEFT JOIN channel_connections cc ON cc.id = o.connection_id
        WHERE (
            (o.status = 'pending' AND o.scheduled_for <= now()
              AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now()))
            OR (o.status = 'sending' AND o.updated_at <= now() - (${staleSec} * interval '1 second'))
          )
          AND o.attempts < o.max_attempts
          AND ${partition}
        ORDER BY o.scheduled_for ASC
        LIMIT ${Math.max(1, Math.floor(limit))}
        FOR UPDATE OF o SKIP LOCKED
      )
      RETURNING id, conversation_id, connection_id, to_phone, kind, payload, client_message_id, billing, attempts, max_attempts
    `)) as unknown as Array<{
      id: string;
      conversation_id: string | null;
      connection_id: string | null;
      to_phone: string;
      kind: OutboxKind;
      payload: Record<string, unknown>;
      client_message_id: string;
      billing: OutboxBilling;
      attempts: number;
      max_attempts: number;
    }>;
    // Resolve as conexões das linhas reivindicadas (RETURNING não faz join).
    const connIds = [...new Set(rows.map((r) => r.connection_id).filter((c): c is string => !!c))];
    const connById = new Map<string, ClaimedConnection>();
    if (connIds.length > 0) {
      const conns = (await tx.execute(sql`
        SELECT id AS "connectionId", phone_number_id AS "phoneNumberId",
               secret_ref AS "secretRef", provider, status
        FROM channel_connections
        WHERE id IN (${sql.join(connIds.map((c) => sql`${c}`), sql`, `)})
      `)) as unknown as ClaimedConnection[];
      for (const c of conns) connById.set(c.connectionId, c);
    }
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      toPhone: r.to_phone,
      kind: r.kind,
      payload: r.payload,
      clientMessageId: r.client_message_id,
      billing: r.billing,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      connection: (r.connection_id && connById.get(r.connection_id)) || null,
    }));
  });
}

/** Cancela uma linha (terminal, sem retry) — guardrail falhou no envio. */
export async function markOutboxCanceled(id: string, reason: string): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .update(outboxMessages)
      .set({ status: "canceled", lastError: reason.slice(0, 200), updatedAt: new Date() })
      .where(and(eq(outboxMessages.tenantId, tenantId), eq(outboxMessages.id, id)));
  });
}

/**
 * Cancela TODAS as pendências (pending/sending) de uma conversa — usado no
 * opt-out e no stop-on-engagement para que nada proativo enfileirado ainda saia.
 */
export async function cancelPendingOutbox(conversationId: string, reason: string): Promise<number> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .update(outboxMessages)
      .set({ status: "canceled", lastError: reason.slice(0, 200), updatedAt: new Date() })
      .where(
        and(
          eq(outboxMessages.tenantId, tenantId),
          eq(outboxMessages.conversationId, conversationId),
          sql`${outboxMessages.status} IN ('pending','sending')`,
        ),
      )
      .returning({ id: outboxMessages.id });
    return rows.length;
  });
}

export interface RecordSentOutboxInput {
  conversationId?: string;
  /** Conexão pela qual o envio JÁ saiu (rastreabilidade multi-conexão). */
  connectionId?: string;
  toPhone: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  externalMessageId: string;
  billing: OutboxBilling;
  /** 'reactive' (reply do agente, default) | 'human' (envio manual do painel). */
  origin?: "reactive" | "human";
}

/**
 * Registra no livro-razão um envio que JÁ aconteceu (REATIVO do agente ou MANUAL
 * do painel): a linha nasce `sent` (com o id externo), nunca `pending` — assim o
 * scheduler/resgate de órfãs jamais a reivindica e o AT-MOST-ONCE desses caminhos
 * é preservado (no reativo, o claim continua sendo o agent_response_claims, ANTES
 * do envio). Com o external_message_id gravado, a reconciliação de status
 * (delivered/read) passa a valer também para essas linhas. Idempotente por
 * idempotency_key.
 */
export async function recordSentOutbox(input: RecordSentOutboxInput): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .insert(outboxMessages)
      .values({
        tenantId,
        conversationId: input.conversationId ?? null,
        connectionId: input.connectionId ?? null,
        toPhone: input.toPhone,
        kind: "free_form",
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        clientMessageId: input.idempotencyKey,
        billing: input.billing,
        origin: input.origin ?? "reactive",
        status: "sent",
        externalMessageId: input.externalMessageId,
        attempts: 1,
      })
      .onConflictDoNothing({ target: [outboxMessages.tenantId, outboxMessages.idempotencyKey] });
  });
  // CATCH-UP de corrida (revisão Codex): o receipt delivered/read/failed pode ter
  // chegado ENTRE o envio e este insert — o reconcile do webhook não achou a linha
  // e o status ficaria stale em 'sent'. O status já está em `messages` (o webhook
  // grava lá primeiro); se avançou além de 'sent', aplica na linha recém-criada.
  // reconcileOutboxStatus é monotônico → corrida dupla não regride nada.
  const caught = await withTenant(async (tx) =>
    tx
      .select({ status: messages.status })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.externalMessageId, input.externalMessageId)))
      .limit(1),
  );
  const st = caught[0]?.status;
  if (st === "delivered" || st === "read" || st === "failed") {
    await reconcileOutboxStatus(input.externalMessageId, st);
  }
}

/** Resultado do claim idempotente do envio MANUAL (painel). */
export type HumanOutboxClaim =
  | { state: "claimed"; outboxId: string }
  | { state: "already_sent"; outboxId: string; externalMessageId: string | null; createdAt: Date }
  | { state: "in_flight" };

/**
 * Claim idempotente do envio manual (achado Codex): a linha entra no livro-razão
 * ANTES do provedor, em `sending`, com a idempotency_key vinda do CLIENTE — um
 * retry do painel (falha de rede pós-envio, duplo clique) NÃO reenvia:
 * - inseriu agora → `claimed` (pode enviar);
 * - já `sent`/reconciliada → `already_sent` (devolve o envio original);
 * - `failed` ou `sending` estagnado (>2min; os adaptadores têm timeout de 20s) →
 *   re-claim atômico e `claimed` (retry legítimo);
 * - `sending` fresco → `in_flight` (requisição concorrente — não duplica).
 */
export async function claimHumanOutbox(input: {
  conversationId: string;
  connectionId?: string;
  toPhone: string;
  text: string;
  idempotencyKey: string;
}): Promise<HumanOutboxClaim> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const inserted = await tx
      .insert(outboxMessages)
      .values({
        tenantId,
        conversationId: input.conversationId,
        connectionId: input.connectionId ?? null,
        toPhone: input.toPhone,
        kind: "free_form",
        payload: { text: input.text },
        idempotencyKey: input.idempotencyKey,
        clientMessageId: input.idempotencyKey,
        billing: "service",
        origin: "human",
        status: "sending",
        attempts: 1,
        maxAttempts: 1,
      })
      .onConflictDoNothing({ target: [outboxMessages.tenantId, outboxMessages.idempotencyKey] })
      .returning({ id: outboxMessages.id });
    if (inserted.length > 0) return { state: "claimed", outboxId: inserted[0]!.id };

    const [existing] = await tx
      .select({
        id: outboxMessages.id,
        status: outboxMessages.status,
        externalMessageId: outboxMessages.externalMessageId,
        createdAt: outboxMessages.createdAt,
        updatedAt: outboxMessages.updatedAt,
      })
      .from(outboxMessages)
      .where(
        and(eq(outboxMessages.tenantId, tenantId), eq(outboxMessages.idempotencyKey, input.idempotencyKey)),
      )
      .limit(1);
    if (!existing) return { state: "in_flight" }; // corrida rara: outro request acabou de claimar
    if (existing.status === "sent" || existing.status === "delivered" || existing.status === "read") {
      return {
        state: "already_sent",
        outboxId: existing.id,
        externalMessageId: existing.externalMessageId,
        createdAt: existing.createdAt,
      };
    }
    const staleBefore = new Date(Date.now() - 120_000);
    const reclaimed = await tx
      .update(outboxMessages)
      .set({ status: "sending", lastError: null, updatedAt: new Date() })
      .where(
        and(
          eq(outboxMessages.tenantId, tenantId),
          eq(outboxMessages.id, existing.id),
          or(
            eq(outboxMessages.status, "failed"),
            and(eq(outboxMessages.status, "sending"), lte(outboxMessages.updatedAt, staleBefore)),
          ),
        ),
      )
      .returning({ id: outboxMessages.id });
    if (reclaimed.length > 0) return { state: "claimed", outboxId: existing.id };
    return { state: "in_flight" };
  });
}

/** Sucesso: grava o id externo e marca 'sent'. */
export async function markOutboxSent(id: string, externalMessageId: string): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .update(outboxMessages)
      .set({ status: "sent", externalMessageId, lastError: null, updatedAt: new Date() })
      .where(and(eq(outboxMessages.tenantId, tenantId), eq(outboxMessages.id, id)));
  });
}

/**
 * Falha: re-agenda (`pending` + backoff) se ainda há tentativas; senão `failed`.
 * `attempts` já foi incrementado no claim.
 */
export async function markOutboxFailed(
  id: string,
  error: string,
  attempts: number,
  maxAttempts: number,
  backoffMs: number,
): Promise<void> {
  const { tenantId } = requireTenantContext();
  const willRetry = attempts < maxAttempts;
  await withTenant(async (tx) => {
    await tx
      .update(outboxMessages)
      .set({
        status: willRetry ? "pending" : "failed",
        lastError: error.slice(0, 500),
        nextAttemptAt: willRetry ? new Date(Date.now() + backoffMs) : null,
        updatedAt: new Date(),
      })
      .where(and(eq(outboxMessages.tenantId, tenantId), eq(outboxMessages.id, id)));
  });
}

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
  canceled: 6,
};
const FINAL_POSITIVE = new Set(["delivered", "read"]);

/**
 * Reconciliação: o status de entrega (delivered/read/failed) do webhook avança a
 * linha do outbox por external_message_id. MONOTÔNICO (não regride). Roda no
 * caminho de status da pipeline (contexto do tenant).
 */
export async function reconcileOutboxStatus(
  externalMessageId: string,
  status: "delivered" | "read" | "failed",
): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ id: outboxMessages.id, status: outboxMessages.status })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.tenantId, tenantId),
          eq(outboxMessages.externalMessageId, externalMessageId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return false;
    if (row.status === "canceled") return false; // terminal
    // `failed` atrasado NÃO rebaixa uma mensagem já entregue/lida.
    if (status === "failed" && FINAL_POSITIVE.has(row.status)) return false;
    if ((STATUS_RANK[status] ?? 0) <= (STATUS_RANK[row.status] ?? 0)) return false;
    await tx
      .update(outboxMessages)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(outboxMessages.tenantId, tenantId), eq(outboxMessages.id, row.id)));
    return true;
  });
}

/**
 * SWEEP de órfãs terminais: linha presa em `sending` com `attempts >= max_attempts`
 * nunca mais é reivindicada pelo claim (que exige attempts < max) nem aparece no
 * alerta (que conta só `failed`) — invisível para sempre. Transiciona para
 * `failed` após `staleSendingMs` sem update (worker morreu no meio do último
 * attempt), entrando no radar do alerta outbox_failed. Retorna quantas varreu.
 */
export async function sweepStuckOutbox(staleSendingMs = 300_000): Promise<number> {
  const { tenantId } = requireTenantContext();
  const staleSec = Math.max(0, Math.floor(staleSendingMs / 1000));
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      UPDATE outbox_messages
      SET status = 'failed',
          last_error = coalesce(last_error, 'sending estagnado com tentativas esgotadas (worker morreu?)'),
          updated_at = now()
      WHERE tenant_id = ${tenantId}
        AND status = 'sending'
        AND attempts >= max_attempts
        AND updated_at <= now() - (${staleSec} * interval '1 second')
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows.length;
  });
}

/**
 * Tenants com trabalho de outbox (caminho SYSTEM, cross-tenant, read-only via
 * policy `system_scan`): `pending` vencido OU `sending` estagnado (órfã a
 * resgatar/varrer). Evita o N+1 do scheduler — só os tenants retornados aqui
 * entram no processDue/sweep do tick.
 */
export async function listTenantsWithDueOutbox(staleSendingMs = 300_000): Promise<string[]> {
  const staleSec = Math.max(0, Math.floor(staleSendingMs / 1000));
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_scan', 'on', true)`);
    const rows = (await tx.execute(sql`
      SELECT DISTINCT o.tenant_id AS "tenantId"
      FROM outbox_messages o
      JOIN tenants t ON t.id = o.tenant_id AND t.status = 'active'
      WHERE (o.status = 'pending' AND o.scheduled_for <= now()
              AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now()))
         OR (o.status = 'sending' AND o.updated_at <= now() - (${staleSec} * interval '1 second'))
    `)) as unknown as Array<{ tenantId: string }>;
    return rows.map((r) => r.tenantId);
  });
}

/** Conta itens do outbox em `failed` do tenant ativo — sinal de alerta (M11). */
export async function countOutboxFailed(): Promise<number> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT count(*)::int AS n FROM outbox_messages
      WHERE tenant_id = ${tenantId} AND status = 'failed' AND origin = 'proactive'`);
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  });
}

/**
 * Conta envios proativos a um telefone desde `since` — teto de frequência.
 * Inclui `pending`/`sending` (ainda não enviados mas JÁ contam para a quota),
 * senão várias cadências enfileirariam antes do worker rodar.
 */
export async function countOutboxSentSince(toPhone: string, since: Date): Promise<number> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT count(*)::int AS n FROM outbox_messages
      WHERE tenant_id = ${tenantId} AND to_phone = ${toPhone}
        AND origin = 'proactive' -- reativas NÃO consomem a quota da cadência (revisão Codex)
        AND status IN ('pending','sending','sent','delivered','read')
        AND created_at >= ${since.toISOString()}
    `);
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  });
}
