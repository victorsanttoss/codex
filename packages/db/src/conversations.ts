import { and, desc, eq, sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { contacts, conversations, messages } from "./schema";

/** Janela de atendimento do WhatsApp (free-form permitido só dentro dela). */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinServiceWindow(
  windowExpiresAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return !!windowExpiresAt && windowExpiresAt.getTime() > now.getTime();
}

export interface InboundRecord {
  conversationKey: string;
  waId: string;
  phone?: string;
  profileName?: string;
  externalMessageId: string;
  type: string;
  content: Record<string, unknown>;
  receivedAt?: Date;
}

export interface RecordedInbound {
  conversationId: string;
  messageId: string;
}

/** Upsert de contato + conversa (reseta a janela 24h) + persiste a mensagem inbound. */
export async function recordInboundMessage(rec: InboundRecord): Promise<RecordedInbound> {
  const { tenantId } = requireTenantContext();
  const now = rec.receivedAt ?? new Date();
  const windowExpires = new Date(now.getTime() + SERVICE_WINDOW_MS);

  return withTenant(async (tx) => {
    const [contact] = await tx
      .insert(contacts)
      .values({
        tenantId,
        waId: rec.waId,
        phone: rec.phone ?? null,
        profileName: rec.profileName ?? null,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [contacts.tenantId, contacts.waId],
        set: {
          // Um retry antigo pode chegar depois de um inbound mais recente.
          // Reentregas nunca recuam o relógio do contato.
          lastSeenAt: sql`greatest(${contacts.lastSeenAt}, excluded.last_seen_at)`,
          profileName: sql`coalesce(excluded.profile_name, ${contacts.profileName})`,
          phone: sql`coalesce(excluded.phone, ${contacts.phone})`,
        },
      })
      .returning({ id: contacts.id });
    if (!contact) throw new Error("falha ao upsert contato");

    const [conv] = await tx
      .insert(conversations)
      .values({
        tenantId,
        contactId: contact.id,
        conversationKey: rec.conversationKey,
        lastInboundAt: now,
        windowExpiresAt: windowExpires,
      })
      .onConflictDoUpdate({
        target: [conversations.tenantId, conversations.conversationKey],
        set: {
          lastInboundAt: sql`greatest(${conversations.lastInboundAt}, excluded.last_inbound_at)`,
          windowExpiresAt: sql`greatest(${conversations.windowExpiresAt}, excluded.window_expires_at)`,
          status: "open",
        },
      })
      .returning({ id: conversations.id });
    if (!conv) throw new Error("falha ao upsert conversa");

    // IDEMPOTENTE sob retry (at-least-once, ADR 0024): o dedup agora é registrado
    // APÓS o sucesso do turno, então uma re-tentativa reexecuta este insert — o
    // conflito em (tenant_id, external_message_id) reusa a linha existente em vez
    // de duplicar o inbound no histórico (ou explodir a re-tentativa).
    const [msg] = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId: conv.id,
        direction: "inbound",
        type: rec.type,
        content: rec.content,
        externalMessageId: rec.externalMessageId,
        status: "received",
      })
      .onConflictDoNothing({ target: [messages.tenantId, messages.externalMessageId] })
      .returning({ id: messages.id });
    if (msg) return { conversationId: conv.id, messageId: msg.id };

    const existing = await tx
      .select({ id: messages.id, conversationId: messages.conversationId, direction: messages.direction })
      .from(messages)
      .where(
        and(eq(messages.tenantId, tenantId), eq(messages.externalMessageId, rec.externalMessageId)),
      );
    if (!existing[0]) throw new Error("falha ao inserir mensagem inbound");
    // Uma identidade já usada em outra conversa (ou outbound) não é retry.
    // Falhar aqui também desfaz os upserts acima, mantendo o destino original.
    if (existing[0].conversationId !== conv.id || existing[0].direction !== "inbound") {
      throw new Error("inbound_message_identity_conflict");
    }
    return { conversationId: existing[0].conversationId, messageId: existing[0].id };
  });
}

/**
 * Grava o TEXTO transcrito de um áudio no `content` da mensagem inbound. Sem
 * isto o texto fica só em `media_objects.transcription` e o histórico da
 * conversa (getConversationHistory → buildConversationMessages lê content.text)
 * NUNCA vê o que o lead falou por voz — a IA "esquece" o áudio no turno seguinte.
 * Preserva mediaType/mediaId e marca `transcribed:true` (o painel pode exibir 🎤).
 * jsonb_set idempotente: reprocessar o mesmo áudio reescreve o mesmo texto.
 */
