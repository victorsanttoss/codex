import { and, eq } from "drizzle-orm";
import {
  EnvelopeCipher,
  requireTenantContext,
  type SecretsCrypto,
  type SecretsStore,
  type TenantSecretKind,
} from "@sdr/core";
import { loadConfig } from "@sdr/config";
import { withTenant } from "./client";
import { tenantSecrets } from "./schema";

/**
 * SecretsStore com persistência sob RLS. O AAD é DERIVADO e OBRIGATÓRIO
 * (contrato #5 da revisão do Codex): `tenantId:kind` é a identidade natural
 * de cada segredo (há unique(tenant_id, kind)), então amarrar o ciphertext a
 * ela impede transplantar o blob entre tenants/kinds sem detecção.
 */

export function makeCipherFromEnv(): SecretsCrypto {
  const cfg = loadConfig();
  return EnvelopeCipher.fromBase64(cfg.secrets.keks, cfg.secrets.activeVersion);
}

function aadFor(tenantId: string, kind: TenantSecretKind): string {
  return `${tenantId}:${kind}`;
}

/**
 * Cache in-process de segredos DECIFRADOS por (tenantId, kind), com TTL curto.
 * Motivo (perf): o segredo era relido + decifrado do Postgres a CADA chamada
 * (até ~10×/turno entre LLM/embeddings/sender). Write-through em put/delete;
 * entre instâncias a invalidação é só pelo TTL (staleness máx. ~60s, aceitável
 * para chaves de API). Cacheia também o "não tem" (null) — o fallback de chave
 * (embedding_api_key → llm_api_key) consulta ausências toda hora.
 */
const SECRETS_CACHE_TTL_MS = 60_000;
/**
 * Teto de entradas do cache (LRU): com 1000+ tenants × vários kinds o Map global
 * crescia sem limite (cada get insere, inclusive ausências). O Map preserva a
 * ordem de INSERÇÃO, então a "mais antiga" é a 1ª chave — evictada ao estourar o
 * teto. A semântica de invalidação (write-through em put/delete) NÃO muda; o LRU
 * só limita memória. Reinserir a chave (set) a reposiciona como mais recente.
 */
const SECRETS_CACHE_MAX = 5_000;
const secretsCache = new Map<string, { value: string | null; expiresAt: number }>();

function cacheKey(tenantId: string, kind: TenantSecretKind): string {
  return `${tenantId}:${kind}`;
}

/** Grava no cache respeitando o teto LRU (evicta a entrada mais antiga). */
function cacheSet(key: string, entry: { value: string | null; expiresAt: number }): void {
  // recência: apaga+reinsere para levar a chave ao fim da ordem de iteração.
  secretsCache.delete(key);
  secretsCache.set(key, entry);
  while (secretsCache.size > SECRETS_CACHE_MAX) {
    const oldest = secretsCache.keys().next().value;
    if (oldest === undefined) break;
    secretsCache.delete(oldest);
  }
}

/** Limpa o cache de segredos (uso em testes/rotação manual). */
export function clearTenantSecretsCache(): void {
  secretsCache.clear();
}

export class TenantSecretsStore implements SecretsStore {
  constructor(
    private readonly crypto: SecretsCrypto,
    private readonly cacheTtlMs: number = SECRETS_CACHE_TTL_MS,
  ) {}

  async put(kind: TenantSecretKind, plaintext: string): Promise<void> {
    const { tenantId } = requireTenantContext();
    const enc = this.crypto.encrypt(plaintext, aadFor(tenantId, kind));
    const row = {
      ciphertext: enc.ciphertext.toString("base64"),
      nonce: enc.nonce.toString("base64"),
      keyVersion: enc.keyVersion,
    };
    await withTenant(async (tx) => {
      await tx
        .insert(tenantSecrets)
        .values({ tenantId, kind, ...row })
        .onConflictDoUpdate({
          target: [tenantSecrets.tenantId, tenantSecrets.kind],
          set: row,
        });
    });
    // write-through: o novo valor vale imediatamente neste processo.
    cacheSet(cacheKey(tenantId, kind), {
      value: plaintext,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  /** Remove um segredo do tenant ativo (ex.: revogação de conexão). */
  async delete(kind: TenantSecretKind): Promise<void> {
    const { tenantId } = requireTenantContext();
    await withTenant(async (tx) => {
      await tx
        .delete(tenantSecrets)
        .where(and(eq(tenantSecrets.tenantId, tenantId), eq(tenantSecrets.kind, kind)));
    });
    secretsCache.delete(cacheKey(tenantId, kind));
  }

  async get(kind: TenantSecretKind): Promise<string | null> {
    const { tenantId } = requireTenantContext();
    const hit = secretsCache.get(cacheKey(tenantId, kind));
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await this.readAndDecrypt(tenantId, kind);
    cacheSet(cacheKey(tenantId, kind), {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return value;
  }

  private async readAndDecrypt(
    tenantId: string,
    kind: TenantSecretKind,
  ): Promise<string | null> {
    return withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(tenantSecrets)
        .where(and(eq(tenantSecrets.tenantId, tenantId), eq(tenantSecrets.kind, kind)));
      const row = rows[0];
      if (!row) return null;
      const plaintext = this.crypto.decrypt(
        {
          ciphertext: Buffer.from(row.ciphertext, "base64"),
          nonce: Buffer.from(row.nonce, "base64"),
          keyVersion: row.keyVersion,
        },
        aadFor(tenantId, kind),
      );
      return plaintext.toString("utf8");
    });
  }

  async rotateActiveTenant(): Promise<number> {
    const { tenantId } = requireTenantContext();
    return withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(tenantSecrets)
        .where(eq(tenantSecrets.tenantId, tenantId));
      let rotated = 0;
      for (const row of rows) {
        const rewrapped = this.crypto.rewrap(
          {
            ciphertext: Buffer.from(row.ciphertext, "base64"),
            nonce: Buffer.from(row.nonce, "base64"),
            keyVersion: row.keyVersion,
          },
          aadFor(tenantId, row.kind),
        );
        if (rewrapped.keyVersion !== row.keyVersion) {
          await tx
            .update(tenantSecrets)
            .set({
              ciphertext: rewrapped.ciphertext.toString("base64"),
              nonce: rewrapped.nonce.toString("base64"),
              keyVersion: rewrapped.keyVersion,
            })
            .where(eq(tenantSecrets.id, row.id));
          rotated++;
        }
      }
      return rotated;
    });
  }
}
