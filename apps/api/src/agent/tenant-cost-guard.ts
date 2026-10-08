import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS_CLIENT } from "../redis/redis.module";

/**
 * Teto de custo AGREGADO por tenant/dia, apoiado em contador Redis. Os guardrails
 * por-turno do agente não impedem um tenant de acumular custo ilimitado ao longo
 * do dia (loop de abuso, flood). Este guard corta o LLM quando o custo do dia
 * ultrapassa o teto.
 *
 * RESERVA ATÔMICA (achado Codex): a checagem NÃO pode ser GET-antes/INCRBY-depois
 * — inbounds paralelos do mesmo tenant leriam todos abaixo do teto e disparariam
 * o LLM antes de qualquer incremento (bypass por corrida). Em vez disso, RESERVA
 * o teto-por-turno via INCRBY ANTES do LLM: um único INCRBY atômico decide, e a
 * concorrência é serializada pelo Redis. Depois do turno, RECONCILIA para o custo
 * real. A reserva de um turno rejeitado NÃO é revertida (fail-closed: mantém o
 * tenant estourado — inflaciona no máximo `reserva × concorrência`, aceitável).
 *
 * O contador é fonte AUXILIAR (o `usage_events` no Postgres é a verdade de
 * billing). FAIL-OPEN: se o Redis cair, o guard LIBERA o atendimento (prioriza
 * disponibilidade; o billing real continua registrado no Postgres). Chave por dia
 * UTC; TTL de 2 dias para auto-limpar.
 */
@Injectable()
export class TenantCostGuard {
  private readonly logger = new Logger(TenantCostGuard.name);
  private static readonly KEY_TTL_S = 2 * 24 * 60 * 60; // 2 dias
  private static readonly NOTICE_TTL_S = 24 * 60 * 60; // 1 aviso canned por dia

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private dayKey(tenantId: string): string {
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    return `agentcost:${tenantId}:${day}`;
  }

  /**
   * RESERVA atômica de `reserveMicros` (o teto-por-turno: máximo que um turno pode
   * gastar) antes de chamar o LLM. Retorna `allowed=false` se, JÁ COM a reserva
   * somada, o total do dia passou do teto. FAIL-OPEN em erro de Redis (libera).
   */
  async reserve(
    tenantId: string,
    capMicros: number,
    reserveMicros: number,
  ): Promise<{ allowed: boolean; reserved: number }> {
    const reserved = Math.max(1, Math.round(reserveMicros));
    const key = this.dayKey(tenantId);
    try {
      const total = await this.redis.incrby(key, reserved);
      await this.redis.expire(key, TenantCostGuard.KEY_TTL_S);
      // Passou do teto COM a reserva → rejeita (a reserva fica: mantém estourado).
      return { allowed: total <= capMicros, reserved };
    } catch (err) {
      this.logger.error(
        `Redis indisponível no reserve (tenant ${tenantId}) — FAIL-OPEN (libera): ${
          err instanceof Error ? err.message : err
        }`,
      );
      return { allowed: true, reserved: 0 }; // reserved=0 → nada a reconciliar
    }
  }

  /**
   * RECONCILIA a reserva para o custo REAL do turno: soma `actual - reserved`
   * (pode ser negativo). Best-effort. Se não houve reserva (fail-open), apenas
   * soma o custo real como incremento simples.
   */
  async reconcile(tenantId: string, reservedMicros: number, actualMicros: number): Promise<void> {
    const delta = Math.round(actualMicros) - Math.round(reservedMicros);
    if (delta === 0) return;
    try {
      const key = this.dayKey(tenantId);
      await this.redis.incrby(key, delta);
      await this.redis.expire(key, TenantCostGuard.KEY_TTL_S);
    } catch (err) {
      this.logger.warn(
        `reconcile de custo falhou (tenant ${tenantId}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Soma um custo AVULSO ao contador do dia (ex.: resumo rolante, que roda fora do
   * turno principal mas também consome LLM — achado Codex). Best-effort.
   */
  async addCost(tenantId: string, micros: number): Promise<void> {
    if (!(micros > 0)) return;
    try {
      const key = this.dayKey(tenantId);
      await this.redis.incrby(key, Math.round(micros));
      await this.redis.expire(key, TenantCostGuard.KEY_TTL_S);
    } catch (err) {
      this.logger.warn(
        `addCost falhou (tenant ${tenantId}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Reivindica o direito de enviar a mensagem canned de contenção (SET NX): true
   * no máximo UMA vez por tenant por dia — evita spamar o lead a cada inbound
   * enquanto o tenant está estourado.
   */
  async claimContentionNotice(tenantId: string): Promise<boolean> {
    try {
      const r = await this.redis.set(
        `agentcost:notice:${tenantId}:${new Date().toISOString().slice(0, 10)}`,
        "1",
        "EX",
        TenantCostGuard.NOTICE_TTL_S,
        "NX",
      );
      return r === "OK";
    } catch {
      return false; // Redis fora → não spamar; o aviso é best-effort.
    }
  }
}
