import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { SecretsCrypto } from "./secrets-store";

/**
 * Envelope encryption para credenciais de tenant.
 *
 *  - DEK (Data Encryption Key) aleatória POR REGISTRO encripta o segredo.
 *  - A DEK é "embrulhada" (wrap) por uma KEK de ambiente, versionada.
 *  - Tudo AES-256-GCM (autenticado). AAD vincula o ciphertext ao registro
 *    (ex.: tenant + kind), impedindo troca de blobs entre linhas/tenants.
 *
 * Blob persistido em `ciphertext` (auto-descritivo, com versão de formato):
 *   [ ver(1) | dekNonce(12) | wrappedDek(32) | dekTag(16) | dataTag(16) | dataCiphertext(N) ]
 * A coluna `nonce` guarda o nonce dos DADOS; `key_version` a versão da KEK.
 */

const ALGO = "aes-256-gcm";
const FORMAT_VERSION = 1;
const VER_BYTES = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
const KEK_BYTES = 32;

// Offsets fixos no blob.
const OFF_VER = 0;
const OFF_DEK_NONCE = OFF_VER + VER_BYTES;
const OFF_WRAPPED_DEK = OFF_DEK_NONCE + NONCE_BYTES;
const OFF_DEK_TAG = OFF_WRAPPED_DEK + DEK_BYTES;
const OFF_DATA_TAG = OFF_DEK_TAG + TAG_BYTES;
const OFF_DATA_CT = OFF_DATA_TAG + TAG_BYTES;
const MIN_BLOB_BYTES = OFF_DATA_CT; // 77: header completo, antes do ciphertext de dados

export interface EncryptedSecret {
  /** Blob auto-descritivo (ver layout acima). */
  ciphertext: Buffer;
  /** Nonce da camada de dados (coluna `nonce`). */
  nonce: Buffer;
  /** Versão da KEK usada no wrap da DEK (coluna `key_version`). */
  keyVersion: number;
}

export interface EnvelopeKeys {
  /** versão -> KEK de 32 bytes. */
  keks: ReadonlyMap<number, Buffer>;
  activeVersion: number;
}

interface ParsedBlob {
  version: number;
  dekNonce: Buffer;
  wrappedDek: Buffer;
  dekTag: Buffer;
  dataTag: Buffer;
  dataCiphertext: Buffer;
}

export class EnvelopeCipher implements SecretsCrypto {
  private readonly keks: ReadonlyMap<number, Buffer>;
  private readonly activeVersion: number;

  constructor(keys: EnvelopeKeys) {
    for (const [version, kek] of keys.keks) {
      if (kek.length !== KEK_BYTES) {
        throw new Error(`KEK v${version} deve ter ${KEK_BYTES} bytes (tem ${kek.length}).`);
      }
    }
    if (!keys.keks.has(keys.activeVersion)) {
      throw new Error(`KEK ativa v${keys.activeVersion} ausente.`);
    }
    this.keks = keys.keks;
    this.activeVersion = keys.activeVersion;
  }

  /** Carrega KEKs em base64 a partir de um mapa string->base64. */
  static fromBase64(
    keksB64: Record<string, string>,
    activeVersion: number,
  ): EnvelopeCipher {
    const keks = new Map<number, Buffer>();
    for (const [version, b64] of Object.entries(keksB64)) {
      keks.set(Number(version), Buffer.from(b64, "base64"));
    }
    return new EnvelopeCipher({ keks, activeVersion });
  }

  encrypt(plaintext: string | Buffer, aad?: string): EncryptedSecret {
    const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    const aadBuf = aad ? Buffer.from(aad, "utf8") : undefined;

    // 1) DEK aleatória encripta os dados.
    const dek = randomBytes(DEK_BYTES);
    try {
      const dataNonce = randomBytes(NONCE_BYTES);
      const dataCipher = createCipheriv(ALGO, dek, dataNonce);
      if (aadBuf) dataCipher.setAAD(aadBuf);
      const dataCiphertext = Buffer.concat([dataCipher.update(data), dataCipher.final()]);
      const dataTag = dataCipher.getAuthTag();

      // 2) KEK ativa embrulha a DEK.
      const { wrappedDek, dekNonce, dekTag } = this.wrapDek(dek, this.activeVersion, aadBuf);

      const ciphertext = this.assemble({
        version: FORMAT_VERSION,
        dekNonce,
        wrappedDek,
        dekTag,
        dataTag,
        dataCiphertext,
      });
      return { ciphertext, nonce: dataNonce, keyVersion: this.activeVersion };
    } finally {
      dek.fill(0); // higiene: zera a DEK em memória
    }
  }

