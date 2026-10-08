import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { getDb, withTenant } from "./client";
import {
  contacts,
  conversations,
  imobAgencies,
  imobAssignments,
  imobBrokers,
  imobEvents,
  imobSettings,
  leadProfiles,
} from "./schema";

// ── Vertical imobiliária (0037): distribuição p/ corretores + SLA ────────────

/** Fuso do negócio (capacidade diária e métricas "hoje"). */
const BUSINESS_TZ = "America/Sao_Paulo";

/** Estágios pós-aceite que encerram o atendimento (assignment vira closed). */
export const IMOB_TERMINAL_STAGES = ["contrato", "sem_interesse"] as const;

export function normalizePhoneDigits(v: string): string {
  return v.replace(/\D/g, "");
}

/**
 * Violação de unicidade (23505), opcionalmente de uma constraint específica.
 * O motor usa para distinguir "lead já tem atribuição ativa" de "corretor já
 * tem oferta pendente" (tenta o próximo da fila).
 */
export function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  const candidates = [err, (err as { cause?: unknown })?.cause];
  for (const e of candidates) {
    const pe = e as { code?: string; constraint_name?: string } | undefined;
    if (pe?.code === "23505") {
      return !constraintName || pe.constraint_name === constraintName;
    }
  }
  return false;
}

/**
 * Variantes BR do nono dígito: 55 DD 9XXXXXXXX ↔ 55 DD XXXXXXXX. O WhatsApp
 * ora entrega com, ora sem o 9 — o corretor precisa ser reconhecido nos dois.
 */
export function brPhoneVariants(input: string): string[] {
  const d = normalizePhoneDigits(input);
  const out = new Set([d]);
  if (d.startsWith("55")) {
    const rest = d.slice(4); // depois de 55 + DDD
    const ddd = d.slice(2, 4);
    if (rest.length === 9 && rest.startsWith("9")) out.add(`55${ddd}${rest.slice(1)}`);
    if (rest.length === 8) out.add(`55${ddd}9${rest}`);
  }
  return [...out];
}

// ── Agências ─────────────────────────────────────────────────────────────────

export interface ImobAgencyRow {
  id: string;
  name: string;
  archivedAt: Date | null;
}

export async function listImobAgencies(): Promise<ImobAgencyRow[]> {
  return withTenant(async (tx) =>
    tx
      .select({ id: imobAgencies.id, name: imobAgencies.name, archivedAt: imobAgencies.archivedAt })
      .from(imobAgencies)
      .orderBy(imobAgencies.name),
  );
}

export async function createImobAgency(name: string): Promise<{ agencyId: string }> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const [row] = await tx
      .insert(imobAgencies)
      .values({ tenantId, name })
      .onConflictDoUpdate({
        target: [imobAgencies.tenantId, imobAgencies.name],
        set: { archivedAt: null },
      })
      .returning({ id: imobAgencies.id });
    return { agencyId: row!.id };
  });
}

export async function archiveImobAgency(agencyId: string): Promise<boolean> {
  return withTenant(async (tx) => {
    const rows = await tx
      .update(imobAgencies)
      .set({ archivedAt: new Date() })
      .where(and(eq(imobAgencies.id, agencyId), isNull(imobAgencies.archivedAt)))
      .returning({ id: imobAgencies.id });
    return rows.length > 0;
  });
}

// ── Corretores ───────────────────────────────────────────────────────────────

export interface ImobBrokerRow {
  id: string;
  agencyId: string | null;
  agencyName: string | null;
  name: string;
  whatsapp: string;
  waId: string | null;
  regions: string[];
  dailyCapacity: number;
  active: boolean;
  archivedAt: Date | null;
}

const brokerCols = {
  id: imobBrokers.id,
  agencyId: imobBrokers.agencyId,
  agencyName: imobAgencies.name,
  name: imobBrokers.name,
  whatsapp: imobBrokers.whatsapp,
  waId: imobBrokers.waId,
  regions: imobBrokers.regions,
  dailyCapacity: imobBrokers.dailyCapacity,
  active: imobBrokers.active,
  archivedAt: imobBrokers.archivedAt,
};

