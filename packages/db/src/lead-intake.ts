import { and, eq, sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { contacts, conversations, leadProfiles } from "./schema";

// ── Entrada de leads de CAMPANHA (Meta Lead Ads / formulários / integrações) ──
// Diferente do inbound de WhatsApp: aqui o lead AINDA NÃO mandou mensagem — o
// cadastro chega por fora e a SDR faz o PRIMEIRO contato. A conversa é criada
// com a MESMA conversation_key que o canal usará quando o lead responder, para
// a resposta cair aqui (com os campos pré-preenchidos do formulário).

export interface EnsureIntakeLeadInput {
  /** Telefone em dígitos (vira wa_id do contato). */
  waId: string;
  phone: string;
  profileName?: string | null;
  conversationKey: string;
  /** Campos do formulário — NUNCA sobrescrevem o que a conversa já extraiu. */
  fields: Record<string, unknown>;
}

export interface EnsureIntakeLeadResult {
  contactId: string;
  conversationId: string;
  conversationCreated: boolean;
  /** true = a SDR já falou com esse lead antes (não repetir primeiro contato). */
  hadOutbound: boolean;
}

export async function ensureIntakeLead(input: EnsureIntakeLeadInput): Promise<EnsureIntakeLeadResult> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const [contact] = await tx
      .insert(contacts)
      .values({
        tenantId,
        waId: input.waId,
        phone: input.phone,
        profileName: input.profileName ?? null,
      })
      .onConflictDoUpdate({
        target: [contacts.tenantId, contacts.waId],
        set: {
          // novo vence (mesma direção do inbound; achado Codex) — wa_id é a
          // identidade, phone é exibição e pode ter vindo mal-normalizado
          phone: sql`coalesce(excluded.phone, ${contacts.phone})`,
          profileName: sql`coalesce(${contacts.profileName}, excluded.profile_name)`,
        },
      })
      .returning({ id: contacts.id });
    if (!contact) throw new Error("intake: falha ao upsert contato");

    // conversa: existente vence (upsert só p/ pegar o id sem corrida)
    const existing = await tx
      .select({ id: conversations.id, lastOutboundAt: conversations.lastOutboundAt })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.conversationKey, input.conversationKey)))
      .limit(1);

    let conversationId: string;
    let conversationCreated = false;
    let hadOutbound = false;
    if (existing[0]) {
      conversationId = existing[0].id;
      hadOutbound = existing[0].lastOutboundAt !== null;
    } else {
      const [conv] = await tx
        .insert(conversations)
        .values({ tenantId, contactId: contact.id, conversationKey: input.conversationKey })
        .onConflictDoNothing()
        .returning({ id: conversations.id });
      if (conv) {
        conversationId = conv.id;
        conversationCreated = true;
      } else {
        // corrida benigna: outro request criou entre o select e o insert
        const again = await tx
          .select({ id: conversations.id, lastOutboundAt: conversations.lastOutboundAt })
          .from(conversations)
          .where(and(eq(conversations.tenantId, tenantId), eq(conversations.conversationKey, input.conversationKey)))
          .limit(1);
        if (!again[0]) throw new Error("intake: falha ao criar conversa");
        conversationId = again[0].id;
        hadOutbound = again[0].lastOutboundAt !== null;
      }
    }

    // perfil do lead: formulário PRÉ-PREENCHE, conversa VENCE (o que o lead
    // disse ao vivo vale mais do que o que digitou no formulário)
    await tx
      .insert(leadProfiles)
      .values({ tenantId, conversationId, fields: input.fields })
      .onConflictDoUpdate({
        target: [leadProfiles.tenantId, leadProfiles.conversationId],
        set: {
          fields: sql`excluded.fields || ${leadProfiles.fields}`,
          updatedAt: new Date(),
        },
      });

    return { contactId: contact.id, conversationId, conversationCreated, hadOutbound };
  });
}
