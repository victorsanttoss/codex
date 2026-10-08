import {
  isCredentialStatus,
  LlmError,
  type CompletionRequest,
  type CompletionResult,
  type LLMProvider,
  type TokenUsage,
} from "@sdr/core";
import { costMicros, DEFAULT_PRICING, hasPrice, priceScore, type Pricing } from "./pricing";

/** Candidato de roteamento: um provedor + um modelo. */
export interface RouteCandidate {
  provider: LLMProvider;
  model: string;
}

export interface UsageInfo {
  providerId: string;
  model: string;
  usage: TokenUsage;
  costMicros: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  /** Teto do backoff por tentativa (evita latência/avalanche com config ruim). */
  maxDelayMs?: number;
}

export interface LlmRouterOptions {
  pricing?: Pricing;
  retry?: RetryPolicy;
  /** Hook de metering: chamado para o provedor que DE FATO respondeu. */
  onUsage?: (info: UsageInfo) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

export interface RouteOutcome extends CompletionResult {
  providerId: string;
  model: string;
  costMicros: number;
}

const DEFAULT_RETRY: Required<RetryPolicy> = { maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 5_000 };

/**
 * Roteador por CUSTO + FALLBACK. Recebe candidatos já adequados ao tier (a
 * seleção de adequação é do chamador); ordena por custo (mais barato primeiro);
 * transiente → retry/backoff no mesmo provedor; permanente/esgotado → próximo da
 * cadeia (inclusive cross-provider). Grava metering para quem respondeu.
 */
export class LlmRouter {
  private readonly pricing: Pricing;
  private readonly retry: Required<RetryPolicy>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  constructor(
    private readonly candidates: RouteCandidate[],
    private readonly opts: LlmRouterOptions = {},
  ) {
    if (candidates.length === 0) throw new Error("LlmRouter precisa de ao menos 1 candidato.");
    this.pricing = opts.pricing ?? DEFAULT_PRICING;
    this.retry = normalizeRetry(opts.retry);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.jitter = opts.jitter ?? Math.random;
    // FAIL-CLOSED: todo modelo roteado precisa ter preço (metering correto). Modelo
    // aberto/self-hosted entra no catálogo com {0,0} explícito.
    const unpriced = candidates.filter((c) => !hasPrice(c.model, this.pricing)).map((c) => c.model);
    if (unpriced.length) {
      throw new Error(`Modelo(s) sem preço no catálogo: ${[...new Set(unpriced)].join(", ")}.`);
    }
  }

  /** Candidatos ordenados do mais barato ao mais caro. */
  private ordered(): RouteCandidate[] {
    return [...this.candidates].sort(
      (a, b) => priceScore(a.model, this.pricing) - priceScore(b.model, this.pricing),
    );
  }

  async complete(req: Omit<CompletionRequest, "model">): Promise<RouteOutcome> {
    let lastErr: unknown;
    const attempts: string[] = [];
    // providerIds cuja CREDENCIAL falhou (401/403): pular outros modelos do mesmo
    // provedor — a chave é a mesma, repetir só desperdiça chamadas.
    const deadCreds = new Set<string>();
    for (const cand of this.ordered()) {
      if (deadCreds.has(cand.provider.id)) continue;
      try {
        const res = await this.withRetry(() =>
          cand.provider.complete({ ...req, model: cand.model }),
        );
        const cost = costMicros(cand.model, res.usage, this.pricing);
        await this.opts.onUsage?.({
          providerId: cand.provider.id,
          model: cand.model,
          usage: res.usage,
          costMicros: cost,
        });
        return { ...res, providerId: cand.provider.id, model: cand.model, costMicros: cost };
      } catch (err) {
        lastErr = err;
        attempts.push(`${cand.provider.id}/${cand.model}`);
        if (err instanceof LlmError && isCredentialStatus(err.status)) {
          deadCreds.add(cand.provider.id); // fallback só p/ outro provedor/credencial
        }
        // permanente ou transiente-esgotado: cai para o próximo candidato.
      }
    }
    // Erro final SANITIZADO: só categoria + lista de tentativas (sem msg crua do provider).
    const category = lastErr instanceof LlmError ? lastErr.message : "LLM: erro desconhecido";
    throw new LlmError(
      `Todos os provedores falharam (${attempts.join(", ")}): ${category}`,
      isTransient(lastErr),
      lastErr instanceof LlmError ? lastErr.status : undefined,
    );
  }

  /** Retry/backoff no MESMO provedor enquanto o erro for transiente. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await fn();
      } catch (err) {
        // permanente: não insiste no mesmo provedor (sem retry-storm) -> propaga p/ fallback.
        if (!isTransient(err) || attempt >= this.retry.maxAttempts) throw err;
        await this.sleep(this.backoffMs(attempt));
      }
    }
  }

  /** Exponential backoff com teto + full jitter proporcional (anti-avalanche). */
  private backoffMs(attempt: number): number {
    const base = Math.min(this.retry.baseDelayMs * 2 ** (attempt - 1), this.retry.maxDelayMs);
    return Math.floor(base * (0.5 + this.jitter() * 0.5));
  }
}

function normalizeRetry(p?: RetryPolicy): Required<RetryPolicy> {
  if (!p) return DEFAULT_RETRY;
  const maxAttempts = Number.isFinite(p.maxAttempts) ? Math.max(1, Math.floor(p.maxAttempts)) : 1;
  const baseDelayMs = Number.isFinite(p.baseDelayMs) ? Math.max(0, p.baseDelayMs) : 0;
  const maxDelayMs =
    p.maxDelayMs !== undefined && Number.isFinite(p.maxDelayMs)
      ? Math.max(baseDelayMs, p.maxDelayMs)
      : DEFAULT_RETRY.maxDelayMs;
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

function isTransient(err: unknown): boolean {
  return err instanceof LlmError ? err.transient : true; // desconhecido = transiente (tenta fallback)
}