  decrypt(secret: EncryptedSecret, aad?: string): Buffer {
    const aadBuf = aad ? Buffer.from(aad, "utf8") : undefined;
    const blob = this.parse(secret.ciphertext);
    const dek = this.unwrapDek(blob, secret.keyVersion, aadBuf);
    try {
      const dataDecipher = createDecipheriv(ALGO, dek, secret.nonce);
      if (aadBuf) dataDecipher.setAAD(aadBuf);
      dataDecipher.setAuthTag(blob.dataTag);
      return Buffer.concat([
        dataDecipher.update(blob.dataCiphertext),
        dataDecipher.final(),
      ]);
    } finally {
      dek.fill(0);
    }
  }

  /**
   * ROTAÇÃO: troca SOMENTE o envelope da DEK (unwrap com a KEK antiga, wrap
   * com a KEK ativa). O plaintext do segredo NUNCA é decifrado nem exposto;
   * dataNonce/dataTag/dataCiphertext são preservados.
   */
  rewrap(secret: EncryptedSecret, aad?: string): EncryptedSecret {
    if (secret.keyVersion === this.activeVersion) return secret; // nada a fazer
    const aadBuf = aad ? Buffer.from(aad, "utf8") : undefined;
    const blob = this.parse(secret.ciphertext);
    const dek = this.unwrapDek(blob, secret.keyVersion, aadBuf);
    try {
      const rewrapped = this.wrapDek(dek, this.activeVersion, aadBuf);
      const ciphertext = this.assemble({
        version: FORMAT_VERSION,
        dekNonce: rewrapped.dekNonce,
        wrappedDek: rewrapped.wrappedDek,
        dekTag: rewrapped.dekTag,
        dataTag: blob.dataTag,
        dataCiphertext: blob.dataCiphertext,
      });
      return { ciphertext, nonce: secret.nonce, keyVersion: this.activeVersion };
    } finally {
      dek.fill(0);
    }
  }

  get currentVersion(): number {
    return this.activeVersion;
  }

  // ── internos ────────────────────────────────────────────────

  private wrapDek(
    dek: Buffer,
    version: number,
    aadBuf: Buffer | undefined,
  ): { wrappedDek: Buffer; dekNonce: Buffer; dekTag: Buffer } {
    const kek = this.kek(version);
    const dekNonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGO, kek, dekNonce);
    if (aadBuf) cipher.setAAD(aadBuf);
    const wrappedDek = Buffer.concat([cipher.update(dek), cipher.final()]);
    return { wrappedDek, dekNonce, dekTag: cipher.getAuthTag() };
  }

  private unwrapDek(blob: ParsedBlob, version: number, aadBuf: Buffer | undefined): Buffer {
    const kek = this.kek(version);
    const decipher = createDecipheriv(ALGO, kek, blob.dekNonce);
    if (aadBuf) decipher.setAAD(aadBuf);
    decipher.setAuthTag(blob.dekTag);
    return Buffer.concat([decipher.update(blob.wrappedDek), decipher.final()]);
  }

  private assemble(b: ParsedBlob): Buffer {
    return Buffer.concat([
      Buffer.from([b.version]),
      b.dekNonce,
      b.wrappedDek,
      b.dekTag,
      b.dataTag,
      b.dataCiphertext,
    ]);
  }

  private parse(blob: Buffer): ParsedBlob {
    if (blob.length < MIN_BLOB_BYTES) {
      throw new Error(`Blob de ciphertext truncado: ${blob.length} < ${MIN_BLOB_BYTES} bytes.`);
    }
    const version = blob.readUInt8(OFF_VER);
    if (version !== FORMAT_VERSION) {
      throw new Error(`Versão de formato não suportada: ${version}.`);
    }
    return {
      version,
      dekNonce: blob.subarray(OFF_DEK_NONCE, OFF_WRAPPED_DEK),
      wrappedDek: blob.subarray(OFF_WRAPPED_DEK, OFF_DEK_TAG),
      dekTag: blob.subarray(OFF_DEK_TAG, OFF_DATA_TAG),
      dataTag: blob.subarray(OFF_DATA_TAG, OFF_DATA_CT),
      dataCiphertext: blob.subarray(OFF_DATA_CT),
    };
  }

  private kek(version: number): Buffer {
    const kek = this.keks.get(version);
    if (!kek) throw new Error(`KEK v${version} não está carregada — não é possível decifrar.`);
    return kek;
  }
}

/** Comparação constante para tokens/segredos (evita timing attack). */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