export async function listImobBrokers(opts?: { includeArchived?: boolean }): Promise<ImobBrokerRow[]> {
  return withTenant(async (tx) => {
    const base = tx
      .select(brokerCols)
      .from(imobBrokers)
      .leftJoin(imobAgencies, eq(imobAgencies.id, imobBrokers.agencyId))
      .orderBy(imobBrokers.name);
    if (opts?.includeArchived) return base;
    return base.where(isNull(imobBrokers.archivedAt));
  });
}

export interface CreateImobBrokerInput {
  name: string;
  whatsapp: string;
  agencyId?: string | null;
  waId?: string | null;
  regions?: string[];
  dailyCapacity?: number;
}

export async function createImobBroker(input: CreateImobBrokerInput): Promise<{ brokerId: string }> {
  const { tenantId } = requireTenantContext();
  const whatsapp = normalizePhoneDigits(input.whatsapp);
  if (whatsapp.length < 10) throw new Error("WhatsApp do corretor inválido (mínimo 10 dígitos).");
  return withTenant(async (tx) => {
    const [row] = await tx
      .insert(imobBrokers)
      .values({
        tenantId,
        name: input.name,
        whatsapp,
        agencyId: input.agencyId ?? null,
        // mesmo formato do update: dígitos (é assim que o inbound compara)
        waId: input.waId ? normalizePhoneDigits(input.waId) : null,
        regions: input.regions ?? [],
        dailyCapacity: input.dailyCapacity ?? 10,
      })
      .returning({ id: imobBrokers.id });
    return { brokerId: row!.id };
  });
}

export interface UpdateImobBrokerInput {
  name?: string;
  whatsapp?: string;
  agencyId?: string | null;
  waId?: string | null;
  regions?: string[];
  dailyCapacity?: number;
  active?: boolean;
  /** true arquiva (sai da distribuição); false desarquiva. */
  archived?: boolean;
}

export async function updateImobBroker(brokerId: string, patch: UpdateImobBrokerInput): Promise<boolean> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.whatsapp !== undefined) {
    const digits = normalizePhoneDigits(patch.whatsapp);
    // mesma régua do create: telefone curto quebraria a identificação inbound
    if (digits.length < 10) throw new Error("WhatsApp do corretor inválido (mínimo 10 dígitos).");
    set.whatsapp = digits;
  }
  if (patch.dailyCapacity !== undefined && (!Number.isFinite(patch.dailyCapacity) || patch.dailyCapacity < 1)) {
    throw new Error("Capacidade diária inválida (mínimo 1).");
  }
  if (patch.agencyId !== undefined) set.agencyId = patch.agencyId;
  // LID/wa_id normalizado p/ dígitos (é assim que o inbound compara)
  if (patch.waId !== undefined) set.waId = patch.waId ? normalizePhoneDigits(patch.waId) : null;
  if (patch.regions !== undefined) set.regions = patch.regions;
  if (patch.dailyCapacity !== undefined) set.dailyCapacity = patch.dailyCapacity;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.archived !== undefined) set.archivedAt = patch.archived ? new Date() : null;
  return withTenant(async (tx) => {
    const rows = await tx
      .update(imobBrokers)
      .set(set)
      .where(eq(imobBrokers.id, brokerId))
      .returning({ id: imobBrokers.id });
    return rows.length > 0;
  });
}

/**
 * Identifica um corretor pelo remetente do inbound (dígitos do telefone em
 * qualquer variante do nono dígito, OU wa_id/LID do Baileys). Só corretores
 * NÃO arquivados contam — arquivado volta a ser tratado como lead comum.
 */
