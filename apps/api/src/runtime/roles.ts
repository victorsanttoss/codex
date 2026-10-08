export type AppRole = "api" | "worker" | "scheduler" | "session-worker" | "all";

/** O processo serve HTTP (webhook + painel)? */
export function runsHttp(role: AppRole): boolean {
  return role === "api" || role === "all";
}

/** O processo consome filas (pipeline inbound, crm-sync, knowledge)? */
export function runsWorkers(role: AppRole): boolean {
  return role === "worker" || role === "all";
}

/** O processo roda cron/scans (cadência, outbox, token refresh, alertas)? */
export function runsScheduler(role: AppRole): boolean {
  return role === "scheduler" || role === "all";
}

/**
 * O processo é um SESSION-WORKER (M13)? Mantém sockets Baileys vivos por número
 * atribuído de forma fixa (sticky). STATEFUL — separado dos workers stateless;
 * `all` inclui para dev. Em prod, pool dedicado (cada número mora num worker).
 */
export function runsSessionWorker(role: AppRole): boolean {
  return role === "session-worker" || role === "all";
}
