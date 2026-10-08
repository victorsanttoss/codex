import { and, eq, sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { cadenceState, contacts, messageTemplates } from "./schema";

// ── Catálogo de templates (HSM) ───────────────────────────────

export interface ApprovedTemplate {
  name: string;
  languageCode: string;
  variables: string[];
  category: string;
  /** Corpo escrito pelo cliente (M8-ext) — Baileys envia como texto. */
  bodyText: string | null;
}

/** Template APROVADO do tenant (ou null). A aprovação na Meta é externa. */
export async function getApprovedTemplate(
  name: string,
  languageCode: string,
): Promise<ApprovedTemplate | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({
        name: messageTemplates.name,
        languageCode: messageTemplates.languageCode,
        variables: messageTemplates.variables,
        category: messageTemplates.category,
        status: messageTemplates.status,
        bodyText: messageTemplates.bodyText,
      })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.tenantId, tenantId),
          eq(messageTemplates.name, name),
          eq(messageTemplates.languageCode, languageCode),
        ),
      )
      .limit(1);
    const r = rows[0];
    if (!r || r.status !== "approved") return null;
    return {
      name: r.name,
      languageCode: r.languageCode,
      variables: (r.variables as string[]) ?? [],
      category: r.category,
      bodyText: r.bodyText,
    };
  });
}

export interface TemplateRow {
  name: string;
  languageCode: string;
  category: string;
  status: string;
  bodyText: string | null;
  variables: string[];
}

/** Lista o catálogo de templates do tenant (qualquer status — p/ painel/wizard). */
export async function listMessageTemplates(): Promise<TemplateRow[]> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({
        name: messageTemplates.name,
        languageCode: messageTemplates.languageCode,
        category: messageTemplates.category,
        status: messageTemplates.status,
        bodyText: messageTemplates.bodyText,
        variables: messageTemplates.variables,
      })
      .from(messageTemplates)
      .where(eq(messageTemplates.tenantId, tenantId))
      .orderBy(messageTemplates.name);
    return rows.map((r) => ({ ...r, variables: (r.variables as string[]) ?? [] }));
  });
}

/**
 * Atualiza o STATUS de um template (webhook de aprovação da Meta), CORRELACIONANDO
 * com a submissão atual (achado Codex): se a linha tem `meta_template_id` e o
 * evento também, eles precisam bater — um webhook ATRASADO de uma submissão
 * antiga não pode aprovar o corpo novo (nomes são reutilizados pelo wizard).
 * Linha sem id (legado/kit) aceita por nome, como antes.
 */
export async function setTemplateStatus(
  name: string,
  languageCode: string,
  status: string,
  eventTemplateId?: string,
): Promise<"updated" | "not_found" | "id_mismatch"> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ id: messageTemplates.id, metaTemplateId: messageTemplates.metaTemplateId })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.tenantId, tenantId),
          eq(messageTemplates.name, name),
          eq(messageTemplates.languageCode, languageCode),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return "not_found";
    // Linha COM id de submissão só aceita evento com o MESMO id — evento sem id
    // não é correlacionável quando esperamos correlação (achado Codex).
    if (row.metaTemplateId && row.metaTemplateId !== eventTemplateId) {
      return "id_mismatch";
    }
    await tx
      .update(messageTemplates)
      .set({ status, updatedAt: new Date() })
      .where(eq(messageTemplates.id, row.id));
    return "updated";
  });
}

/** Grava o id devolvido pelo Graph POST (correlação da submissão à Meta). */
export async function setTemplateMetaId(
  name: string,
  languageCode: string,
  metaTemplateId: string,
): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .update(messageTemplates)
      .set({ metaTemplateId, updatedAt: new Date() })
      .where(
        and(
          eq(messageTemplates.tenantId, tenantId),
          eq(messageTemplates.name, name),
          eq(messageTemplates.languageCode, languageCode),
        ),
      );
  });
}

