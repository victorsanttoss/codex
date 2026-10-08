/**
 * Interface INJETÁVEL do Baileys. O resto do código (adaptador, session-manager)
 * fala só com isto — nunca importa `@whiskeysockets/baileys` direto. Em teste,
 * injeta-se o `FakeBaileysDriver` (sem rede/WebSocket/QR real). Em produção, o
 * `RealBaileysDriver` (arquivo separado, import preguiçoso) embrulha a lib.
 */

/** Estado do auth do Baileys (creds + signal keys). Opaco aqui — só persistimos. */
export type BaileysAuthState = unknown;

/** Eventos que o socket emite, normalizados para um formato estreito e testável. */
export type BaileysEvent =
  | { type: "qr"; qr: string }
  | { type: "pairing_code"; code: string }
  | { type: "connection"; state: BaileysConnState; reason?: string }
  | { type: "creds"; authState: BaileysAuthState }
  | { type: "message"; raw: BaileysInboundRaw }
  | { type: "status"; raw: BaileysStatusRaw };

export type BaileysConnState = "connecting" | "open" | "closed" | "logged_out";

/** Mensagem inbound crua, no formato mínimo que o adaptador sabe normalizar. */
export interface BaileysInboundRaw {
  id: string;
  /** JID do remetente (ex.: 5511999999999@s.whatsapp.net). */
  from: string;
  fromMe?: boolean;
  pushName?: string;
  timestampMs?: number;
  text?: string;
  media?: { type: string; id?: string; caption?: string };
}

/** Receipt cru (entregue/lido) de uma mensagem outbound. */
export interface BaileysStatusRaw {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  to?: string;
}

/** Opções de envio. `messageId` torna o envio IDEMPOTENTE: o WhatsApp deduplica
 *  por id de mensagem, então reenviar o mesmo id após crash não entrega 2×. */
export interface BaileysSendOptions {
  messageId?: string;
}

/** Socket vivo de UM número. Stateful — pertence ao session-worker dono. */
export interface BaileysConnection {
  /** Envia texto para um JID; devolve o id da mensagem. `opts.messageId` → dedup. */
  sendText(toJid: string, text: string, opts?: BaileysSendOptions): Promise<{ id: string }>;
  /** Encerra a sessão no servidor (logout) — exige novo QR para reconectar. */
  logout(): Promise<void>;
  /** Fecha o socket localmente (shutdown gracioso), sem deslogar. */
  close(): Promise<void>;
}

export interface BaileysOpenOptions {
  /** Auth state persistido (null no primeiro pareamento → gera QR). */
  authState: BaileysAuthState | null;
  /** Recebe TODOS os eventos do socket (qr, connection, creds, message, status). */
  onEvent: (e: BaileysEvent) => void;
}

export interface BaileysDriver {
  /** Abre um socket para um número. O ciclo de vida é dirigido por `onEvent`. */
  open(opts: BaileysOpenOptions): Promise<BaileysConnection>;
}

// ── Fake p/ testes (sem rede): roteia eventos programados e captura envios ──

export class FakeBaileysConnection implements BaileysConnection {
  readonly sent: Array<{ toJid: string; text: string; messageId?: string }> = [];
  loggedOut = false;
  closed = false;
  private seq = 0;
  constructor(private readonly idPrefix = "BLZ") {}

  async sendText(toJid: string, text: string, opts?: BaileysSendOptions): Promise<{ id: string }> {
    if (this.loggedOut || this.closed) throw new Error("socket indisponível");
    this.sent.push({ toJid, text, ...(opts?.messageId ? { messageId: opts.messageId } : {}) });
    // Idempotência: se vier messageId, ecoa-o (o WhatsApp deduplica por id).
    return { id: opts?.messageId ?? `${this.idPrefix}-${++this.seq}` };
  }
  async logout(): Promise<void> {
    this.loggedOut = true;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Driver fake: cada `open()` devolve uma conexão controlável e expõe o `onEvent`
 * para o teste injetar QR/mensagens/quedas. Determinístico, sem rede.
 */
export class FakeBaileysDriver implements BaileysDriver {
  readonly opened: Array<{ conn: FakeBaileysConnection; emit: (e: BaileysEvent) => void }> = [];
  constructor(private readonly idPrefix = "BLZ") {}

  async open(opts: BaileysOpenOptions): Promise<BaileysConnection> {
    const conn = new FakeBaileysConnection(this.idPrefix);
    this.opened.push({ conn, emit: opts.onEvent });
    return conn;
  }

  /** Atalho de teste: emite no último socket aberto. */
  emit(e: BaileysEvent): void {
    this.opened.at(-1)?.emit(e);
  }
}
