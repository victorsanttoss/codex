import { Injectable, Logger } from "@nestjs/common";
import { requireTenantContext } from "@sdr/core";
import {
  createImobAssignment,
  createNotification,
  enqueueOutbox,
  getActiveImobAssignment,
  getImobAssignmentJoined,
  expireImobAssignment,
  getImobBrokerMode,
  getLeadProfile,
  isUniqueViolation,
  listImobBrokerCandidates,
  listImobBrokers,
  listImobPriorBrokerIds,
  recordImobEvent,
  type ImobBrokerCandidate,
} from "@sdr/db";
import { IMOB_CONFIG } from "./imob.config";
import { buildOfferMessage, leadDisplayName } from "./imob-messages";
import { safeErrorFields } from "../observability/logger";

export interface DistributeResult {
  assignmentId: string | null;
  brokerId: string | null;
  reason?: "already_active" | "no_broker" | "max_attempts" | "no_candidates";
}

/**
 * MOTOR DE DISTRIBUIÇÃO (v1): filtra por região + capacidade diária e roda
 * round-robin (quem está há mais tempo sem receber, recebe). Score de
 * performance entra na v2, quando houver histórico de conversão.
 *
 * Chamado no handoff do agente (LeadOutcomeService) e nas redistribuições
 * (recusa do corretor / SLA de aceite vencido, via worker).
 */
@Injectable()
export class ImobDistributionService {
  private readonly logger = new Logger(ImobDistributionService.name);

  /**
   * Entrada pelo desfecho do turno (handoff). Nunca lança — o turno do lead já
   * terminou e a resposta já foi enviada; falha aqui vira log + evento.
   */
  async onHandoff(
    conversationId: string,
    options: { retryOnFailure?: boolean } = {},
  ): Promise<void> {
    try {
      // Vertical "ligada" = tenant tem corretor cadastrado (mesmo arquivado).
      // Tenants de outras verticais fazem handoff sem nenhum ruído imobiliário.
      const brokers = await listImobBrokers({ includeArchived: true });
      if (brokers.length === 0) return;

      if (await getActiveImobAssignment(conversationId)) return;

      await recordImobEvent({ conversationId, type: "qualified" });
      await this.distribute(conversationId, {
        attempt: 1,
        ...(options.retryOnFailure ? { retryOnFailure: true } : {}),
      });
    } catch (err) {
      this.logger.error({
        event: "imob_handoff_distribution_failed",
        conversationId,
        error: safeErrorFields(err),
      });
      if (options.retryOnFailure) throw err;
    }
  }

  /** Redistribui após recusa/expiração. `priorAttempt` = rodada que falhou. */
  async redistribute(
    conversationId: string,
    priorAttempt: number,
  ): Promise<DistributeResult> {
    const attempt = priorAttempt + 1;
    if (attempt > IMOB_CONFIG.maxAttempts) {
      await this.exhausted(conversationId, "max_attempts", {
        attempt: priorAttempt,
      });
      return { assignmentId: null, brokerId: null, reason: "max_attempts" };
    }
    return this.distribute(conversationId, { attempt });
  }

  /**
   * Redistribuição FAIL-SAFE (achado Codex): a atribuição anterior já virou
   * expired/declined — se a nova oferta falhar aqui, o lead ficaria órfão em
   * silêncio (o scheduler não o revisita). Erro inesperado vira alerta
   * idempotente ao gestor + evento; o painel mostra o lead sem atribuição.
   */
  async redistributeSafely(
    conversationId: string,
    priorAttempt: number,
  ): Promise<void> {
    try {
      await this.redistribute(conversationId, priorAttempt);
    } catch (err) {
      this.logger.error(
        `Redistribuição falhou (conv ${conversationId}): ${err instanceof Error ? err.message : err}`,
      );
      await recordImobEvent({
        conversationId,
        type: "alert",
        metadata: { reason: "redistribute_failed", priorAttempt },
      }).catch(() => undefined);
      await createNotification({
        idempotencyKey: `imob:redistribute-failed:${conversationId}:${priorAttempt + 1}`,
        kind: "handoff",
        title: "Redistribuição de lead FALHOU",
        body: `Lead ${conversationId} ficou sem corretor após falha na redistribuição — intervir manualmente (distribuição manual no painel).`,
      }).catch(() => undefined);
    }
  }

