import { and, eq } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { contacts, conversations, leadProfiles, messages } from "./schema";

const SANDBOX_WA_ID = "sandbox-tester";

/**
 * Garante a conversa de SANDBOX do Playground (M14): uma por (tenant, nicho),
 * marcada `sandbox=true` para ser excluída do painel. O agente REAL roda contra
 * ela; nada é enviado ao WhatsApp/CRM/cadência (o Playground captura a resposta).
 */
export async function ensureSandboxConversation(niche?: string): Promise<string> {
  const { tenantId } = requireTenantContext();
  const key = `sandbox:${niche ?? "default"}`;
  return withTenant(async (tx) => {
    const [contact] = await tx
      .insert(contacts)
      .values({ tenantId, waId: SANDBOX_WA_ID, profileName: "Lead de teste" })
      .onConflictDoNothing({ target: [contacts.tenantId, contacts.waId] })
      .returning({ id: contacts.id });
    const contactId =
      contact?.id ??
      (await tx.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.waId, SANDBOX_WA_ID))))[0]!.id;

    const [conv] = await tx
      .insert(conversations)
      .values({ tenantId, contactId, conversationKey: key, sandbox: true })
      .onConflictDoNothing({ target: [conversations.tenantId, conversations.conversationKey] })
      .returning({ id: conversations.id });
    if (conv?.id) return conv.id;
    // Reuso defensivo: SÓ uma conversa marcada sandbox=true (o namespace `sandbox:`
    // não colide com canais reais `cloud_api:`/`baileys:`; se colidisse, falha aqui).
    const existing = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.conversationKey, key), eq(conversations.sandbox, true)));
    if (!existing[0]) throw new Error("Conversa de sandbox indisponível (conflito de chave).");
    return existing[0].id;
  });
}

/** Zera a conversa de sandbox (mensagens + lead) — botão "Reiniciar". */
export async function resetSandbox(niche?: string): Promise<void> {
  const { tenantId } = requireTenantContext();
  const conversationId = await ensureSandboxConversation(niche);
  await withTenant(async (tx) => {
    await tx.delete(messages).where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId)));
    // lead_profiles guarda os campos qualificados + summary do sandbox → limpa.
    await tx.delete(leadProfiles).where(and(eq(leadProfiles.tenantId, tenantId), eq(leadProfiles.conversationId, conversationId)));
  });
}
