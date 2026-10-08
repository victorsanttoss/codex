import { describe, expect, it } from "vitest";
import { EnvelopeCipher } from "./envelope";

const KEK_V1 = Buffer.alloc(32, 1);
const KEK_V2 = Buffer.alloc(32, 2);

function cipher(active: number, ...versions: Array<[number, Buffer]>): EnvelopeCipher {
  return new EnvelopeCipher({ keks: new Map(versions), activeVersion: active });
}

describe("EnvelopeCipher", () => {
  it("faz roundtrip encrypt/decrypt do segredo", () => {
    const c = cipher(1, [1, KEK_V1]);
    const enc = c.encrypt("super-secreto-do-whatsapp");
    expect(enc.keyVersion).toBe(1);
    // ciphertext não pode conter o plaintext em claro
    expect(enc.ciphertext.toString("utf8")).not.toContain("super-secreto");
    expect(c.decrypt(enc).toString("utf8")).toBe("super-secreto-do-whatsapp");
  });

  it("rejeita ciphertext adulterado (GCM detecta)", () => {
    const c = cipher(1, [1, KEK_V1]);
    const enc = c.encrypt("token");
    enc.ciphertext[enc.ciphertext.length - 1] ^= 0xff; // flip de 1 bit
    expect(() => c.decrypt(enc)).toThrow();
  });

  it("vincula o segredo ao AAD (não decifra com AAD diferente)", () => {
    const c = cipher(1, [1, KEK_V1]);
    const enc = c.encrypt("token", "tenant-A:whatsapp_token");
    expect(c.decrypt(enc, "tenant-A:whatsapp_token").toString("utf8")).toBe("token");
    expect(() => c.decrypt(enc, "tenant-B:whatsapp_token")).toThrow();
  });

  it("ROTAÇÃO: rewrap migra o registro da KEK v1 para a v2 ativa", () => {
    const v1Only = cipher(1, [1, KEK_V1]);
    const enc1 = v1Only.encrypt("rotaciona-me", "aad");
    expect(enc1.keyVersion).toBe(1);

    // novo cifrador conhece v1 e v2, com v2 ativa
    const rotator = cipher(2, [1, KEK_V1], [2, KEK_V2]);
    const enc2 = rotator.rewrap(enc1, "aad");

    expect(enc2.keyVersion).toBe(2);
    expect(rotator.decrypt(enc2, "aad").toString("utf8")).toBe("rotaciona-me");
    // o registro antigo (v1) ainda é decifrável enquanto a KEK v1 existir
    expect(rotator.decrypt(enc1, "aad").toString("utf8")).toBe("rotaciona-me");

    // PROVA: a camada de DADOS não foi tocada — só o envelope da DEK mudou.
    expect(enc2.nonce.equals(enc1.nonce)).toBe(true); // dataNonce preservado
    const tail1 = enc1.ciphertext.subarray(1 + 12 + 32 + 16 + 16); // dataCiphertext
    const tail2 = enc2.ciphertext.subarray(1 + 12 + 32 + 16 + 16);
    expect(tail2.equals(tail1)).toBe(true);
  });

  it("rewrap em segredo já na versão ativa é no-op", () => {
    const c = cipher(2, [1, KEK_V1], [2, KEK_V2]);
    const enc = c.encrypt("x", "aad");
    expect(c.rewrap(enc, "aad")).toBe(enc);
  });

  it("falha ao decifrar se a versão da KEK não está carregada", () => {
    const v1Only = cipher(1, [1, KEK_V1]);
    const enc = v1Only.encrypt("x");
    const noKeys = cipher(2, [2, KEK_V2]); // não tem v1
    expect(() => noKeys.decrypt(enc)).toThrow(/KEK v1/);
  });

  it("recusa KEK de tamanho inválido", () => {
    expect(() => cipher(1, [1, Buffer.alloc(16, 9)])).toThrow(/32 bytes/);
  });
});
