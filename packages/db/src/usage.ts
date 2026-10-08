import { sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { usageEvents } from "./schema";

/** Evento de uso para metering por tenant (item 9). */
export interface UsageEventInput {
  type: string;
  model?: string;
  channel?: string;
  tokensIn?: number;
  tokensOut?: number;
  costMicros?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Grava um evento de uso no tenant ativo. É o hook genérico que adaptadores
 * de canal/LLM chamam para reportar consumo (alimenta billing/limites).
 */
export async function recordUsage(event: UsageEventInput): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx.insert(usageEvents).values({
      tenantId,
      type: event.type,
      model: event.model ?? null,
      channel: event.channel ?? null,
      tokensIn: event.tokensIn ?? null,
      tokensOut: event.tokensOut ?? null,
      costMicros: event.costMicros ?? null,
      metadata: event.metadata ?? {},
    });
  });
}

export interface UsageAggregate {
  events: number;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
}

/** Agregação de uso do tenant ativo num período [from, to). */
export async function aggregateUsage(from: Date, to: Date): Promise<UsageAggregate> {
  return withTenant(async (tx) => {
    const rows = await tx
      .select({
        events: sql<number>`count(*)::int`,
        tokensIn: sql<number>`coalesce(sum(${usageEvents.tokensIn}), 0)::bigint`,
        tokensOut: sql<number>`coalesce(sum(${usageEvents.tokensOut}), 0)::bigint`,
        costMicros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::bigint`,
      })
      .from(usageEvents)
      .where(
        sql`${usageEvents.occurredAt} >= ${from.toISOString()} and ${usageEvents.occurredAt} < ${to.toISOString()}`,
      );
    const r = rows[0];
    return {
      events: Number(r?.events ?? 0),
      tokensIn: Number(r?.tokensIn ?? 0),
      tokensOut: Number(r?.tokensOut ?? 0),
      costMicros: Number(r?.costMicros ?? 0),
    };
  });
}
