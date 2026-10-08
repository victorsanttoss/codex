import { sql } from "drizzle-orm";
import { getDb } from "./client";

/**
 * Registro de AUDITORIA de operações sensíveis (caminho system / plataforma).
 * A tabela `audit_log` tem `tenant_id` NULLABLE (eventos de plataforma não têm
 * tenant). Append-only: nunca atualizamos/apagamos linhas — é a trilha imutável
 * que atribui cada ação de curadoria ao staff que a executou (M14).
 */
export interface AuditEntry {
  /** Quem executou — id do platform_staff (ou 'platform-admin' no bootstrap). */
  actor: string;
  /** O que foi feito — ex.: 'curation.approve', 'curation.promote'. */
  action: string;
  /** Alvo da ação — ex.: id do candidato. */
  target?: string;
  /** Tenant afetado, quando houver (curadoria é por-nicho: normalmente ausente). */
  tenantId?: string;
  /** Contexto extra (nicheId, email do staff, etc.). */
  metadata?: Record<string, unknown>;
}

export async function insertAuditLog(entry: AuditEntry): Promise<void> {
  await getDb().transaction(async (tx) => {
    // Eventos de plataforma (sem tenant) precisam da flag que abre a policy
    // `platform_audit` (0026); a role `app` é NOBYPASSRLS. Transaction-local.
    if (entry.tenantId == null) {
      await tx.execute(sql`select set_config('app.platform_audit', 'on', true)`);
    }
    await tx.execute(sql`
      INSERT INTO audit_log (tenant_id, actor, action, target, metadata)
      VALUES (
        ${entry.tenantId ?? null},
        ${entry.actor},
        ${entry.action},
        ${entry.target ?? null},
        ${JSON.stringify(entry.metadata ?? {})}::jsonb
      )
    `);
  });
}
