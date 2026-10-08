import type { CrmActivity, CrmContact, CrmOpportunity, CrmProvider } from "../crm-provider";
import type { AppointmentRequest, SchedulingProvider } from "../scheduling-provider";
import type { HumanNotification, NotificationProvider } from "../notification-provider";

/**
 * Adaptadores FAKE em memória para CRM/agendamento/notificação — exercitam os
 * contratos e os serviços sem rede real. Não são implementações de produção.
 */
export class FakeCrmProvider implements CrmProvider {
  readonly id = "fake-crm";
  readonly contacts = new Map<string, { externalId: string; contact: CrmContact }>();
  readonly opportunities: Array<CrmOpportunity & { externalId: string }> = [];
  readonly activities: CrmActivity[] = [];
  private seq = 0;

  async upsertContact(contact: CrmContact): Promise<{ externalId: string }> {
    const existing = this.contacts.get(contact.phone);
    if (existing) {
      existing.contact = contact;
      return { externalId: existing.externalId };
    }
    const externalId = `c-${++this.seq}`;
    this.contacts.set(contact.phone, { externalId, contact });
    return { externalId };
  }

  async upsertOpportunity(opp: CrmOpportunity): Promise<{ externalId: string }> {
    const found = this.opportunities.find((o) => o.contactExternalId === opp.contactExternalId);
    if (found) {
      Object.assign(found, opp);
      return { externalId: found.externalId };
    }
    const externalId = `o-${++this.seq}`;
    this.opportunities.push({ ...opp, externalId });
    return { externalId };
  }

  async addActivity(activity: CrmActivity): Promise<void> {
    this.activities.push(activity);
  }
}

export class FakeSchedulingProvider implements SchedulingProvider {
  readonly id = "fake-scheduling";
  readonly appointments = new Map<string, { externalId: string; req: AppointmentRequest }>();
  private seq = 0;

  async createAppointment(req: AppointmentRequest): Promise<{ externalId: string }> {
    const existing = this.appointments.get(req.idempotencyKey);
    if (existing) return { externalId: existing.externalId };
    const externalId = `a-${++this.seq}`;
    this.appointments.set(req.idempotencyKey, { externalId, req });
    return { externalId };
  }
}

export class FakeNotificationProvider implements NotificationProvider {
  readonly id = "fake-notification";
  readonly sent = new Map<string, HumanNotification>();

  async notify(n: HumanNotification): Promise<void> {
    if (this.sent.has(n.idempotencyKey)) return; // idempotente
    this.sent.set(n.idempotencyKey, n);
  }
}
