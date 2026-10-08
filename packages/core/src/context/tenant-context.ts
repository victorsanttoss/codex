import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Contexto de execução propagado por request HTTP e por job da fila.
 * É a fonte de verdade do `tenant_id` que vira `SET LOCAL app.tenant_id`
 * na camada de dados. Acesso tenant-scoped é o padrão; o caminho "system"
 * (cross-tenant/anônimo) é EXPLÍCITO.
 *
 * O store é um OBJETO MUTÁVEL por design: o entrypoint HTTP envolve a
 * requisição inteira em `runWithRequestContext()` (um único storage.run) e o
 * guard de autenticação preenche o tenant depois, via `assignTenant()`. Isso
 * evita a armadilha do `enterWith` em guards (o handler herdaria o contexto
 * anterior). Para jobs/uso explícito, use runWithTenant/runAsSystem.
 */

export interface RequestContext {
  /** Ausente enquanto anônimo/system. */
  tenantId?: string;
  userId?: string;
  requestId?: string;
  conversationKey?: string;
  /** true = caminho system/anônimo (sem tenant ativo). */
  system: boolean;
  /** Justificativa do caminho system (auditoria). */
  reason?: string;
}

/** Visão de um contexto com tenant garantido (retorno de requireTenantContext). */
export interface TenantContext {
  tenantId: string;
  userId?: string;
  requestId?: string;
  conversationKey?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Executa `fn` com um contexto de TENANT ativo (jobs / uso explícito). */
export function runWithTenant<T>(
  input: { tenantId: string; userId?: string; requestId?: string; conversationKey?: string },
  fn: () => T,
): T {
  return storage.run({ ...input, system: false }, fn);
}

/** Executa `fn` no caminho system (cross-tenant/anônimo) — sempre com motivo. */
export function runAsSystem<T>(reason: string, fn: () => T, requestId?: string): T {
  const ctx: RequestContext =
    requestId === undefined
      ? { system: true, reason }
      : { system: true, reason, requestId };
  return storage.run(ctx, fn);
}

/**
 * Entrypoint HTTP: envolve a requisição inteira num único storage.run com um
 * store mutável (inicialmente anônimo). O guard preenche o tenant via
 * `assignTenant()` e a mutação fica visível para handler + services.
 */
export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return storage.run({ system: true, reason: "http-request", requestId }, fn);
}

/** Preenche o tenant no contexto ATUAL (chamado pelo guard após autenticar). */
export function assignTenant(input: { tenantId: string; userId?: string }): void {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new MissingTenantContextError(
      "assignTenant chamado fora de um contexto de requisição.",
    );
  }
  ctx.tenantId = input.tenantId;
  if (input.userId !== undefined) ctx.userId = input.userId;
  else delete ctx.userId;
  ctx.system = false;
  delete ctx.reason;
}

/** Contexto atual (ou undefined fora de qualquer escopo). */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Exige um contexto de TENANT. Lança se estiver fora de contexto, no caminho
 * system, ou sem tenant — guard que impede acesso a dados sem tenant por engano.
 */
export function requireTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new MissingTenantContextError(
      "Nenhum contexto ativo. Toda operação de dados precisa de runWithTenant() ou de uma requisição autenticada.",
    );
  }
  if (ctx.system || !ctx.tenantId) {
    throw new MissingTenantContextError(
      "Operação tenant-scoped chamada sem tenant ativo (caminho 'system'). Use o repositório de sistema explícito.",
    );
  }
  return {
    tenantId: ctx.tenantId,
    ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
    ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}),
    ...(ctx.conversationKey !== undefined ? { conversationKey: ctx.conversationKey } : {}),
  };
}

/**
 * Campos NÃO-identitários que podem ser sobrescritos (ex.: anexar
 * conversationKey num job). tenantId/userId são deliberadamente intransferíveis.
 */
export type ContextOverridableFields = Pick<RequestContext, "conversationKey" | "requestId">;

export function withContextOverrides<T>(
  overrides: Partial<ContextOverridableFields>,
  fn: () => T,
): T {
  const current = requireTenantContext();
  const next: RequestContext = { tenantId: current.tenantId, system: false };
  if (current.userId !== undefined) next.userId = current.userId;
  const requestId = overrides.requestId ?? current.requestId;
  if (requestId !== undefined) next.requestId = requestId;
  const conversationKey = overrides.conversationKey ?? current.conversationKey;
  if (conversationKey !== undefined) next.conversationKey = conversationKey;
  return storage.run(next, fn);
}

export class MissingTenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingTenantContextError";
  }
}
