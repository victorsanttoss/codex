import { eq, sql } from "drizzle-orm";
import { requireTenantContext } from "@sdr/core";
import { withTenant } from "./client";
import { tenantOnboarding } from "./schema";

export interface OnboardingState {
  step: number;
  payload: Record<string, unknown>;
  activatedAt: Date | null;
}

/** Lê o estado do onboarding do tenant (cria o default na 1ª leitura). */
export async function getOnboarding(): Promise<OnboardingState> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const rows = await tx.select().from(tenantOnboarding).where(eq(tenantOnboarding.tenantId, tenantId)).limit(1);
    const r = rows[0];
    if (!r) return { step: 1, payload: {}, activatedAt: null };
    return { step: r.step, payload: r.payload as Record<string, unknown>, activatedAt: r.activatedAt };
  });
}

/**
 * Autosave de uma etapa: mescla `patch` no payload e avança o passo. Idempotente
 * por tenant (upsert). Não regride o passo (mantém o maior já alcançado).
 */
export async function saveOnboarding(step: number, patch: Record<string, unknown>): Promise<OnboardingState> {
  const { tenantId } = requireTenantContext();
  return withTenant(async (tx) => {
    const [row] = await tx
      .insert(tenantOnboarding)
      .values({ tenantId, step, payload: patch, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: tenantOnboarding.tenantId,
        set: {
          step: sql`greatest(${tenantOnboarding.step}, ${step})`,
          payload: sql`${tenantOnboarding.payload} || ${JSON.stringify(patch)}::jsonb`,
          updatedAt: new Date(),
        },
      })
      .returning();
    return { step: row!.step, payload: row!.payload as Record<string, unknown>, activatedAt: row!.activatedAt };
  });
}

/** Marca a SDR como ativada (fim do wizard — última etapa; 10 no fork imob). */
const FINAL_STEP = 10;

export async function activateOnboarding(): Promise<void> {
  const { tenantId } = requireTenantContext();
  await withTenant(async (tx) => {
    await tx
      .insert(tenantOnboarding)
      .values({ tenantId, step: FINAL_STEP, activatedAt: new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: tenantOnboarding.tenantId,
        set: { step: FINAL_STEP, activatedAt: new Date(), updatedAt: new Date() },
      });
  });
}
