/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  BaileysAuthState,
  BaileysConnection,
  BaileysDriver,
  BaileysOpenOptions,
} from "./driver";

/**
 * Driver REAL que embrulha `@whiskeysockets/baileys`. Import PREGUIÇOSO: a lib só
 * é carregada em produção, atrás da interface — testes nunca a tocam (injetam o
 * FakeBaileysDriver). O auth state é (de)serializado com `BufferJSON` da própria
 * lib e devolvido via evento `creds` para persistência cifrada externa (nunca em
 * disco/log). NÃO é exercitado por testes (requer WhatsApp Web/QR real).
 *
 * Pré-requisito de produção: `pnpm add @whiskeysockets/baileys` no app que roda
 * o session-worker. Sem o pacote, `open()` lança — esperado fora de produção.
 */
export class RealBaileysDriver implements BaileysDriver {
  async open(opts: BaileysOpenOptions): Promise<BaileysConnection> {
    // @ts-ignore — dependência opcional, resolvida só em produção.
    const mod: any = await import("@whiskeysockets/baileys").catch(() => {
      throw new Error(
        "RealBaileysDriver requer '@whiskeysockets/baileys' instalado (dependência opcional do session-worker).",
      );
    });
    const makeWASocket = mod.default ?? mod.makeWASocket;
    const { initAuthCreds, BufferJSON } = mod;

    // Persistência: `creds.update` E `keys.set` disparam a MESMA rota (evento
    // `creds` com o estado serializado). Sem persistir em keys.set, as signal
    // keys avançadas só em memória se perdem no restart → Bad MAC na
    // descriptografia. keys.set é frequente → debounce; creds.update é raro →
    // flush imediato (cancela o debounce pendente; serializa tudo, keys incluídas).
    const persistence = makeDebouncedPersist(() =>
      opts.onEvent({ type: "creds", authState: auth.serialize() }),
    );
    const auth = restoreAuth(opts.authState, initAuthCreds, BufferJSON, persistence.schedule);
    const sock = makeWASocket({ auth: auth.state, printQRInTerminal: false });

    sock.ev.on("creds.update", () => {
      persistence.flush();
    });

    sock.ev.on("connection.update", (u: any) => {
      if (u.qr) opts.onEvent({ type: "qr", qr: u.qr });
      if (u.connection === "open") opts.onEvent({ type: "connection", state: "open" });
      if (u.connection === "connecting") opts.onEvent({ type: "connection", state: "connecting" });
      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === mod.DisconnectReason?.loggedOut;
        opts.onEvent({
          type: "connection",
          state: loggedOut ? "logged_out" : "closed",
          ...(code ? { reason: String(code) } : {}),
        });
      }
    });

    sock.ev.on("messages.upsert", (up: any) => {
      // DIAGNÓSTICO: registra TUDO que o WhatsApp entrega (inclusive o que o
      // filtro descarta), para enxergar inbound perdido.
      try {
        const kinds = (up.messages ?? []).map(
          (mm: any) => `${mm.key?.fromMe ? "me" : "lead"}:${mm.message?.conversation ? "txt" : Object.keys(mm.message ?? {})[0] ?? "vazio"}`,
        );
        opts.onEvent({ type: "log", raw: { msg: `[baileys upsert] type=${up.type} n=${(up.messages ?? []).length} ${kinds.join(",")}` } } as any);
      } catch {
        /* diagnóstico best-effort */
      }
      if (up.type !== "notify") return;
      for (const m of up.messages ?? []) {
        const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text;
        const tsMs = Number(m.messageTimestamp) * 1000;
        const media = extractMedia(m.message);
        opts.onEvent({
          type: "message",
          raw: {
            id: m.key?.id ?? "",
            from: m.key?.remoteJid ?? "",
            fromMe: Boolean(m.key?.fromMe),
            ...(m.pushName ? { pushName: m.pushName } : {}),
            ...(Number.isFinite(tsMs) && tsMs > 0 ? { timestampMs: tsMs } : {}),
            ...(text ? { text } : {}),
            ...(media ? { media } : {}),
          },
        });
      }
    });

    sock.ev.on("messages.update", (updates: any[]) => {
      for (const u of updates ?? []) {
        const status = mapStatus(u.update?.status);
        if (status) opts.onEvent({ type: "status", raw: { id: u.key?.id ?? "", status, to: u.key?.remoteJid } });
      }
    });

    return {
      async sendText(toJid, text, opts) {
        // messageId determinístico → o WhatsApp deduplica reenvios (idempotência).
        const r = await sock.sendMessage(toJid, { text }, opts?.messageId ? { messageId: opts.messageId } : undefined);
        return { id: r?.key?.id ?? opts?.messageId ?? "" };
      },
      async logout() {
        persistence.flush(); // não perde keys pendentes do debounce
        await sock.logout();
      },
      async close() {
        persistence.flush(); // não perde keys pendentes do debounce
        sock.end(undefined);
      },
    };
  }
}

/**
 * Debounce da persistência de sessão (exportado p/ teste). `schedule` agenda um
 * flush em `delayMs` (writes seguintes na janela entram no mesmo flush — o
 * serialize lê o estado ATUAL); `flush` dispara imediatamente e cancela o timer.
 * ~1.5s equilibra durabilidade das signal keys × custo de cifrar/gravar por write.
 */
export function makeDebouncedPersist(
  persist: () => void,
  delayMs = 1_500,
): { schedule: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    persist();
  };
  const schedule = () => {
    if (timer) return; // já agendado — o flush levará o estado mais recente
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
  };
  return { schedule, flush };
}

/** Restaura o auth state; `onKeysMutated` é chamado a CADA keys.set (persistência). */
export function restoreAuth(
  serialized: BaileysAuthState | null,
  initAuthCreds: any,
  BufferJSON: any,
  onKeysMutated: () => void = () => {},
) {
  const creds = serialized
    ? JSON.parse(serialized as string, BufferJSON.reviver).creds
    : initAuthCreds();
  const keys = serialized ? JSON.parse(serialized as string, BufferJSON.reviver).keys ?? {} : {};
  const state = {
    creds,
    keys: {
      get: (type: string, ids: string[]) => {
        const data: Record<string, any> = {};
        for (const id of ids) data[id] = keys[`${type}-${id}`];
        return data;
      },
      set: (data: Record<string, Record<string, any>>) => {
        for (const type of Object.keys(data)) {
          for (const id of Object.keys(data[type]!)) keys[`${type}-${id}`] = data[type]![id];
        }
        // Signal keys avançam a cada mensagem — sem persistir aqui, restart
        // volta a keys velhas e a descriptografia falha (Bad MAC).
        onKeysMutated();
      },
    },
  };
  return {
    state,
    serialize: () => JSON.stringify({ creds, keys }, BufferJSON.replacer),
  };
}

function extractMedia(message: any): { type: string; id?: string; caption?: string } | null {
  if (!message) return null;
  for (const t of ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"]) {
    if (message[t]) return { type: t.replace("Message", ""), caption: message[t].caption };
  }
  return null;
}

function mapStatus(s: number | undefined): "sent" | "delivered" | "read" | "failed" | null {
  // enum do Baileys: 1 PENDING, 2 SERVER_ACK(sent), 3 DELIVERY_ACK(delivered), 4 READ, 5 PLAYED, 0 ERROR
  if (s === 2) return "sent";
  if (s === 3) return "delivered";
  if (s === 4 || s === 5) return "read";
  if (s === 0) return "failed";
  return null;
}