  /** Distribui o lead para o melhor corretor elegível. Idempotente por lead ativo. */
  async distribute(
    conversationId: string,
    opts: { attempt: number; retryOnFailure?: boolean },
  ): Promise<DistributeResult> {
    requireTenantContext(); // fail-fast fora de contexto de tenant

    const active = await getActiveImobAssignment(conversationId);
    if (active)
      return {
        assignmentId: active.id,
        brokerId: active.brokerId,
        reason: "already_active",
      };

    const exclude = new Set(await listImobPriorBrokerIds(conversationId));
    const candidates = await listImobBrokerCandidates();
    if (candidates.length === 0) {
      await this.exhausted(
        conversationId,
        "no_candidates",
        { attempt: opts.attempt },
        opts,
      );
      return { assignmentId: null, brokerId: null, reason: "no_candidates" };
    }

    const region = await this.leadRegion(conversationId);

    const fila = rankBrokers(candidates, { region, exclude });
    if (fila.length === 0) {
      await this.exhausted(
        conversationId,
        "no_broker",
        { attempt: opts.attempt, region },
        opts,
      );
      return { assignmentId: null, brokerId: null, reason: "no_broker" };
    }

    // Modo lido UMA vez e GRAVADO na atribuição: oferta, ficha e aceite usam o
    // mesmo modo mesmo se o admin trocar a config no meio (achado Codex).
    const mode = await getImobBrokerMode();

    // Tenta a fila em ordem: violação de "oferta pendente por corretor" (0038,
    // corrida entre distribuições) pula para o próximo; "lead já ativo" retorna.
    for (const broker of fila) {
      const expiresAt = new Date(
        Date.now() + IMOB_CONFIG.acceptSlaMinutes * 60_000,
      );
      let assignment;
      try {
        assignment = await createImobAssignment({
          conversationId,
          brokerId: broker.id,
          attempt: opts.attempt,
          expiresAt,
          mode,
        });
      } catch (err) {
        if (isUniqueViolation(err, "imob_assignments_one_active_per_conv")) {
          const current = await getActiveImobAssignment(conversationId);
          return {
            assignmentId: current?.id ?? null,
            brokerId: current?.brokerId ?? null,
            reason: "already_active",
          };
        }
        if (
          isUniqueViolation(
            err,
            "imob_assignments_one_pending_accept_per_broker",
          )
        ) {
          continue; // corretor acabou de receber outra oferta — próximo da fila
        }
        throw err;
      }

      // Ficha enviada FORA da criação: se o enqueue falhar, COMPENSA expirando a
      // atribuição recém-criada (achado Codex — senão o lead fica preso numa
      // oferta que o corretor nunca recebeu, até o SLA vencer).
      try {
        const joined = await getImobAssignmentJoined(assignment.id);
        const leadName = leadDisplayName(
          joined?.leadFields ?? null,
          joined?.contactName ?? null,
        );
        // modo workspace: a FICHA vai SEM telefone — o corretor só recebe o
        // contato do lead pela plataforma (link chega no aceite)
        const ficha = buildOfferMessage({
          brokerName: broker.name,
          projectName: IMOB_CONFIG.projectName,
          leadName,
          leadPhone:
            mode === "workspace" ? null : (joined?.contactPhone ?? null),
          fields: joined?.leadFields ?? {},
          score: joined?.leadScore ?? null,
          attempt: opts.attempt,
          slaMinutes: IMOB_CONFIG.acceptSlaMinutes,
        });
        await enqueueOutbox({
          toPhone: broker.whatsapp,
          kind: "free_form",
          payload: { text: ficha },
          idempotencyKey: `imob:offer:${assignment.id}`,
          clientMessageId: `imob-offer-${assignment.id}`,
          billing: "service",
        });
      } catch (err) {
        this.logger.error(
          `Enqueue da ficha falhou (assignment ${assignment.id}) — compensando: ${err instanceof Error ? err.message : err}`,
        );
        await expireImobAssignment(assignment.id).catch(() => undefined);
        await recordImobEvent({
          conversationId,
          assignmentId: assignment.id,
          brokerId: broker.id,
          type: "alert",
          metadata: { reason: "offer_send_failed", attempt: opts.attempt },
        }).catch(() => undefined);
        throw err;
      }

      await recordImobEvent({
        conversationId,
        assignmentId: assignment.id,
        brokerId: broker.id,
        type: "offered",
        metadata: {
          attempt: opts.attempt,
          expiresAt: expiresAt.toISOString(),
          region,
        },
      });

      this.logger.log(
        `Lead ${conversationId} distribuído p/ corretor ${broker.name} (tentativa ${opts.attempt}).`,
      );
      return { assignmentId: assignment.id, brokerId: broker.id };
    }

    // fila inteira com oferta pendente (corrida extrema) → trata como sem corretor
    await this.exhausted(
      conversationId,
      "no_broker",
      { attempt: opts.attempt, region },
      opts,
    );
    return { assignmentId: null, brokerId: null, reason: "no_broker" };
  }

