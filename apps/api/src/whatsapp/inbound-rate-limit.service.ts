import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS_CLIENT } from "../redis/redis.module";

/**
 * Rate-limit por CONVERSA/número no inbound (achado pentest): um número que
 * inunda o webhook geraria um turno de LLM por mensagem. Aqui contamos as
 * mensagens processadas por `conversationKey` numa janela e DESCARTAMOS o excesso
 * silenciosamente (sem chamar o LLM), protegendo contra flood de um número.
 *
 * Limite FOLGADO (20/min) para não afetar tráfego legítimo — conversa humana
 * normal fica muito abaixo disto. Contador Redis (INCR + EXPIRE): barato e
 * consistente entre workers.
 */
@Injectable()
export class InboundRateLimitService {
  private static readonly WINDOW_S = 60;
  private static readonly MAX_PER_WINDOW = 20;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Registra 1 mensagem da conversa e diz se está DENTRO do limite. `false` →
   * o chamador deve descartar (excesso de flood). Fail-OPEN: erro de Redis não
   * pode derrubar o atendimento legítimo, então em falha liberamos.
   */
  async allow(conversationKey: string): Promise<boolean> {
    const key = `rl:inbound:${conversationKey}`;
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, InboundRateLimitService.WINDOW_S);
      return n <= InboundRateLimitService.MAX_PER_WINDOW;
    } catch {
      return true; // fail-open: não bloqueia tráfego por indisponibilidade do Redis
    }
  }
}
