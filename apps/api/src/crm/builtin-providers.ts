import type {
  AppointmentRequest,
  CrmActivity,
  CrmContact,
  CrmOpportunity,
  CrmProvider,
  HumanNotification,
  NotificationProvider,
  SchedulingProvider,
} from "@sdr/core";
import {
  addActivity,
  createAppointment,
  createNotification,
  upsertCrmContact,
  upsertOpportunity,
} from "@sdr/db";

/**
 * CRM BUILT-IN (default): grava nas tabelas internas tenant-scoped. O produto
 * funciona sem nenhum CRM externo. Roda no contexto do tenant (o caller garante).
 */
export class BuiltinCrmProvider implements CrmProvider {
  readonly id = "builtin";

  async upsertContact(contact: CrmContact): Promise<{ externalId: string }> {
    const { contactId } = await upsertCrmContact({
      phone: contact.phone,
      ...(contact.name !== undefined ? { name: contact.name } : {}),
      ...(contact.fields !== undefined ? { fields: contact.fields } : {}),
    });
    return { externalId: contactId };
  }

  async upsertOpportunity(opp: CrmOpportunity): Promise<{ externalId: string }> {
    const { opportunityId } = await upsertOpportunity({
      contactId: opp.contactExternalId,
      title: opp.title,
      stage: opp.stage,
      status: opp.status,
      ...(opp.conversationId !== undefined ? { conversationId: opp.conversationId } : {}),
      ...(opp.score !== undefined ? { score: opp.score } : {}),
      ...(opp.value !== undefined ? { value: opp.value } : {}),
    });
    return { externalId: opportunityId };
  }

  async addActivity(activity: CrmActivity): Promise<void> {
    await addActivity({ contactId: activity.contactExternalId, kind: activity.kind, body: activity.body });
  }
}

/** Agendamento built-in: persiste em `appointments` (idempotente pela chave). */
export class BuiltinSchedulingProvider implements SchedulingProvider {
  readonly id = "builtin";

  async createAppointment(req: AppointmentRequest): Promise<{ externalId: string }> {
    const { appointmentId } = await createAppointment({
      idempotencyKey: req.idempotencyKey,
      details: req.details,
      ...(req.conversationId !== undefined ? { conversationId: req.conversationId } : {}),
      ...(req.when !== undefined ? { whenText: req.when } : {}),
      ...(req.startsAt !== undefined ? { startsAt: new Date(req.startsAt) } : {}),
    });
    return { externalId: appointmentId };
  }
}

/** Notificação built-in: registra em `notifications` (idempotente pela chave). */
export class BuiltinNotificationProvider implements NotificationProvider {
  readonly id = "builtin";

  async notify(n: HumanNotification): Promise<void> {
    await createNotification({ idempotencyKey: n.idempotencyKey, kind: n.kind, title: n.title, body: n.body });
  }
}
