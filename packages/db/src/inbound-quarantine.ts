import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { channelConnections, inboundQuarantine } from "./schema";

/**
 * Quarentena de inbound (0032): guarda o payload do webhook cujo destino é uma
 * conexão NÃO-ativa (disconnected/connecting) em vez de descartar a mensagem do
 * lead. O payload é o job da WebhookQueue ({headers, query, rawBody}) — replay
 * fiel pela própria pipeline (assinatura re-verifica; dedup protege duplicatas).
 */

/** Retenção default: ~48h. Depois disso a linha expira (sweep apaga). */
export const QUARANTINE_TTL_MS = 48 * 60 * 60 * 1000;

export interface QuarantineInboundInput {
  /** Tenant DONO da conexão (o pipeline roda no caminho system nesse ponto). */
  tenantId: string;
  phoneNumberId: string;
  /** Job da WebhookQueue: { headers, query, rawBody }. */
  payload: Record<string, unknown>;
  expiresAt?: Date;
}

/** Insere o payload em quarentena (chamado no ponto de descarte do pipeline). */
export async function quarantineInbound(input: QuarantineInboundInput): Promise<string> {
  return withTenant(
    async (tx) => {
      const rows = await tx
        .insert(inboundQuarantine)
        .values({
          tenantId: input.tenantId,
          phoneNumberId: input.phoneNumberId,
          payload: input.payload,
          expiresAt: input.expiresAt ?? new Date(Date.now() + QUARANTINE_TTL_MS),
        })
        .returning({ id: inboundQuarantine.id });
      return rows[0]!.id;
    },
    { tenantId: input.tenantId },
  );
}

export interface ReplayableQuarantine {
  id: string;
  phoneNumberId: string;
  payload: Record<string, unknown>;
}

/**
 * Linhas pendentes do tenant ATIVO cuja conexão VOLTOU a `active`, em ordem de
 * chegada (o replay preserva a ordem por conversa via FIFO do pipeline).
 */
export async function listReplayableQuarantine(
  limit = 100,
  now = new Date(),
): Promise<ReplayableQuarantine[]> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    return tx
      .select({
        id: inboundQuarantine.id,
        phoneNumberId: inboundQuarantine.phoneNumberId,
        payload: inboundQuarantine.payload,
      })
      .from(inboundQuarantine)
      .innerJoin(
        channelConnections,
        and(
          eq(channelConnections.tenantId, tenantId),
          eq(channelConnections.phoneNumberId, inboundQuarantine.phoneNumberId),
          eq(channelConnections.status, "active"),
        ),
      )
      .where(
        and(
          eq(inboundQuarantine.tenantId, tenantId),
          isNull(inboundQuarantine.replayedAt),
          gt(inboundQuarantine.expiresAt, now),
        ),
      )
      .orderBy(asc(inboundQuarantine.receivedAt), asc(inboundQuarantine.id))
      .limit(limit) as Promise<ReplayableQuarantine[]>;
  });
}

/** Marca linhas re-enfileiradas (após o enqueue — at-least-once; dedup protege). */
export async function markQuarantineReplayed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withTenant(async (tx) => {
    await tx
      .update(inboundQuarantine)
      .set({ replayedAt: new Date() })
      .where(inArray(inboundQuarantine.id, ids));
  });
}

/** Apaga linhas EXPIRADAS do tenant ativo (pendentes velhas e replays retidos). */
export async function deleteExpiredQuarantine(now = new Date()): Promise<number> {
  return withTenant(async (tx) => {
    const rows = await tx
      .delete(inboundQuarantine)
      .where(lt(inboundQuarantine.expiresAt, now))
      .returning({ id: inboundQuarantine.id });
    return rows.length;
  });
}