export async function findImobBrokerByWa(from: string): Promise<ImobBrokerRow | null> {
  const variants = brPhoneVariants(from);
  // wa_id é armazenado normalizado (dígitos) — compara no mesmo formato
  const fromDigits = normalizePhoneDigits(from);
  return withTenant(async (tx) => {
    const rows = await tx
      .select(brokerCols)
      .from(imobBrokers)
      .leftJoin(imobAgencies, eq(imobAgencies.id, imobBrokers.agencyId))
      .where(
        and(
          isNull(imobBrokers.archivedAt),
          sql`(${imobBrokers.whatsapp} IN ${variants} OR ${imobBrokers.waId} = ${fromDigits})`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Candidatos elegíveis à distribuição com carga do dia e última oferta (para o
 * round-robin). Elegível = ativo, não arquivado, agência (se houver) não
 * arquivada. Filtro de região e capacidade são aplicados pelo caller (JS) —
 * volume por tenant é pequeno e a regra fica testável.
 */
export interface ImobBrokerCandidate extends ImobBrokerRow {
  offeredToday: number;
  lastOfferedAt: Date | null;
  /** Ofertas aguardando aceite deste corretor (índice 0038 permite no máx. 1). */
  pendingAccept: number;
}

export async function listImobBrokerCandidates(): Promise<ImobBrokerCandidate[]> {
  return withTenant(async (tx) => {
    const rows = await tx
      .select({
        ...brokerCols,
        offeredToday: sql<number>`(
          SELECT count(*)::int FROM imob_assignments s
          WHERE s.broker_id = ${imobBrokers.id}
            AND (s.offered_at AT TIME ZONE ${BUSINESS_TZ})::date = (now() AT TIME ZONE ${BUSINESS_TZ})::date
        )`,
        lastOfferedAt: sql<Date | null>`(
          SELECT max(s.offered_at) FROM imob_assignments s WHERE s.broker_id = ${imobBrokers.id}
        )`,
        pendingAccept: sql<number>`(
          SELECT count(*)::int FROM imob_assignments s
          WHERE s.broker_id = ${imobBrokers.id}
            AND s.status = 'offered' AND s.awaiting_reply = 'accept'
        )`,
      })
      .from(imobBrokers)
      .leftJoin(imobAgencies, eq(imobAgencies.id, imobBrokers.agencyId))
      .where(
        and(
          eq(imobBrokers.active, true),
          isNull(imobBrokers.archivedAt),
          sql`(${imobBrokers.agencyId} IS NULL OR ${imobAgencies.archivedAt} IS NULL)`,
        ),
      );
    return rows as ImobBrokerCandidate[];
  });
}

// ── Atribuições ──────────────────────────────────────────────────────────────

export interface ImobAssignmentRow {
  id: string;
  conversationId: string;
  brokerId: string;
  status: string;
  stage: string | null;
  attempt: number;
  offeredAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
  stageUpdatedAt: Date | null;
  awaitingReply: string | null;
  promptedAt: Date | null;
  followupCount: number;
  /** modo vigente na OFERTA ('ficha' | 'workspace') — o aceite segue este. */
  offerMode: string;
}

const assignmentCols = {
  id: imobAssignments.id,
  conversationId: imobAssignments.conversationId,
  brokerId: imobAssignments.brokerId,
  status: imobAssignments.status,
  stage: imobAssignments.stage,
  attempt: imobAssignments.attempt,
  offeredAt: imobAssignments.offeredAt,
  expiresAt: imobAssignments.expiresAt,
  respondedAt: imobAssignments.respondedAt,
  stageUpdatedAt: imobAssignments.stageUpdatedAt,
  awaitingReply: imobAssignments.awaitingReply,
  promptedAt: imobAssignments.promptedAt,
  followupCount: imobAssignments.followupCount,
  offerMode: imobAssignments.offerMode,
};

const ACTIVE_STATUSES = ["offered", "accepted"] as const;

export async function getActiveImobAssignment(conversationId: string): Promise<ImobAssignmentRow | null> {
  return withTenant(async (tx) => {
    const rows = await tx
      .select(assignmentCols)
      .from(imobAssignments)
      .where(
        and(
          eq(imobAssignments.conversationId, conversationId),
          inArray(imobAssignments.status, [...ACTIVE_STATUSES]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Corretores que JÁ receberam oferta deste lead (exclusão na redistribuição). */
export async function listImobPriorBrokerIds(conversationId: string): Promise<string[]> {
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ brokerId: imobAssignments.brokerId })
      .from(imobAssignments)
      .where(eq(imobAssignments.conversationId, conversationId));
    return [...new Set(rows.map((r) => r.brokerId))];
  });
}

export async function createImobAssignment(input: {
  conversationId: string;
  brokerId: string;
  attempt: number;
  expiresAt: Date;
  /** modo vigente na oferta (default 'ficha'). */
  mode?: ImobBrokerMode;
}): Promise<ImobAssignmentRow> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const [row] = await tx
      .insert(imobAssignments)
      .values({
        tenantId,
        conversationId: input.conversationId,
        brokerId: input.brokerId,
        attempt: input.attempt,
        expiresAt: input.expiresAt,
        awaitingReply: "accept",
        promptedAt: new Date(),
        offerMode: input.mode ?? "ficha",
      })
      .returning(assignmentCols);
    return row!;
  });
}

/**
 * Aceite do corretor — só de offered E dentro do prazo (guard temporal:
 * com SLA curto, a janela de até 60s antes do sweep do worker permitiria
 * aceitar oferta já vencida; achado Codex). Null = não aceitou.
 */
export async function acceptImobAssignment(assignmentId: string): Promise<ImobAssignmentRow | null> {
  return withTenant(async (tx) => {
    const rows = await tx
      .update(imobAssignments)
      .set({
        status: "accepted",
        stage: "em_atendimento",
        respondedAt: new Date(),
        stageUpdatedAt: new Date(),
        awaitingReply: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imobAssignments.id, assignmentId),
          eq(imobAssignments.status, "offered"),
          sql`${imobAssignments.expiresAt} > now()`,
        ),
      )
      .returning(assignmentCols);
    return rows[0] ?? null;
  });
}

export async function declineImobAssignment(assignmentId: string): Promise<ImobAssignmentRow | null> {
  return withTenant(async (tx) => {
    const rows = await tx
      .update(imobAssignments)
      .set({ status: "declined", respondedAt: new Date(), awaitingReply: null, updatedAt: new Date() })
      .where(and(eq(imobAssignments.id, assignmentId), eq(imobAssignments.status, "offered")))
      .returning(assignmentCols);
    return rows[0] ?? null;
  });
}

export async function expireImobAssignment(assignmentId: string): Promise<ImobAssignmentRow | null> {
  return withTenant(async (tx) => {
    const rows = await tx
      .update(imobAssignments)
      .set({ status: "expired", awaitingReply: null, updatedAt: new Date() })
      .where(and(eq(imobAssignments.id, assignmentId), eq(imobAssignments.status, "offered")))
      .returning(assignmentCols);
    return rows[0] ?? null;
  });
}

/**
 * Atualiza o estágio do atendimento (resposta do corretor ao follow-up).
 * Estágio terminal fecha a atribuição. Zera o ciclo de follow-up.
 */
export async function setImobAssignmentStage(
  assignmentId: string,
  stage: string,
): Promise<ImobAssignmentRow | null> {
  const terminal = (IMOB_TERMINAL_STAGES as readonly string[]).includes(stage);
  return withTenant(async (tx) => {
    const rows = await tx
      .update(imobAssignments)
      .set({
        stage,
        ...(terminal ? { status: "closed" } : {}),
        stageUpdatedAt: new Date(),
        awaitingReply: null,
        followupCount: 0,
        updatedAt: new Date(),
      })
      .where(and(eq(imobAssignments.id, assignmentId), eq(imobAssignments.status, "accepted")))
      .returning(assignmentCols);
    return rows[0] ?? null;
  });
}

/** Marca que o follow-up de status foi enviado (incrementa o contador). */
export async function markImobStatusPrompt(assignmentId: string): Promise<void> {
  await withTenant(async (tx) => {
    await tx
      .update(imobAssignments)
      .set({
        awaitingReply: "status",
        promptedAt: new Date(),
        followupCount: sql`${imobAssignments.followupCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(imobAssignments.id, assignmentId));
  });
}

/**
 * Atribuição do corretor aguardando resposta numérica (aceite tem prioridade;
 * empate → a cobrada mais recentemente).
 */
export async function findImobAssignmentAwaitingReply(brokerId: string): Promise<ImobAssignmentRow | null> {
  return withTenant(async (tx) => {
    const rows = await tx
      .select(assignmentCols)
      .from(imobAssignments)
      .where(
        and(
          eq(imobAssignments.brokerId, brokerId),
          inArray(imobAssignments.status, [...ACTIVE_STATUSES]),
          isNotNull(imobAssignments.awaitingReply),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${imobAssignments.awaitingReply} = 'accept' THEN 0 ELSE 1 END`,
        desc(imobAssignments.promptedAt),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Ofertas com aceite vencido (para o scheduler expirar e redistribuir). */
export async function listImobDueAcceptExpiries(limit = 50): Promise<ImobAssignmentRow[]> {
  return withTenant(async (tx) =>
    tx
      .select(assignmentCols)
      .from(imobAssignments)
      .where(and(eq(imobAssignments.status, "offered"), lte(imobAssignments.expiresAt, new Date())))
      .limit(limit),
  );
}

/**
 * REIVINDICA atomicamente os follow-ups devidos (achado Codex): UPDATE com
 * SKIP LOCKED marca prompted/awaiting/contador e retorna SÓ as linhas
 * reivindicadas — réplicas/ticks sobrepostos não duplicam cobrança nem
 * estouram o contador. O worker então enfileira a mensagem; se o enqueue
 * falhar, compensa com `revertImobStatusPrompt` (próximo tick re-tenta).
 */
export async function claimImobDueStatusFollowups(opts: {
  inactivityMs: number;
  maxFollowups: number;
  limit?: number;
}): Promise<ImobAssignmentRow[]> {
  const cutoff = new Date(Date.now() - opts.inactivityMs).toISOString();
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      UPDATE imob_assignments a SET
        awaiting_reply = 'status',
        prompted_at = now(),
        followup_count = a.followup_count + 1,
        updated_at = now()
      WHERE a.id IN (
        SELECT id FROM imob_assignments
        WHERE status = 'accepted'
          AND COALESCE(stage_updated_at, responded_at) <= ${cutoff}::timestamptz
          AND (prompted_at IS NULL OR prompted_at <= ${cutoff}::timestamptz)
          AND followup_count < ${opts.maxFollowups}
        LIMIT ${opts.limit ?? 50}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING a.id, a.conversation_id AS "conversationId", a.broker_id AS "brokerId",
        a.status, a.stage, a.attempt, a.offered_at AS "offeredAt", a.expires_at AS "expiresAt",
        a.responded_at AS "respondedAt", a.stage_updated_at AS "stageUpdatedAt",
        a.awaiting_reply AS "awaitingReply", a.prompted_at AS "promptedAt",
        a.followup_count AS "followupCount", a.offer_mode AS "offerMode"
    `)) as unknown as ImobAssignmentRow[];
    return rows;
  });
}

/**
 * Compensação quando o enqueue da cobrança falha APÓS o claim: devolve o
 * contador e zera o prompt para o próximo tick re-tentar. `awaiting_reply` só
 * é limpo se ESTA era a única cobrança (contador antigo ≤ 1) — havia follow-up
 * anterior pendente (contador ≥ 2), a resposta tardia do corretor a ele segue
 * válida (achado Codex 2ª passada). No SET, as referências são o valor ANTIGO.
 */
export async function revertImobStatusPrompt(assignmentId: string): Promise<void> {
  await withTenant(async (tx) => {
    await tx.execute(sql`
      UPDATE imob_assignments SET
        followup_count = greatest(followup_count - 1, 0),
        prompted_at = NULL,
        awaiting_reply = CASE
          WHEN awaiting_reply = 'status' AND followup_count <= 1 THEN NULL
          ELSE awaiting_reply
        END,
        updated_at = now()
      WHERE id = ${assignmentId}
    `);
  });
}

/**
 * Atendimentos aceitos SEM update de estágio há mais de `inactivityMs` e sem
 * follow-up pendente recente (visão de LEITURA; o worker usa o claim acima).
 */
export async function listImobDueStatusFollowups(opts: {
  inactivityMs: number;
  maxFollowups: number;
  limit?: number;
}): Promise<ImobAssignmentRow[]> {
  // ISO + cast explícito: Date cru em template sql`` do drizzle não serializa
  const cutoff = new Date(Date.now() - opts.inactivityMs).toISOString();
  return withTenant(async (tx) =>
    tx
      .select(assignmentCols)
      .from(imobAssignments)
      .where(
        and(
          eq(imobAssignments.status, "accepted"),
          sql`COALESCE(${imobAssignments.stageUpdatedAt}, ${imobAssignments.respondedAt}) <= ${cutoff}::timestamptz`,
          sql`(${imobAssignments.promptedAt} IS NULL OR ${imobAssignments.promptedAt} <= ${cutoff}::timestamptz)`,
          sql`${imobAssignments.followupCount} < ${opts.maxFollowups}`,
        ),
      )
      .limit(opts.limit ?? 50),
  );
}

// ── Visões do painel ─────────────────────────────────────────────────────────

export interface ImobAssignmentJoined extends ImobAssignmentRow {
  brokerName: string;
  brokerWhatsapp: string;
  agencyName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  leadStatus: string | null;
  leadScore: number | null;
  leadFields: Record<string, unknown> | null;
}

const joinedCols = {
  ...assignmentCols,
  brokerName: imobBrokers.name,
  brokerWhatsapp: imobBrokers.whatsapp,
  agencyName: imobAgencies.name,
  contactName: contacts.profileName,
  contactPhone: contacts.phone,
  contactWaId: contacts.waId,
  leadStatus: leadProfiles.status,
  leadScore: leadProfiles.score,
  leadFields: leadProfiles.fields,
};

/** Forma crua do join (contactWaId vira fallback do telefone no map). */
interface RawJoined extends ImobAssignmentRow {
  brokerName: string;
  brokerWhatsapp: string;
  agencyName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactWaId: string | null;
  leadStatus: string | null;
  leadScore: number | null;
  leadFields: Record<string, unknown> | null;
}

function mapJoined(r: RawJoined): ImobAssignmentJoined {
  const { contactWaId, contactPhone, ...rest } = r;
  return { ...rest, contactPhone: contactPhone ?? contactWaId };
}

export async function listImobAssignments(opts?: {
  status?: string;
  brokerId?: string;
  offerMode?: ImobBrokerMode;
  limit?: number;
  offset?: number;
}): Promise<ImobAssignmentJoined[]> {
  return withTenant(async (tx) => {
    const conds = [];
    if (opts?.status) conds.push(eq(imobAssignments.status, opts.status));
    if (opts?.brokerId) conds.push(eq(imobAssignments.brokerId, opts.brokerId));
    if (opts?.offerMode) conds.push(eq(imobAssignments.offerMode, opts.offerMode));
    let q = tx
      .select(joinedCols)
      .from(imobAssignments)
      .innerJoin(imobBrokers, eq(imobBrokers.id, imobAssignments.brokerId))
      .leftJoin(imobAgencies, eq(imobAgencies.id, imobBrokers.agencyId))
      .innerJoin(conversations, eq(conversations.id, imobAssignments.conversationId))
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .leftJoin(leadProfiles, eq(leadProfiles.conversationId, imobAssignments.conversationId))
      .$dynamic();
    if (conds.length) q = q.where(and(...conds));
    const rows = (await q
      .orderBy(desc(imobAssignments.offeredAt))
      // clamp 500: o board de atendimento carrega o funil inteiro numa chamada
      .limit(Math.min(opts?.limit ?? 50, 500))
      .offset(opts?.offset ?? 0)) as unknown as RawJoined[];
    return rows.map(mapJoined);
  });
}

export async function getImobAssignmentJoined(assignmentId: string): Promise<ImobAssignmentJoined | null> {
  const rows = await listImobAssignmentsById(assignmentId);
  return rows[0] ?? null;
}

async function listImobAssignmentsById(assignmentId: string): Promise<ImobAssignmentJoined[]> {
  return withTenant(async (tx) => {
    const rows = (await tx
      .select(joinedCols)
      .from(imobAssignments)
      .innerJoin(imobBrokers, eq(imobBrokers.id, imobAssignments.brokerId))
      .leftJoin(imobAgencies, eq(imobAgencies.id, imobBrokers.agencyId))
      .innerJoin(conversations, eq(conversations.id, imobAssignments.conversationId))
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .leftJoin(leadProfiles, eq(leadProfiles.conversationId, imobAssignments.conversationId))
      .where(eq(imobAssignments.id, assignmentId))
      .limit(1)) as unknown as RawJoined[];
    return rows.map(mapJoined);
  });
}

export interface ImobOverview {
  today: { offered: number; accepted: number; acceptedInSla: number; expired: number; declined: number };
  active: { offered: number; accepted: number };
  byStage: Array<{ stage: string; count: number }>;
  avgAcceptSeconds: number | null;
  /** SLA (minutos) usado no corte de `acceptedInSla` — o painel exibe. */
  slaMinutes: number;
  byBrokerToday: Array<{ brokerId: string; brokerName: string; offered: number; accepted: number }>;
}

export async function getImobOverview(acceptSlaMinutes = 5): Promise<ImobOverview> {
  return withTenant(async (tx) => {
    const [today] = (await tx.execute(sql`
      SELECT
        count(*) FILTER (WHERE true)::int AS offered,
        count(*) FILTER (WHERE status IN ('accepted','closed') AND responded_at IS NOT NULL)::int AS accepted,
        count(*) FILTER (WHERE responded_at IS NOT NULL AND status IN ('accepted','closed')
                          AND responded_at - offered_at <= (${acceptSlaMinutes} * interval '1 minute'))::int AS "acceptedInSla",
        count(*) FILTER (WHERE status = 'expired')::int AS expired,
        count(*) FILTER (WHERE status = 'declined')::int AS declined,
        avg(EXTRACT(EPOCH FROM (responded_at - offered_at)))
          FILTER (WHERE responded_at IS NOT NULL AND status IN ('accepted','closed')) AS "avgAcceptSeconds"
      FROM imob_assignments
      WHERE (offered_at AT TIME ZONE ${BUSINESS_TZ})::date = (now() AT TIME ZONE ${BUSINESS_TZ})::date
    `)) as unknown as Array<{
      offered: number;
      accepted: number;
      acceptedInSla: number;
      expired: number;
      declined: number;
      avgAcceptSeconds: string | null;
    }>;

    const [active] = (await tx.execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'offered')::int AS offered,
        count(*) FILTER (WHERE status = 'accepted')::int AS accepted
      FROM imob_assignments
    `)) as unknown as Array<{ offered: number; accepted: number }>;

    const byStage = (await tx.execute(sql`
      SELECT stage, count(*)::int AS count
      FROM imob_assignments
      WHERE status = 'accepted' AND stage IS NOT NULL
      GROUP BY stage ORDER BY count DESC
    `)) as unknown as Array<{ stage: string; count: number }>;

    const byBrokerToday = (await tx.execute(sql`
      SELECT b.id AS "brokerId", b.name AS "brokerName",
        count(s.id)::int AS offered,
        count(s.id) FILTER (WHERE s.status IN ('accepted','closed'))::int AS accepted
      FROM imob_brokers b
      LEFT JOIN imob_assignments s ON s.broker_id = b.id
        AND (s.offered_at AT TIME ZONE ${BUSINESS_TZ})::date = (now() AT TIME ZONE ${BUSINESS_TZ})::date
      WHERE b.archived_at IS NULL
      GROUP BY b.id, b.name ORDER BY offered DESC
    `)) as unknown as Array<{ brokerId: string; brokerName: string; offered: number; accepted: number }>;

    return {
      today: {
        offered: today?.offered ?? 0,
        accepted: today?.accepted ?? 0,
        acceptedInSla: today?.acceptedInSla ?? 0,
        expired: today?.expired ?? 0,
        declined: today?.declined ?? 0,
      },
      active: { offered: active?.offered ?? 0, accepted: active?.accepted ?? 0 },
      byStage,
      avgAcceptSeconds: today?.avgAcceptSeconds ? Math.round(Number(today.avgAcceptSeconds)) : null,
      slaMinutes: acceptSlaMinutes,
      byBrokerToday,
    };
  });
}

// ── Eventos (timeline/auditoria) ─────────────────────────────────────────────

export async function recordImobEvent(input: {
  conversationId: string;
  type: string;
  assignmentId?: string;
  brokerId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx.insert(imobEvents).values({
      tenantId,
      conversationId: input.conversationId,
      assignmentId: input.assignmentId ?? null,
      brokerId: input.brokerId ?? null,
      type: input.type,
      metadata: input.metadata ?? {},
    });
  });
}

export interface ImobEventRow {
  id: string;
  conversationId: string;
  assignmentId: string | null;
  brokerId: string | null;
  type: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export async function listImobEvents(conversationId: string, limit = 100): Promise<ImobEventRow[]> {
  return withTenant(async (tx) =>
    tx
      .select({
        id: imobEvents.id,
        conversationId: imobEvents.conversationId,
        assignmentId: imobEvents.assignmentId,
        brokerId: imobEvents.brokerId,
        type: imobEvents.type,
        metadata: imobEvents.metadata,
        createdAt: imobEvents.createdAt,
      })
      .from(imobEvents)
      .where(eq(imobEvents.conversationId, conversationId))
      .orderBy(desc(imobEvents.createdAt))
      .limit(limit) as Promise<ImobEventRow[]>,
  );
}

// ── Varredura system-level (scheduler de SLA, padrão 0029) ───────────────────

/**
 * Tenants com trabalho de SLA imobiliário: oferta vencida OU atendimento
 * aceito (candidato a follow-up). SELECT-only sob app.system_scan.
 */
export async function listTenantsWithImobDue(): Promise<string[]> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_scan', 'on', true)`);
    const rows = (await tx.execute(sql`
      SELECT DISTINCT s.tenant_id AS "tenantId"
      FROM imob_assignments s
      JOIN tenants t ON t.id = s.tenant_id AND t.status = 'active'
      WHERE (s.status = 'offered' AND s.expires_at <= now())
         OR s.status = 'accepted'
    `)) as unknown as Array<{ tenantId: string }>;
    return rows.map((r) => r.tenantId);
  });
}

// ── Workspace do corretor (0040) ─────────────────────────────────────────────

export type ImobBrokerMode = "ficha" | "workspace";

/** Modo de atendimento do tenant: 'ficha' (default) ou 'workspace'. */
export async function getImobBrokerMode(): Promise<ImobBrokerMode> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ brokerMode: imobSettings.brokerMode })
      .from(imobSettings)
      .where(eq(imobSettings.tenantId, tenantId))
      .limit(1);
    return rows[0]?.brokerMode === "workspace" ? "workspace" : "ficha";
  });
}

