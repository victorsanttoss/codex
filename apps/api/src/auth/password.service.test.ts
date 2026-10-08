import { describe, expect, it } from "vitest";
import { PasswordService } from "./password.service";

describe("PasswordService (argon2id)", () => {
  const svc = new PasswordService();

  it("hash não contém a senha em claro e verifica corretamente", async () => {
    const hash = await svc.hash("senha-super-secreta");
    expect(hash).not.toContain("senha-super-secreta");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await svc.verify(hash, "senha-super-secreta")).toBe(true);
  });

  it("rejeita senha errada", async () => {
    const hash = await svc.hash("certa");
    expect(await svc.verify(hash, "errada")).toBe(false);
  });

  it("verify não lança com hash malformado", async () => {
    expect(await svc.verify("nao-e-hash", "x")).toBe(false);
  });
});