export async function setInboundTranscription(messageId: string, text: string): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .update(messages)
      .set({
        content: sql`jsonb_set(jsonb_set(${messages.content}, '{text}', to_jsonb(${text}::text), true), '{transcribed}', 'true'::jsonb, true)`,
      })
      .where(and(eq(messages.tenantId, tenantId), eq(messages.id, messageId)));
  });
}

export interface ConversationView {
  id: string;
  conversationKey: string;
  windowExpiresAt: Date | null;
}

export async function getConversationByKey(
  conversationKey: string,
): Promise<ConversationView | null> {
  return withTenant(async (tx) => {
    const rows = await tx
      .select({
        id: conversations.id,
        conversationKey: conversations.conversationKey,
        windowExpiresAt: conversations.windowExpiresAt,
      })
      .from(conversations)
      .where(eq(conversations.conversationKey, conversationKey))
      .limit(1);
    return rows[0] ?? null;
  });
}

export interface HistoryMessage {
  direction: "inbound" | "outbound";
  type: string;
  content: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Histórico recente da conversa (mais ANTIGO → mais NOVO), limitado. O agente
 * monta o contexto do LLM a partir disto (dentro de um orçamento de tokens).
 */
export async function getConversationHistory(
  conversationId: string,
  limit = 30,
): Promise<HistoryMessage[]> {
  return withTenant(async (tx) => {
    const rows = await tx
      .select({
        direction: messages.direction,
        type: messages.type,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(Math.max(1, limit));
    return rows
      .reverse()
      .map((r) => ({
        direction: r.direction as "inbound" | "outbound",
        type: r.type,
        content: r.content as Record<string, unknown>,
        createdAt: r.createdAt,
      }));
  });
}

/** Janela de 24h de uma conversa por id (p/ revalidação no envio do outbox). */
export async function getConversationWindow(conversationId: string): Promise<Date | null> {
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ windowExpiresAt: conversations.windowExpiresAt })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    return rows[0]?.windowExpiresAt ?? null;
  });
}

export interface ConversationContact {
  waId: string;
  phone: string | null;
}

/** Contato (wa_id/telefone) dono da conversa — p/ cadência/outbox (M8). */
export async function getConversationContact(
  conversationId: string,
): Promise<ConversationContact | null> {
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ waId: contacts.waId, phone: contacts.phone })
      .from(conversations)
      .innerJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(eq(conversations.id, conversationId))
      .limit(1);
    return rows[0] ?? null;
  });
}

export interface OutboundRecord {
  conversationId: string;
  type: string;
  content: Record<string, unknown>;
  externalMessageId: string;
  status?: "queued" | "sent";
}

/** Persiste a mensagem outbound (após enviar) e atualiza last_outbound_at. */
export async function recordOutboundMessage(rec: OutboundRecord): Promise<{ messageId: string }> {
  const { tenantId } = requireTenantContext();
  const now = new Date();
  return withTenant(async (tx) => {
    const [msg] = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId: rec.conversationId,
        direction: "outbound",
        type: rec.type,
        content: rec.content,
        externalMessageId: rec.externalMessageId,
        status: rec.status ?? "sent",
      })
      .returning({ id: messages.id });
    if (!msg) throw new Error("falha ao inserir mensagem outbound");

    await tx
      .update(conversations)
      .set({ lastOutboundAt: now })
      .where(eq(conversations.id, rec.conversationId));
    return { messageId: msg.id };
  });
}

type MsgStatus = "received" | "queued" | "sent" | "delivered" | "read" | "failed";
const STATUS_RANK: Record<MsgStatus, number> = {
  received: 0,
  queued: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
};

/**
 * Atualiza o status pelo external_message_id (delivery receipts), de forma
 * MONOTÔNICA: eventos fora de ordem não regridem (ex.: 'delivered' atrasado não
 * rebaixa 'read'). Achado MÉDIO da revisão do Codex.
 */
export async function markMessageStatusByExternalId(
  externalMessageId: string,
  status: "sent" | "delivered" | "read" | "failed",
  error?: Record<string, unknown>,
): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(
        and(eq(messages.tenantId, tenantId), eq(messages.externalMessageId, externalMessageId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return false;
    if (STATUS_RANK[status] <= STATUS_RANK[row.status as MsgStatus]) return false; // não regride
    await tx
      .update(messages)
      .set({ status, error: error ?? null, statusUpdatedAt: new Date() })
      .where(eq(messages.id, row.id));
    return true;
  });
}