export async function setImobBrokerMode(mode: ImobBrokerMode): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .insert(imobSettings)
      .values({ tenantId, brokerMode: mode })
      .onConflictDoUpdate({
        target: imobSettings.tenantId,
        set: { brokerMode: mode, updatedAt: new Date() },
      });
  });
}

/** Corretor por id (guard do workspace: versão do token + ativo). */
export async function getImobBrokerById(brokerId: string): Promise<
  (ImobBrokerRow & { accessTokenVersion: number }) | null
> {
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ ...brokerCols, accessTokenVersion: imobBrokers.accessTokenVersion })
      .from(imobBrokers)
      .leftJoin(imobAgencies, eq(imobAgencies.id, imobBrokers.agencyId))
      .where(eq(imobBrokers.id, brokerId))
      .limit(1);
    return (rows[0] as (ImobBrokerRow & { accessTokenVersion: number }) | undefined) ?? null;
  });
}

/** Revoga TODOS os links do workspace do corretor (bump da versão). */
export async function bumpImobBrokerTokenVersion(brokerId: string): Promise<number | null> {
  return withTenant(async (tx) => {
    const rows = await tx
      .update(imobBrokers)
      .set({ accessTokenVersion: sql`${imobBrokers.accessTokenVersion} + 1`, updatedAt: new Date() })
      .where(eq(imobBrokers.id, brokerId))
      .returning({ v: imobBrokers.accessTokenVersion });
    return rows[0]?.v ?? null;
  });
}

