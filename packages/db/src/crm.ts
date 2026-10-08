import { and, eq, sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import {
  activities,
  appointments,
  crmContacts,
  crmExternalSync,
  notifications,
  opportunities,
} from "./schema";

// ── CRM built-in (contatos/oportunidades/atividades) ──────────

export interface UpsertContactInput {
  phone: string;
  name?: string;
  fields?: Record<string, unknown>;
}

/** Upsert idempotente por (tenant, phone). Mescla os campos qualificados. */
export async function upsertCrmContact(input: UpsertContactInput): Promise<{ contactId: string }> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .insert(crmContacts)
      .values({
        tenantId,
        phone: input.phone,
        name: input.name ?? null,
        fields: input.fields ?? {},
      })
      .onConflictDoUpdate({
        target: [crmContacts.tenantId, crmContacts.phone],
        set: {
          name: sql`coalesce(excluded.name, ${crmContacts.name})`,
          fields: sql`${crmContacts.fields} || excluded.fields`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: crmContacts.id });
    return { contactId: rows[0]!.id };
  });
}

export interface UpsertOpportunityInput {
  contactId: string;
  conversationId?: string;
  title: string;
  stage: string;
  status: string;
  score?: number;
  value?: number;
  externalId?: string;
}

/** Upsert idempotente por (tenant, contact) — um deal por contato no built-in. */
export async function upsertOpportunity(
  input: UpsertOpportunityInput,
): Promise<{ opportunityId: string }> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .insert(opportunities)
      .values({
        tenantId,
        contactId: input.contactId,
        conversationId: input.conversationId ?? null,
        title: input.title,
        stage: input.stage,
        status: input.status,
        score: input.score ?? null,
        value: input.value ?? null,
        externalId: input.externalId ?? null,
      })
      .onConflictDoUpdate({
        target: [opportunities.tenantId, opportunities.contactId],
        set: {
          title: input.title,
          stage: input.stage,
          status: input.status,
          score: input.score ?? null,
          // preserva rastreabilidade/externalId já gravados se o novo vier vazio.
          conversationId: sql`coalesce(excluded.conversation_id, ${opportunities.conversationId})`,
          externalId: sql`coalesce(excluded.external_id, ${opportunities.externalId})`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: opportunities.id });
    return { opportunityId: rows[0]!.id };
  });
}

export async function addActivity(input: {
  contactId: string;
  kind: string;
  body: string;
}): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx.insert(activities).values({
      tenantId,
      contactId: input.contactId,
      kind: input.kind,
      body: input.body,
    });
  });
}

// ── Agendamento (built-in) ────────────────────────────────────

export interface CreateAppointmentInput {
  conversationId?: string;
  idempotencyKey: string;
  whenText?: string;
  startsAt?: Date;
  details: string;
  status?: string;
  externalId?: string;
  /** Agenda do pool onde a reserva caiu (0036); definida quando o evento vence. */
  calendarId?: string;
}

/** Cria o agendamento; idempotente por (tenant, idempotency_key). */
export async function createAppointment(
  input: CreateAppointmentInput,
): Promise<{ appointmentId: string; created: boolean; calendarId: string | null }> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const inserted = await tx
      .insert(appointments)
      .values({
        tenantId,
        conversationId: input.conversationId ?? null,
        idempotencyKey: input.idempotencyKey,
        whenText: input.whenText ?? null,
        startsAt: input.startsAt ?? null,
        details: input.details,
        status: input.status ?? "requested",
        externalId: input.externalId ?? null,
        calendarId: input.calendarId ?? null,
      })
      .onConflictDoNothing({ target: [appointments.tenantId, appointments.idempotencyKey] })
      .returning({ id: appointments.id, calendarId: appointments.calendarId });
    if (inserted[0]) {
      return { appointmentId: inserted[0].id, created: true, calendarId: inserted[0].calendarId };
    }
    const existing = await tx
      .select({ id: appointments.id, calendarId: appointments.calendarId })
      .from(appointments)
      .where(
        and(
          eq(appointments.tenantId, tenantId),
          eq(appointments.idempotencyKey, input.idempotencyKey),
        ),
      );
    return { appointmentId: existing[0]!.id, created: false, calendarId: existing[0]!.calendarId };
  });
}

/** Atualiza o status de um agendamento (ex.: 'cancelled' na remarcação). */
export async function setAppointmentStatus(id: string, status: string): Promise<boolean> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .update(appointments)
      .set({ status })
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, id)))
      .returning({ id: appointments.id });
    return rows.length > 0;
  });
}

/** Grava em qual agenda do pool a reserva caiu (0036) — após o evento vencer. */
export async function setAppointmentCalendar(id: string, calendarId: string): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant((tx) =>
    tx
      .update(appointments)
      .set({ calendarId })
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, id))),
  );
}

// ── Notificações (built-in) ───────────────────────────────────

/** Cria a notificação; idempotente por chave (dispara uma vez). */
export async function createNotification(input: {
  idempotencyKey: string;
  kind: string;
  title: string;
  body: string;
}): Promise<{ created: boolean }> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const inserted = await tx
      .insert(notifications)
      .values({
        tenantId,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        title: input.title,
        body: input.body,
      })
      .onConflictDoNothing({ target: [notifications.tenantId, notifications.idempotencyKey] })
      .returning({ id: notifications.id });
    return { created: inserted.length > 0 };
  });
}

// ── Mapa de sync com CRM (idempotência) ───────────────────────

export interface CrmSyncRow {
  conversationId: string;
  crmAdapter: string;
  contactExternalId: string | null;
  opportunityExternalId: string | null;
  status: string;
}

export async function getCrmSync(conversationId: string): Promise<CrmSyncRow | null> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx
      .select({
        conversationId: crmExternalSync.conversationId,
        crmAdapter: crmExternalSync.crmAdapter,
        contactExternalId: crmExternalSync.contactExternalId,
        opportunityExternalId: crmExternalSync.opportunityExternalId,
        status: crmExternalSync.status,
      })
      .from(crmExternalSync)
      .where(
        and(
          eq(crmExternalSync.tenantId, tenantId),
          eq(crmExternalSync.conversationId, conversationId),
        ),
      );
    return rows[0] ?? null;
  });
}

export async function upsertCrmSync(input: {
  conversationId: string;
  crmAdapter: string;
  contactExternalId?: string;
  opportunityExternalId?: string;
  status: string;
  lastError?: string;
}): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .insert(crmExternalSync)
      .values({
        tenantId,
        conversationId: input.conversationId,
        crmAdapter: input.crmAdapter,
        contactExternalId: input.contactExternalId ?? null,
        opportunityExternalId: input.opportunityExternalId ?? null,
        status: input.status,
        lastError: input.lastError ?? null,
      })
      .onConflictDoUpdate({
        target: [crmExternalSync.tenantId, crmExternalSync.conversationId],
        set: {
          crmAdapter: input.crmAdapter,
          // PRESERVA os IDs externos já gravados: uma falha sem IDs não pode
          // apagar um sync anterior bem-sucedido.
          contactExternalId: sql`coalesce(excluded.contact_external_id, ${crmExternalSync.contactExternalId})`,
          opportunityExternalId: sql`coalesce(excluded.opportunity_external_id, ${crmExternalSync.opportunityExternalId})`,
          status: input.status,
          lastError: input.lastError ?? null,
          updatedAt: new Date(),
        },
      });
  });
}