/** Upsert de template (cadastro do aprovado). */
export async function upsertMessageTemplate(input: {
  name: string;
  languageCode: string;
  category?: string;
  variables?: string[];
  status?: string;
  bodyText?: string | null;
  /**
   * Correlação da submissão (achado Codex): `null` LIMPA o id antigo no MESMO
   * write que registra a nova submissão — sem janela em que um webhook atrasado
   * da submissão anterior ainda casaria. `undefined` preserva (updates sem
   * relação com submissão).
   */
  metaTemplateId?: string | null;
}): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .insert(messageTemplates)
      .values({
        tenantId,
        name: input.name,
        languageCode: input.languageCode,
        category: input.category ?? "marketing",
        variables: input.variables ?? [],
        status: input.status ?? "approved",
        ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
        ...(input.metaTemplateId !== undefined ? { metaTemplateId: input.metaTemplateId } : {}),
      })
      .onConflictDoUpdate({
        target: [messageTemplates.tenantId, messageTemplates.name, messageTemplates.languageCode],
        set: {
          category: input.category ?? "marketing",
          variables: input.variables ?? [],
          status: input.status ?? "approved",
          ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
          ...(input.metaTemplateId !== undefined ? { metaTemplateId: input.metaTemplateId } : {}),
          updatedAt: new Date(),
        },
      });
  });
}

export interface CadenceStateRow {
  conversationId: string;
  currentStep: number;
  nextStepAt: Date | null;
  status: string;
  stopReason: string | null;
}

export async function getCadenceState(conversationId: string): Promise<CadenceStateRow | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({
        conversationId: cadenceState.conversationId,
        currentStep: cadenceState.currentStep,
        nextStepAt: cadenceState.nextStepAt,
        status: cadenceState.status,
        stopReason: cadenceState.stopReason,
      })
      .from(cadenceState)
      .where(and(eq(cadenceState.tenantId, tenantId), eq(cadenceState.conversationId, conversationId)));
    return rows[0] ?? null;
  });
}

/** (Re)arma a cadência: define passo e próximo disparo, status active. */
export async function armCadence(
  conversationId: string,
  currentStep: number,
  nextStepAt: Date,
): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .insert(cadenceState)
      .values({ tenantId, conversationId, currentStep, nextStepAt, status: "active" })
      .onConflictDoUpdate({
        target: [cadenceState.tenantId, cadenceState.conversationId],
        set: { currentStep, nextStepAt, status: "active", stopReason: null, updatedAt: new Date() },
      });
  });
}

/** Para a cadência (engagement/opt-out/qualified/handoff). Idempotente. */
export async function stopCadence(conversationId: string, reason: string): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .update(cadenceState)
      .set({ status: "stopped", stopReason: reason, nextStepAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(cadenceState.tenantId, tenantId),
          eq(cadenceState.conversationId, conversationId),
          eq(cadenceState.status, "active"),
        ),
      );
  });
}

export async function completeCadence(conversationId: string): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .update(cadenceState)
      .set({ status: "completed", nextStepAt: null, updatedAt: new Date() })
      .where(and(eq(cadenceState.tenantId, tenantId), eq(cadenceState.conversationId, conversationId)));
  });
}

export interface DueCadence {
  conversationId: string;
  currentStep: number;
}

/** Cadências ativas com passo vencido (claim atômico SKIP LOCKED). */
export async function claimDueCadence(limit: number): Promise<DueCadence[]> {
  return withTenant(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT id, conversation_id, current_step FROM cadence_state
      WHERE status = 'active' AND next_step_at IS NOT NULL AND next_step_at <= now()
      ORDER BY next_step_at ASC
      LIMIT ${Math.max(1, Math.floor(limit))}
      FOR UPDATE SKIP LOCKED
    `)) as unknown as Array<{ conversation_id: string; current_step: number }>;
    return rows.map((r) => ({ conversationId: r.conversation_id, currentStep: Number(r.current_step) }));
  });
}

// ── Opt-out (LGPD) por contato ────────────────────────────────

/** Marca o contato (wa_id) como opt-out. Idempotente. */
export async function markContactOptedOut(waId: string): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .update(contacts)
      .set({ optedOut: true, optedOutAt: new Date() })
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.waId, waId)));
  });
}

export async function isContactOptedOut(waId: string): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ optedOut: contacts.optedOut })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.waId, waId)));
    return rows[0]?.optedOut ?? false;
  });
}