/**
 * Atendimentos do corretor p/ o workspace: ATIVOS (accepted) e ofertados no
 * modo 'workspace' — ofertas 'ficha' (corretor já tem o telefone) seguem o
 * fluxo antigo e NÃO aparecem aqui, mesmo que o tenant troque o modo depois.
 */
export async function listImobWorkspaceAssignments(brokerId: string): Promise<ImobAssignmentJoined[]> {
  // filtro no SQL (não pós-limit): muitos atendimentos 'ficha' não podem
  // empurrar os 'workspace' para fora da página (achado Codex 2ª rodada)
  return listImobAssignments({ brokerId, status: "accepted", offerMode: "workspace", limit: 50 });
}

/**
 * ESCOPO do workspace: a conversa pertence a um atendimento ATIVO deste
 * corretor, ofertado no modo 'workspace'? (Corretor só enxerga os leads DELE.)
 */
export async function imobAssignmentForBrokerConversation(
  brokerId: string,
  conversationId: string,
): Promise<ImobAssignmentRow | null> {
  return withTenant(async (tx) => {
    const rows = await tx
      .select(assignmentCols)
      .from(imobAssignments)
      .where(
        and(
          eq(imobAssignments.brokerId, brokerId),
          eq(imobAssignments.conversationId, conversationId),
          eq(imobAssignments.status, "accepted"),
          eq(imobAssignments.offerMode, "workspace"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}
