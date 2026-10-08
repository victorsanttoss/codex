import dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrmBlockedTargetError, makeGuardedFetchCrmHttp } from "./index";

/** Mocka dns.lookup(all:true) para devolver os endereços dados sem rede real. */
function mockLookup(addresses: Array<{ address: string; family: number }>) {
  return vi.spyOn(dns, "lookup").mockImplementation(((host: unknown, opts: unknown, cb: unknown) => {
    const callback = (typeof opts === "function" ? opts : cb) as (
      err: NodeJS.ErrnoException | null,
      addrs: Array<{ address: string; family: number }>,
    ) => void;
    callback(null, addresses);
  }) as unknown as typeof dns.lookup);
}

describe("makeGuardedFetchCrmHttp — anti-SSRF (2ª barreira, no fetch)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejeita protocolo não-https ANTES de qualquer conexão", async () => {
    const http = makeGuardedFetchCrmHttp(500);
    await expect(http.post("http://crm.example.com/contacts", {}, {})).rejects.toBeInstanceOf(
      CrmBlockedTargetError,
    );
  });

  it("rejeita hostname que RESOLVE para IP privado (defesa contra DNS rebinding)", async () => {
    mockLookup([{ address: "169.254.169.254", family: 4 }]); // metadata de nuvem
    const http = makeGuardedFetchCrmHttp(500);
    const err = await http
      .post("https://crm.evil.com/contacts", {}, {})
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmBlockedTargetError);
    expect((err as Error).message).toMatch(/169\.254\.169\.254/);
  });

  it("rejeita se QUALQUER dos IPs resolvidos for privado (não só o primeiro)", async () => {
    mockLookup([
      { address: "93.184.216.34", family: 4 }, // público
      { address: "10.0.0.5", family: 4 }, // privado → bloqueia
    ]);
    const http = makeGuardedFetchCrmHttp(500);
    await expect(http.post("https://crm.evil.com/contacts", {}, {})).rejects.toBeInstanceOf(
      CrmBlockedTargetError,
    );
  });

  it("IP público passa pelo guard (falha de conexão NÃO é bloqueio anti-SSRF)", async () => {
    mockLookup([{ address: "8.8.8.8", family: 4 }]); // público → guard aprova
    const http = makeGuardedFetchCrmHttp(800);
    const err = await http
      .post("https://crm.example.com/contacts", {}, {})
      .then(() => null)
      .catch((e: unknown) => e);
    // Sem rede/porta fechada vira erro de conexão/timeout — NUNCA bloqueio SSRF.
    expect(err).not.toBeInstanceOf(CrmBlockedTargetError);
  });
});
