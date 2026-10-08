/**
 * Ajustes do fluxo imobiliário. Env-tunável sem redeploy de config central —
 * defaults: aceite 5min, follow-up 24h, 3 rodadas de distribuição.
 */

function intEnv(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

export const IMOB_CONFIG = {
  /** Minutos para o corretor aceitar antes de expirar e redistribuir.
   *  Decisão Victor 12/08: 5 min (era 30) — lead quente não espera. */
  acceptSlaMinutes: intEnv("IMOB_ACCEPT_SLA_MINUTES", 5),
  /** Rodadas máximas de distribuição por lead (depois: alerta ao gestor). */
  maxAttempts: intEnv("IMOB_MAX_ATTEMPTS", 3),
  /** Horas sem update de estágio até o agente cobrar status do corretor. */
  followupInactivityHours: intEnv("IMOB_FOLLOWUP_HOURS", 24),
  /** Cobranças de status sem resposta até alertar o gestor. */
  maxFollowups: intEnv("IMOB_MAX_FOLLOWUPS", 3),
  /** Nome do empreendimento exibido nas fichas (piloto: um por tenant). */
  projectName: process.env.IMOB_PROJECT_NAME ?? "Parque das Flores",
} as const;
