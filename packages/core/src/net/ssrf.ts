import net from "node:net";

/**
 * Classificador anti-SSRF: decide se um IP/hostname aponta para uma faixa
 * PRIVADA/RESERVADA (loopback, RFC1918, link-local, CGNAT, metadata de nuvem
 * etc.). É a barreira que — combinada ao pin de IP no fetch — impede que o
 * `httpBaseURL` do CRM (dado NÃO-confiável do tenant) alcance a rede interna via
 * DNS rebinding, IP em decimal/hex/octal ou faixas reservadas menos óbvias.
 *
 * Regra: FAIL-CLOSED nos formatos que conseguimos entender; o que não é IP não é
 * classificado aqui (o guard de string trata hostnames disfarçados separadamente).
 */

/** Converte um IPv4 dotted-quad padrão em inteiro 32-bit (ou null se inválido). */
function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

/** CIDRs IPv4 bloqueados (privado/reservado/metadata) — inclui as faixas do pentest. */
const V4_BLOCKED_CIDRS: ReadonlyArray<readonly [number, number]> = [
  ["0.0.0.0", 8], // "this network" / 0/8
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT (RFC6598)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local / metadata de nuvem (169.254.169.254)
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking (RFC2544)
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservado (inclui 255.255.255.255 broadcast)
].map(([base, bits]) => [ipv4ToInt(base as string)!, bits as number] as const);

/** O IPv4 (dotted-quad padrão) cai em faixa privada/reservada? */
export function isPrivateOrReservedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return V4_BLOCKED_CIDRS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  });
}

/** Expande um IPv6 VÁLIDO (sem IPv4 embutido) para 16 bytes. */
function ipv6ToBytes(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  const halves = ip.split("::");
  const parse = (part: string): number[] =>
    part
      .split(":")
      .filter((x) => x !== "")
      .flatMap((h) => {
        const v = parseInt(h, 16);
        return [(v >> 8) & 0xff, v & 0xff];
      });
  if (halves.length === 1) {
    const bytes = parse(halves[0]!);
    return bytes.length === 16 ? bytes : null;
  }
  if (halves.length === 2) {
    const head = parse(halves[0]!);
    const tail = parse(halves[1]!);
    const midLen = 16 - head.length - tail.length;
    if (midLen < 0) return null;
    return [...head, ...new Array<number>(midLen).fill(0), ...tail];
  }
  return null;
}

/** O IPv6 cai em faixa privada/reservada (loopback, ULA, link-local, mapeado v4)? */
export function isPrivateOrReservedIPv6(ip: string): boolean {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%"); // remove a zona (ex.: fe80::1%eth0)
  if (pct >= 0) s = s.slice(0, pct);
  // IPv4-mapeado/compat na forma DOTTED (::ffff:127.0.0.1, ::127.0.0.1).
  const mapped = /^(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/i.exec(s);
  if (mapped) return isPrivateOrReservedIPv4(mapped[1]!);
  const bytes = ipv6ToBytes(s);
  if (!bytes) return false;
  const dotted = (a: number, b: number, c: number, d: number): string =>
    `${bytes[a]}.${bytes[b]}.${bytes[c]}.${bytes[d]}`;
  const firstFifteenZero = bytes.slice(0, 15).every((b) => b === 0);
  if (firstFifteenZero && (bytes[15] === 0 || bytes[15] === 1)) return true; // :: e ::1

  // FORMAS QUE EMBUTEM/DERIVAM UM IPv4 (achado Codex — várias fugiam do regex de
  // dotted). O `URL`/getaddrinfo normaliza o v4 para hex, então classificamos os
  // últimos 4 bytes como IPv4 sempre que o prefixo for uma dessas traduções:
  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  const first8Zero = bytes.slice(0, 8).every((b) => b === 0);
  // IPv4-mapeado ::ffff:0:0/96 e IPv4-compat ::/96 (últimos 4 = v4).
  if (first10Zero && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))) {
    return isPrivateOrReservedIPv4(dotted(12, 13, 14, 15));
  }
  // IPv4-translated ::ffff:0:a.b.c.d (RFC — bytes[8..9]=0xffff, resto do head zero).
  if (first8Zero && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) {
    return isPrivateOrReservedIPv4(dotted(12, 13, 14, 15));
  }
  // NAT64 well-known 64:ff9b::/96 (e 64:ff9b:1::/48) — v4 nos últimos 4 bytes.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isPrivateOrReservedIPv4(dotted(12, 13, 14, 15));
  }
  // 6to4 2002::/16 — o IPv4 público do túnel está em bytes[2..5]; classifica.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateOrReservedIPv4(dotted(2, 3, 4, 5));
  }
  // Teredo 2001:0000::/32 — endpoint arbitrário/ofuscado: BLOQUEIA por precaução
  // (um CRM legítimo não usa Teredo).
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;

  const b0 = bytes[0]!;
  if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 (ULA)
  if (b0 === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10 (link-local)
  return false;
}

/** Classifica QUALQUER IP (v4/v6). Não-IP → false (não é papel desta função). */
export function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateOrReservedIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateOrReservedIPv6(ip);
  return false;
}

/**
 * Hostname NUMÉRICO "disfarçado": não é um IP dotted-quad/IPv6 padrão, mas o
 * `getaddrinfo` o interpreta como IPv4 (ex.: decimal `2130706433` = 127.0.0.1,
 * hex `0x7f000001`, octal `0177.0.0.1`, forma curta `127.1`). Esses formatos
 * fogem do guard de string simples, então são REJEITADOS de imediato. IPs
 * literais padrão (net.isIP) NÃO são "disfarçados" — passam pela validação de
 * faixa normalmente.
 */
export function isDisguisedNumericHost(host: string): boolean {
  const h = host.trim();
  if (!h) return false;
  if (net.isIPv4(h) || net.isIPv6(h)) return false; // literal padrão → validado por faixa
  if (/^\d+$/.test(h)) return true; // decimal puro (ex.: 2130706433)
  if (/^0x[0-9a-f.]+$/i.test(h)) return true; // hex (ex.: 0x7f000001 / 0x7f.0.0.1)
  // dotted composto só por dígitos/hex/octal com algum componente não-padrão
  // (octal com zero à esquerda, hex, octeto > 255 ou forma curta) → disfarce.
  if (/^[0-9a-fx.]+$/i.test(h) && h.includes(".")) {
    const parts = h.split(".");
    if (parts.length !== 4) return true; // 127.1, 127.0.1 etc. (não é dotted-quad)
    return parts.some(
      (p) => p === "" || /^0[0-9]+$/.test(p) || /^0x/i.test(p) || /[a-f]/i.test(p) || Number(p) > 255,
    );
  }
  return false;
}
