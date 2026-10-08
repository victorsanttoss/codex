import type { EncryptedSecret } from "./envelope";

/**
 * Seam de criptografia pluggable. Hoje implementado por `EnvelopeCipher`
 * (KEK em ambiente). Amanhã, uma implementação KMS pode substituí-lo
 * SEM tocar nos call sites — eles dependem desta interface, não da classe.
 */
export interface SecretsCrypto {
  encrypt(plaintext: string | Buffer, aad?: string): EncryptedSecret;
  decrypt(secret: EncryptedSecret, aad?: string): Buffer;
  /** Troca o envelope para a versão ativa da chave (rotação). */
  rewrap(secret: EncryptedSecret, aad?: string): EncryptedSecret;
  readonly currentVersion: number;
}

/** Tipos de credencial guardados por tenant (cresce em módulos futuros). */
export type TenantSecretKind =
  | "whatsapp_token"
  | "crm_api_key"
  | "llm_api_key"
  | "embedding_api_key"
  | "transcription_api_key";

/**
 * Porta de alto nível para guardar/recuperar credenciais de tenant.
 * A implementação (em `@sdr/db`) combina `SecretsCrypto` + persistência
 * com RLS. Call sites usam só esta interface.
 */
export interface SecretsStore {
  put(kind: TenantSecretKind, plaintext: string): Promise<void>;
  get(kind: TenantSecretKind): Promise<string | null>;
  /** Re-embrulha todos os segredos do tenant para a KEK ativa. Retorna nº rotacionado. */
  rotateActiveTenant(): Promise<number>;
}
