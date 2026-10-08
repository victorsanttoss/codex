import { sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";

/**
 * APIs de LEITURA do CRM (M14) — alimentam o painel (leads, conversas, funil).
 * Tudo tenant-scoped: roda sob `withTenant` (RLS) e filtra por tenant_id
 * explicitamente (belt-and-suspenders). Sem escrita aqui.
 */

export interface LeadRow {
  conversationId: string;
  waId: string;
  name: string | null;
  phone: string | null;
  stage: string;
  status: string;
  score: number;
  summary: string | null;
  lastContactAt: Date | null;
  updatedAt: Date;
}

export interface LeadFilter {
  status?: string;
  stage?: string;
  minScore?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface Paged<T> {
  rows: T[];
  total: number;
}

/** Lista paginada do pipeline (leads), com filtros combináveis. */
export async function listLeads(filter: LeadFilter = {}): Promise<Paged<LeadRow>> {
  const { tenantId } = requireTenantContext();
  const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
  const offset = Math.max(0, filter.offset ?? 0);
  const conds = [sql`lp.tenant_id = ${tenantId}`, sql`cv.sandbox = false`];
  if (filter.status) conds.push(sql`lp.status = ${filter.status}`);
  if (filter.stage) conds.push(sql`lp.stage = ${filter.stage}`);
  if (typeof filter.minScore === "number") conds.push(sql`lp.score >= ${filter.minScore}`);
  if (filter.search) {
    const q = `%${filter.search}%`;
    conds.push(sql`(ct.profile_name ILIKE ${q} OR ct.wa_id ILIKE ${q} OR ct.phone ILIKE ${q})`);
  }
  const where = sql.join(conds, sql` AND `);

  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT lp.conversation_id AS "conversationId", ct.wa_id AS "waId", ct.profile_name AS name,
             ct.phone, lp.stage, lp.status, lp.score, lp.summary,
             COALESCE(cv.last_inbound_at, cv.last_outbound_at, cv.created_at) AS "lastContactAt",
             lp.updated_at AS "updatedAt"
      FROM lead_profiles lp
      JOIN conversations cv ON cv.id = lp.conversation_id
      JOIN contacts ct ON ct.id = cv.contact_id
      WHERE ${where}
      ORDER BY COALESCE(cv.last_inbound_at, cv.last_outbound_at, cv.created_at) DESC
      LIMIT ${limit} OFFSET ${offset}
    `)) as unknown as LeadRow[];
    const totalRows = (await tx.execute(sql`
      SELECT count(*)::int AS total FROM lead_profiles lp
      JOIN conversations cv ON cv.id = lp.conversation_id
      JOIN contacts ct ON ct.id = cv.contact_id
      WHERE ${where}
    `)) as unknown as Array<{ total: number }>;
    return { rows, total: totalRows[0]?.total ?? 0 };
  });
}

/** Contagem por status (funil do dashboard). */
export async function leadFunnel(): Promise<Record<string, number>> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT lp.status, count(*)::int AS n FROM lead_profiles lp
      JOIN conversations cv ON cv.id = lp.conversation_id
      WHERE lp.tenant_id = ${tenantId} AND cv.sandbox = false GROUP BY lp.status
    `)) as unknown as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  });
}

export interface ConversationRow {
  conversationId: string;
  waId: string;
  name: string | null;
  status: string;
  humanTakeover: boolean;
  leadStatus: string | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
}

/** Lista de conversas (todas), com status do lead e flag de takeover. */
export async function listConversations(filter: { handoff?: boolean; qualified?: boolean; limit?: number; offset?: number } = {}): Promise<Paged<ConversationRow>> {
  const { tenantId } = requireTenantContext();
  const limit = Math.min(100, Math.max(1, filter.limit ?? 30));
  const offset = Math.max(0, filter.offset ?? 0);
  const conds = [sql`cv.tenant_id = ${tenantId}`, sql`cv.sandbox = false`];
  if (filter.handoff) conds.push(sql`lp.status = 'handoff'`);
  // `scheduled` (0034) é o qualificado que JÁ marcou horário — mesma aba.
  if (filter.qualified) conds.push(sql`lp.status IN ('qualified', 'scheduled')`);
  const where = sql.join(conds, sql` AND `);
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT cv.id AS "conversationId", ct.wa_id AS "waId", ct.profile_name AS name,
             cv.status, cv.human_takeover AS "humanTakeover", lp.status AS "leadStatus",
             cv.last_inbound_at AS "lastInboundAt", cv.last_outbound_at AS "lastOutboundAt"
      FROM conversations cv
      JOIN contacts ct ON ct.id = cv.contact_id
      LEFT JOIN lead_profiles lp ON lp.conversation_id = cv.id
      WHERE ${where}
      ORDER BY COALESCE(cv.last_inbound_at, cv.last_outbound_at, cv.created_at) DESC
      LIMIT ${limit} OFFSET ${offset}
    `)) as unknown as ConversationRow[];
    const totalRows = (await tx.execute(sql`
      SELECT count(*)::int AS total FROM conversations cv
      JOIN contacts ct ON ct.id = cv.contact_id
      LEFT JOIN lead_profiles lp ON lp.conversation_id = cv.id
      WHERE ${where}
    `)) as unknown as Array<{ total: number }>;
    return { rows, total: totalRows[0]?.total ?? 0 };
  });
}

export interface AppointmentRow {
  id: string;
  whenText: string | null;
  startsAt: Date | null;
  details: string;
  status: string;
  calendarId: string | null;
}

/** Agendamentos de uma conversa (para o detalhe do lead). */
export async function listAppointmentsForConversation(conversationId: string): Promise<AppointmentRow[]> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    return (await tx.execute(sql`
      SELECT id, when_text AS "whenText", starts_at AS "startsAt", details, status,
             calendar_id AS "calendarId"
      FROM appointments WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}
      ORDER BY created_at DESC
    `)) as unknown as AppointmentRow[];
  });
}

/** "Assumir conversa" / devolver à IA — alterna o takeover (tenant-scoped). */
export async function setHumanTakeover(conversationId: string, on: boolean): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const res = (await tx.execute(sql`
      UPDATE conversations SET human_takeover = ${on}, human_takeover_at = ${on ? sql`now()` : sql`NULL`}
      WHERE tenant_id = ${tenantId} AND id = ${conversationId}
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return res.length > 0;
  });
}

/**
 * A conversa é visível no PAINEL? (tenant dono + NÃO-sandbox). Os endpoints de
 * detalhe usam isto para não expor conversas do Playground por UUID conhecido.
 */
export async function isPanelConversation(conversationId: string): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT 1 FROM conversations
      WHERE tenant_id = ${tenantId} AND id = ${conversationId} AND sandbox = false LIMIT 1
    `)) as unknown as Array<unknown>;
    return rows.length > 0;
  });
}

/** Lê o flag de takeover de uma conversa (para o guardrail do handler). */
export async function isHumanTakeover(conversationId: string): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT human_takeover AS "humanTakeover" FROM conversations
      WHERE tenant_id = ${tenantId} AND id = ${conversationId} LIMIT 1
    `)) as unknown as Array<{ humanTakeover: boolean }>;
    return rows[0]?.humanTakeover ?? false;
  });
}
