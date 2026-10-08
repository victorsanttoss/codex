import { createHash } from "node:crypto";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { requireTenantContext } from "@sdr/core";
import { CrmService } from "./crm.service";
import { CrmSyncQueue } from "./crm-sync.queue";
import { ImobDistributionService } from "../imobiliario/imob-distribution.service";

export interface TurnOutcome {
  conversationId: string;
  phone: string;
  name?: string;
  fields: Record<string, unknown>;
  stage: string;
  status: string; // qualified | handoff | disqualified | new | scheduled
  score?: number;
  handoff: boolean;
  handoffReason?: string;
  scheduling?: { when?: string; details: string };
  /** Reserva REAL feita pela SDR (0034) — notifica o time do novo agendamento. */
  booked?: {
    appointmentId: string;
    label: string;
    googleMirrored: boolean | null;
    rebooked: boolean;
  };
}

export interface OutcomeJournal {
  completed(key: string): boolean;
  checkpoint(key: string): Promise<void>;
  assertLease(): Promise<void>;
  permitted?(key: string): Promise<boolean>;
}

/**
 * Facade chamada pelo agente ao FIM do turno: persiste/integra os desfechos
 * estruturados — agendamento e notificação INLINE (rápidos, idempotentes) e o
 * sync com o CRM via fila (retry). Tudo no contexto do tenant.
 */
@Injectable()
export class LeadOutcomeService {
  private readonly logger = new Logger(LeadOutcomeService.name);

  constructor(
    private readonly crm: CrmService,
    private readonly queue: CrmSyncQueue,
    // Vertical imobiliária (fork): distribui p/ corretor no handoff. @Optional
    // preserva construções manuais de teste com 2 args.
    @Optional() private readonly imobDistribution?: ImobDistributionService,
  ) {}

  async onTurnEnd(o: TurnOutcome, journal?: OutcomeJournal): Promise<void> {
    const { tenantId } = requireTenantContext();
    const effect = async (key: string, execute: () => Promise<void>) => {
      if (journal?.completed(key)) return;
      await journal?.assertLease();
      if (journal?.permitted && !(await journal.permitted(key))) {
        await journal.checkpoint(`suppressed.${key}`);
        await journal.checkpoint(key);
        return;
      }
      await execute();
      await journal?.checkpoint(key);
    };

    if (o.scheduling) {
      const scheduling = o.scheduling;
      await effect("scheduling", async () => {
        const sched = await this.crm.schedulingForTenant();
        const key = `${o.conversationId}:sched:${shortHash(scheduling.details + (scheduling.when ?? ""))}`;
        await sched.createAppointment({
          idempotencyKey: key,
          conversationId: o.conversationId,
          details: scheduling.details,
          ...(scheduling.when !== undefined ? { when: scheduling.when } : {}),
        });
      });
    }

    if (o.handoff) {
      await effect("handoff_notification", async () => {
        const notif = await this.crm.notificationForTenant();
        await notif.notify({
          idempotencyKey: `${o.conversationId}:handoff`,
          kind: "handoff",
          title: "Lead para atendimento humano",
          body: o.handoffReason ?? `Lead ${o.status} (score ${o.score ?? 0}).`,
        });
      });
      // Vertical imobiliária: handoff = distribuir p/ corretor parceiro.
      // O journal exige erro propagado para permitir retry; outros callers mantêm fail-safe.
      if (this.imobDistribution) {
        await effect("imob_distribution", () =>
          this.imobDistribution!.onHandoff(o.conversationId, {
            retryOnFailure: !!journal,
          }),
        );
      }
    }

    // Reserva REAL da SDR (0034): avisa o time. Idempotente por appointment —
    // remarcação (novo appointment) gera notificação nova de propósito.
    if (o.booked) {
      const booked = o.booked;
      await effect("booking_notification", async () => {
        const notif = await this.crm.notificationForTenant();
        const warn =
          booked.googleMirrored === false
            ? " ATENÇÃO: não consegui espelhar na agenda Google — confira a agenda da plataforma."
            : "";
        await notif.notify({
          idempotencyKey: `${o.conversationId}:appointment:${booked.appointmentId}`,
          kind: "appointment",
          title: booked.rebooked
            ? "Agendamento remarcado pela SDR"
            : "Novo agendamento pela SDR",
          body: `${booked.label}.${warn}`,
        });
      });
    }

    if (
      o.status === "qualified" ||
      o.status === "handoff" ||
      o.status === "scheduled"
    ) {
      await effect("crm_sync", async () => {
        await this.queue.enqueueSync({
          tenantId,
          conversationId: o.conversationId,
          phone: o.phone,
          ...(o.name !== undefined ? { name: o.name } : {}),
          fields: o.fields,
          stage: o.stage,
          status: o.status,
          ...(o.score !== undefined ? { score: o.score } : {}),
        });
        this.logger.log(
          `Sync de lead ${o.conversationId} enfileirado (${o.status}).`,
        );
      });
    }
  }
}

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}
