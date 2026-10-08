import { and, eq } from "drizzle-orm";
import { requireTenantContext, type SecretsCrypto } from "@sdr/core";
import { withTenant } from "./client";
import { baileysSessions } from "./schema";

/**
 * Store CIFRADO do auth state do Baileys (creds + signal keys), por número, sob
 * RLS. Mesma envelope encryption dos segredos; o AAD `tenantId:baileys_session:
 * phone` amarra o ciphertext ao tenant+número (impede transplantar o blob).
 * NUNCA loga o conteúdo. Permite reconectar sem novo QR após restart.
 */
export class BaileysSessionStore {
  constructor(private readonly crypto: SecretsCrypto) {}

  private aad(tenantId: string, phoneNumberId: string): string {
    return `${tenantId}:baileys_session:${phoneNumberId}`;
  }

  async save(phoneNumberId: string, plaintext: string): Promise<void> {
    const { tenantId } = requireTenantContext();
    const enc = this.crypto.encrypt(plaintext, this.aad(tenantId, phoneNumberId));
    const row = {
      ciphertext: enc.ciphertext.toString("base64"),
      nonce: enc.nonce.toString("base64"),
      keyVersion: enc.keyVersion,
      updatedAt: new Date(),
    };
    await withTenant(async (tx) => {
      await tx
        .insert(baileysSessions)
        .values({ tenantId, phoneNumberId, ...row })
        .onConflictDoUpdate({
          target: [baileysSessions.tenantId, baileysSessions.phoneNumberId],
          set: row,
        });
    });
  }

  async get(phoneNumberId: string): Promise<string | null> {
    const { tenantId } = requireTenantContext();
    return withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(baileysSessions)
        .where(and(eq(baileysSessions.tenantId, tenantId), eq(baileysSessions.phoneNumberId, phoneNumberId)));
      const row = rows[0];
      if (!row) return null;
      return this.crypto
        .decrypt(
          {
            ciphertext: Buffer.from(row.ciphertext, "base64"),
            nonce: Buffer.from(row.nonce, "base64"),
            keyVersion: row.keyVersion,
          },
          this.aad(tenantId, phoneNumberId),
        )
        .toString("utf8");
    });
  }

  /** Apaga a sessão (ex.: logout/sessão inválida → exige novo pareamento). */
  async clear(phoneNumberId: string): Promise<void> {
    const { tenantId } = requireTenantContext();
    await withTenant(async (tx) => {
      await tx
        .delete(baileysSessions)
        .where(and(eq(baileysSessions.tenantId, tenantId), eq(baileysSessions.phoneNumberId, phoneNumberId)));
    });
  }
}
