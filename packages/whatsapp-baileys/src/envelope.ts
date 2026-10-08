import type { BaileysInboundRaw, BaileysStatusRaw } from "./driver";

export const BAILEYS_ADAPTER_KEY = "baileys";
const JID_SUFFIX = "@s.whatsapp.net";

/** JID do Baileys (`5511...@s.whatsapp.net`) → número cru (`5511...`). */
export function jidToPhone(jid: string): string {
  const at = jid.indexOf("@");
  const base = at >= 0 ? jid.slice(0, at) : jid;
  // grupos vêm como `...@g.us`; descartamos o sufixo de device (`:NN`) se houver.
  const colon = base.indexOf(":");
  return colon >= 0 ? base.slice(0, colon) : base;
}

/** Número cru → JID individual do WhatsApp. Idempotente: se já vier um JID
 * (contém `@`, ex.: `...@lid` ou `...@s.whatsapp.net`), usa como está — NÃO
 * reconstruir, senão um LID perderia o domínio e a entrega falharia. */
export function phoneToJid(phone: string): string {
  if (phone.includes("@")) return phone;
  const clean = phone.replace(/[^\d]/g, "");
  return `${clean}${JID_SUFFIX}`;
}

/**
 * Envelope canônico de INBOUND do Baileys. O session-worker serializa os eventos
 * do socket nisto e passa ao `normalizeInboundWebhook` — mesmo seam do Cloud
 * (rawBody), o que mantém o adaptador puro/testável sem socket.
 */
export interface BaileysInboundEnvelope {
  accountId: string;
  messages: BaileysInboundRaw[];
}

export interface BaileysStatusEnvelope {
  accountId: string;
  statuses: BaileysStatusRaw[];
}

export function buildInboundEnvelope(accountId: string, messages: BaileysInboundRaw[]): string {
  return JSON.stringify({ accountId, messages } satisfies BaileysInboundEnvelope);
}

export function buildStatusEnvelope(accountId: string, statuses: BaileysStatusRaw[]): string {
  return JSON.stringify({ accountId, statuses } satisfies BaileysStatusEnvelope);
}