  /** Região qualificada do lead (campo 'regiao'), se houver. */
  private async leadRegion(conversationId: string): Promise<string | null> {
    const lead = await getLeadProfile(conversationId).catch(() => null);
    const r = lead?.fields?.regiao;
    return typeof r === "string" && r.trim() ? r.trim() : null;
  }

  /** Sem corretor disponível / rodadas esgotadas → evento + alerta ao gestor. */
  private async exhausted(
    conversationId: string,
    reason: string,
    metadata: Record<string, unknown>,
    options: { retryOnFailure?: boolean } = {},
  ): Promise<void> {
    await recordImobEvent({
      conversationId,
      type: "exhausted",
      metadata: { reason, ...metadata },
    });
    await createNotification({
      idempotencyKey: `imob:exhausted:${conversationId}:${reason}`,
      kind: "handoff",
      title: "Lead qualificado SEM corretor",
      body:
        reason === "max_attempts"
          ? `Lead ${conversationId} esgotou as rodadas de distribuição — intervir manualmente.`
          : `Lead ${conversationId} sem corretor elegível (${reason}) — verificar cadastro/capacidade dos corretores.`,
    }).catch((err) => {
      this.logger.warn({
        event: "imob_exhausted_notification_failed",
        conversationId,
        error: safeErrorFields(err),
      });
      // O executor durável precisa observar a falha para repetir este efeito.
      // Redistribuição e callers sem journal mantêm o comportamento fail-safe.
      if (options.retryOnFailure) throw err;
    });
  }
}

/**
 * Ordenação da fila (pura, testável): elegível = capacidade livre + fora da
 * exclusão + (sem região OU região casa com a do lead). Se o filtro de região
 * zerar a lista, cai para os demais elegíveis (atender > especializar).
 * Ordem: sem oferta pendente primeiro (0038 só permite 1 pendente por
 * corretor), depois round-robin — menor `lastOfferedAt` (nunca ofertado vence).
 */
export function rankBrokers(
  candidates: ImobBrokerCandidate[],
  opts: { region: string | null; exclude: Set<string> },
): ImobBrokerCandidate[] {
  const base = candidates.filter(
    (c) => !opts.exclude.has(c.id) && c.offeredToday < c.dailyCapacity,
  );
  const matchRegion = (c: ImobBrokerCandidate): boolean => {
    if (!opts.region || c.regions.length === 0) return true;
    const lead = opts.region.toLowerCase();
    return c.regions.some((r) => {
      const rr = r.toLowerCase();
      return lead.includes(rr) || rr.includes(lead);
    });
  };
  const regional = base.filter(matchRegion);
  const pool = regional.length > 0 ? regional : base;
  return pool.sort((a, b) => {
    const pa = a.pendingAccept > 0 ? 1 : 0;
    const pb = b.pendingAccept > 0 ? 1 : 0;
    if (pa !== pb) return pa - pb;
    const ta = a.lastOfferedAt ? new Date(a.lastOfferedAt).getTime() : 0;
    const tb = b.lastOfferedAt ? new Date(b.lastOfferedAt).getTime() : 0;
    return ta - tb;
  });
}
