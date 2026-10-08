import { describe, expect, it } from "vitest";
import { isDisguisedNumericHost, isPrivateOrReservedIp } from "./ssrf";

describe("isPrivateOrReservedIp", () => {
  it("classifica IPv4 privado/reservado/metadata", () => {
    for (const ip of [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1", // CGNAT
      "100.127.255.255",
      "127.0.0.1",
      "169.254.169.254", // metadata de nuvem
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.168.1.1",
      "198.18.0.1", // benchmarking
      "224.0.0.1", // multicast
      "255.255.255.255", // broadcast
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it("aceita IPv4 público", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.255.255", "198.20.0.1"]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false);
    }
  });

  it("classifica IPv6 privado/reservado (loopback, ULA, link-local, mapeado v4)", () => {
    for (const ip of [
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "febf::1",
      "::ffff:127.0.0.1", // IPv4-mapeado loopback
      "::ffff:169.254.169.254", // IPv4-mapeado metadata
      // Forma HEX do IPv4-mapeado (o URL/getaddrinfo normaliza ::ffff:127.0.0.1
      // para ::ffff:7f00:1) — bypass encontrado pelo Codex, agora coberto.
      "::ffff:7f00:1", // = 127.0.0.1
      "::ffff:a9fe:a9fe", // = 169.254.169.254 (metadata)
      "::ffff:a00:1", // = 10.0.0.1 (RFC1918)
      "::7f00:1", // IPv4-compat ::127.0.0.1 em hex
      "::ffff:0:7f00:1", // IPv4-translated → 127.0.0.1
      "64:ff9b::7f00:1", // NAT64 → 127.0.0.1
      "64:ff9b::a9fe:a9fe", // NAT64 → 169.254.169.254 (metadata)
      "2002:7f00:1::", // 6to4 com IPv4 embutido 127.0.0.1
      "2002:a9fe:a9fe::", // 6to4 → 169.254.169.254
      "2001:0000::7f00:1", // Teredo (bloqueado por precaução)
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it("aceita IPv6 público", () => {
    for (const ip of [
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8",
      "::ffff:808:808", // = 8.8.8.8 em hex (mapeado público)
      "64:ff9b::808:808", // NAT64 → 8.8.8.8 (público, liberado)
      "2002:808:808::", // 6to4 → 8.8.8.8 (público)
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false);
    }
  });

  it("não classifica não-IP (papel do guard de string)", () => {
    expect(isPrivateOrReservedIp("crm.example.com")).toBe(false);
    expect(isPrivateOrReservedIp("2130706433")).toBe(false); // é o guard de hostname que pega
  });
});

describe("isDisguisedNumericHost", () => {
  it("detecta formatos numéricos disfarçados", () => {
    for (const h of ["2130706433", "0x7f000001", "0x7f.0.0.1", "0177.0.0.1", "127.1", "127.0.1", "192.168.257.1"]) {
      expect(isDisguisedNumericHost(h), h).toBe(true);
    }
  });

  it("NÃO marca hostnames/IPs padrão", () => {
    for (const h of ["crm.example.com", "example.com", "api-2.crm.io", "127.0.0.1", "8.8.8.8", "::1"]) {
      expect(isDisguisedNumericHost(h), h).toBe(false);
    }
  });
});
