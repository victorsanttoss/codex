import { and, eq } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { agentConfigs, agentResponseClaims, leadProfiles } from "./schema";

export interface LeadProfile {
  id: string;
  conversationId: string;
  stage: string;
  status: string;
  score: number;
  fields: Record<string, unknown>;
  summary: string | null;
}

/** Lê o lead da conversa (ou null). */
export async function getLeadProfile(conversationId: string): Promise<LeadProfile | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select()
      .from(leadProfiles)
      .where(and(eq(leadProfiles.tenantId, tenantId), eq(leadProfiles.conversationId, conversationId)));
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      conversationId: r.conversationId,
      stage: r.stage,
      status: r.status,
      score: r.score,
      fields: r.fields as Record<string, unknown>,
      summary: r.summary,
    };
  });
}

/** Garante que existe um lead p/ a conversa (cria 'new'/'discovery' se faltar). */
export async function getOrCreateLeadProfile(conversationId: string): Promise<LeadProfile> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .insert(leadProfiles)
      .values({ tenantId, conversationId })
      .onConflictDoNothing({ target: [leadProfiles.tenantId, leadProfiles.conversationId] });
  });
  const lead = await getLeadProfile(conversationId);
  if (!lead) throw new Error("falha ao criar lead_profile");
  return lead;
}

/** Merge dos campos qualificados (IA extrai). Read-modify-write sob FIFO da conversa. */
export async function mergeLeadFields(
  conversationId: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ fields: leadProfiles.fields })
      .from(leadProfiles)
      .where(and(eq(leadProfiles.tenantId, tenantId), eq(leadProfiles.conversationId, conversationId)));
    const current = (rows[0]?.fields as Record<string, unknown>) ?? {};
    const merged = { ...current, ...fields };
    await tx
      .update(leadProfiles)
      .set({ fields: merged, updatedAt: new Date() })
      .where(and(eq(leadProfiles.tenantId, tenantId), eq(leadProfiles.conversationId, conversationId)));
    return merged;
  });
}

export interface LeadDecisionUpdate {
  stage?: string;
  status?: string;
  score?: number;
}

/** Aplica a DECISÃO (governada por código) ao lead. */
export async function applyLeadDecision(
  conversationId: string,
  decision: LeadDecisionUpdate,
): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .update(leadProfiles)
      .set({
        ...(decision.stage !== undefined ? { stage: decision.stage } : {}),
        ...(decision.status !== undefined ? { status: decision.status } : {}),
        ...(decision.score !== undefined ? { score: decision.score } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(leadProfiles.tenantId, tenantId), eq(leadProfiles.conversationId, conversationId)));
  });
}

/** Atualiza o resumo rolante da conversa. */
export async function setLeadSummary(conversationId: string, summary: string): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .update(leadProfiles)
      .set({ summary, updatedAt: new Date() })
      .where(and(eq(leadProfiles.tenantId, tenantId), eq(leadProfiles.conversationId, conversationId)));
  });
}

/**
 * Reivindica a chave de idempotência de ENVIO. Retorna true se foi reivindicada
 * AGORA (pode enviar), false se já existia (não reenviar). É a barreira de
 * "no máximo um envio por passo" sob retry do worker.
 */
export async function claimAgentResponse(claimKey: string): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const inserted = await tx
      .insert(agentResponseClaims)
      .values({ tenantId, claimKey })
      .onConflictDoNothing({ target: [agentResponseClaims.tenantId, agentResponseClaims.claimKey] })
      .returning({ id: agentResponseClaims.id });
    return inserted.length > 0;
  });
}

/**
 * Libera uma chave reivindicada cujo ENVIO falhou (compensação). Sem isso, um
 * retry do worker veria a chave existente e pularia o envio — a mensagem do
 * lead ficaria processada sem resposta. A janela restante (crash entre claim e
 * envio) mantém o at-most-once do ADR 0024.
 */
export async function releaseAgentResponse(claimKey: string): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .delete(agentResponseClaims)
      .where(and(eq(agentResponseClaims.tenantId, tenantId), eq(agentResponseClaims.claimKey, claimKey)));
  });
}

/** Config do agente do tenant ativo (ou null → usa o default em código). */
export async function getAgentConfig(): Promise<Record<string, unknown> | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ config: agentConfigs.config })
      .from(agentConfigs)
      .where(eq(agentConfigs.tenantId, tenantId));
    return (rows[0]?.config as Record<string, unknown>) ?? null;
  });
}

/** Upsert da config do agente do tenant ativo. */
export async function putAgentConfig(config: Record<string, unknown>): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .insert(agentConfigs)
      .values({ tenantId, config })
      .onConflictDoUpdate({ target: agentConfigs.tenantId, set: { config, updatedAt: new Date() } });
  });
}
