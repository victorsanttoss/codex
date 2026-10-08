import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { loadConfig } from "@sdr/config";
import { requireTenantContext } from "@sdr/core";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Camada de acesso a dados com isolamento por RLS.
 *
 *   - `withTenant(fn)`: abre transação e faz `SET LOCAL app.tenant_id` (via
 *     set_config local) ANTES de qualquer query — é o ÚNICO caminho para
 *     tocar tabelas tenant-scoped (contrato #4 da revisão do Codex).
 *   - `withUser(userId, fn)`: para o login (lê memberships do próprio usuário
 *     antes de haver tenant ativo).
 *   - `withSystem(fn)`: caminho explícito sem contexto de tenant — só tabelas
 *     de identidade (tenants/users) ou loops auditados por tenant. Tabelas
 *     tenant-scoped retornam vazio aqui (deny-by-default).
 */

interface AppClient {
  sql: postgres.Sql;
  db: Database;
}

let appClient: AppClient | undefined;

export function getDb(): Database {
  if (!appClient) {
    const cfg = loadConfig();
    const client = postgres(cfg.database.url, { max: 10, prepare: false });
    appClient = { sql: client, db: drizzle(client, { schema }) };
  }
  return appClient.db;
}

export async function closeDb(): Promise<void> {
  if (appClient) {
    await appClient.sql.end();
    appClient = undefined;
  }
}

/** Cliente com a role `migrator` (DDL/seed). NUNCA usado em runtime de request. */
export function makeMigrationClient(): AppClient {
  const cfg = loadConfig();
  const client = postgres(cfg.database.migrationUrl, { max: 1, prepare: false });
  return { sql: client, db: drizzle(client, { schema }) };
}

export interface TenantScope {
  tenantId: string;
  userId?: string;
}

export async function withTenant<T>(
  fn: (tx: Database) => Promise<T>,
  override?: TenantScope,
): Promise<T> {
  const scope = override ?? scopeFromContext();
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`);
    if (scope.userId) {
      await tx.execute(sql`select set_config('app.user_id', ${scope.userId}, true)`);
    }
    return fn(tx as unknown as Database);
  });
}

/** Para o login: enxerga as memberships do próprio usuário (sem tenant ativo). */
export async function withUser<T>(
  userId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx as unknown as Database);
  });
}

/** Caminho system explícito (identidade / cross-tenant auditado). */
export async function withSystem<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  return fn(getDb());
}

/**
 * Leitura da camada de NICHO (M9). Seta `app.niche_id` (resolvido NO SERVIDOR a
 * partir do tenant — o tenant não escolhe o nicho). A policy de `niche_knowledge`
 * libera SELECT por `niche_id`; a ESCRITA exige também `app.curation` (curadoria).
 */
export async function withNiche<T>(nicheId: string, fn: (tx: Database) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.niche_id', ${nicheId}, true)`);
    return fn(tx as unknown as Database);
  });
}

/**
 * Caminho de CURADORIA (plataforma). Seta `app.curation='on'` (libera os
 * `curation_candidates`, INVISÍVEIS a tenants) e `app.niche_id` (escrita em
 * `niche_knowledge` do nicho-alvo). NUNCA usado no caminho do tenant.
 */
export async function withCuration<T>(nicheId: string, fn: (tx: Database) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.curation', 'on', true)`);
    await tx.execute(sql`select set_config('app.niche_id', ${nicheId}, true)`);
    return fn(tx as unknown as Database);
  });
}

function scopeFromContext(): TenantScope {
  const ctx = requireTenantContext();
  return ctx.userId !== undefined
    ? { tenantId: ctx.tenantId, userId: ctx.userId }
    : { tenantId: ctx.tenantId };
}
