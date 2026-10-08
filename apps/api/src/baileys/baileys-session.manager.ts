import { createHash } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { runWithTenant, type NormalizedInboundMessage } from "@sdr/core";
import type { AppConfig } from "@sdr/config";
import {
  listActiveConnectionsByProvider,
  listPendingAgentTurns,
  isHumanTakeover,
  isContactOptedOut,
  getConnectionForConversation,
  markMessageStatusByExternalId,
  reconcileOutboxStatus,
  recordOutboundMessage,
  setConnectionStatus,
  type BaileysSessionStore,
  type ResolvedConnection,
} from "@sdr/db";
import {
  buildInboundEnvelope,
  buildStatusEnvelope,
  type BaileysConnection,
  type BaileysConnState,
  type BaileysDriver,
  type BaileysEvent,
} from "@sdr/whatsapp-baileys";
import type { ProviderRegistry } from "@sdr/core";
import { APP_CONFIG } from "../config/config.module";
import { ALERT_NOTIFIER, type AlertNotifier } from "../ops/alert-notifier";
import { InboundCoreService } from "../whatsapp/inbound-core.service";
import { bubblePauseMs, formatWhatsAppReply } from "../whatsapp/reply-format";
import { OutboxService } from "../outbox/outbox.service";
import type { LockHandle } from "../queue/redis-mutex";
import { runsSessionWorker } from "../runtime/roles";
import { BAILEYS_DRIVER } from "./baileys.driver.provider";
import { BAILEYS_REGISTRY, baileysProviderFor } from "./baileys.registry";
import { BAILEYS_SESSION_STORE } from "./baileys-session-store.provider";
import { QR_STORE, type QrStore } from "./qr-store";
import { ownsNumber } from "./ownership";
import { logCorrelationId, safeErrorFields } from "../observability/logger";
import {
  ReplyDeliveryError,
  type ReplyOptions,
} from "../whatsapp/message-handler";

interface Session {
  tenantId: string;
  phoneNumberId: string;
  conn?: BaileysConnection;
  state: "connecting" | "open" | "closed" | "logged_out";
  attempts: number;
  nextRetryAt: number;
  /** Falhas TERMINAIS consecutivas (WhatsApp rejeitou a sessão — ver TERMINAL_CLOSE_CODES). */
  terminalFails: number;
  /** Encadeia as persistências do blob — ordem garantida mesmo com retry no meio. */
  saveChain: Promise<void>;
  /** Geração do socket ATUAL — evento de socket antigo (pós-reconnect) é descartado. */
  epoch: number;
}

const RECONCILE_EVERY_MS = 15_000;

/**
 * Códigos de close em que o WhatsApp REJEITOU a sessão (não é queda de rede):
 * reconectar com o MESMO blob não resolve. 401 (loggedOut) já vira `logged_out`
 * no driver; aqui: 403 forbidden, 405 connection failure (auth), 411 multi-device
 * mismatch, 500 bad session. Rede/timeout (408/428/ECONN…) ficam FORA — esses
 * re-tentam para sempre com backoff (a sessão do cliente sobrevive a quedas).
 */
const TERMINAL_CLOSE_CODES = new Set(["403", "405", "411", "500"]);
/** 515 = restart exigido pelo WhatsApp (esperado logo após parear) → reconexão imediata. */
const RESTART_REQUIRED_CODE = "515";
/** Rejeições terminais consecutivas toleradas antes de desistir e exigir novo QR. */
const MAX_TERMINAL_FAILS = 3;

/** Backoff exponencial com teto (reconexão de socket). */
export function backoffMs(attempts: number, base: number, max: number): number {
  return Math.min(max, base * 2 ** Math.max(0, attempts));
}

/**
 * SESSION-WORKER (M13): mantém os sockets Baileys vivos dos números ATRIBUÍDOS a
 * este worker (sticky por hash). Loop de reconcile (sem timers frágeis): conecta
 * números novos, reconecta os caídos respeitando backoff, e descobre onboarding
 * (número novo → QR). Inbound por evento entra no MESMO núcleo (InboundCore) e a
 * resposta sai pelo socket local. Logout/sessão inválida → conexão sai do
 * roteamento + alerta + exige novo pareamento. NUNCA loga sessão/QR como segredo.
 */
@Injectable()
export class BaileysSessionManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BaileysSessionManager.name);
  private readonly sessions = new Map<string, Session>();
  private timer?: ReturnType<typeof setInterval>;
  private reconciling = false;
  /** Injetável p/ testes determinísticos. */
  nowFn: () => number = () => Date.now();
  /** Delays do retry de persistência do blob (injetável p/ testes). */
  persistRetryDelaysMs: number[] = [250, 1_000];

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(BAILEYS_DRIVER) private readonly driver: BaileysDriver,
    @Inject(BAILEYS_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(BAILEYS_SESSION_STORE) private readonly store: BaileysSessionStore,
    @Inject(QR_STORE) private readonly qr: QrStore,
    @Inject(ALERT_NOTIFIER) private readonly notifier: AlertNotifier,
    private readonly core: InboundCoreService,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    if (!runsSessionWorker(this.cfg.app.role) || !this.cfg.baileys.enabled)
      return;
    this.logger.log(
      `Session-worker Baileys ativo (index ${this.cfg.baileys.workerIndex}/${this.cfg.baileys.workerTotal}).`,
    );
    void this.reconcile().catch((e) =>
      this.logger.error({
        event: "baileys_reconcile_failed",
        initial: true,
        error: safeErrorFields(e),
      }),
    );
    this.timer = setInterval(() => {
      void this.reconcile().catch((e) =>
        this.logger.error({
          event: "baileys_reconcile_failed",
          error: safeErrorFields(e),
        }),
      );
    }, RECONCILE_EVERY_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sessions.values())
      await s.conn?.close().catch(() => {});
  }

  /** Este worker é o dono do número? (atribuição sticky) */
  owns(phoneNumberId: string): boolean {
    return ownsNumber(
      phoneNumberId,
      this.cfg.baileys.workerIndex,
      this.cfg.baileys.workerTotal,
    );
  }

  /**
   * Garante que todo número Baileys ATIVO atribuído a este worker tenha socket:
   * conecta os novos (onboarding gera QR) e reconecta os caídos após o backoff.
   */
  async reconcile(): Promise<void> {
    // Reconcile inclui I/O de recuperação. Um tick lento não pode iniciar
    // outro scan/conexão enquanto o anterior ainda está em andamento.
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.reconcileSessions();
      await this.recoverPendingTurns();
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileSessions(): Promise<void> {
    // Inclui `connecting` (registradas mas ainda não pareadas) — senão o número
    // novo nunca seria descoberto para abrir o socket e publicar o QR.
    const conns = await listActiveConnectionsByProvider("baileys", [
      "active",
      "connecting",
    ]);
    const wanted = new Set(
      conns
        .filter((c) => this.owns(c.phoneNumberId))
        .map((c) => c.phoneNumberId),
    );
    // Conecta/reconecta os números possuídos e ativos. try/catch POR NÚMERO:
    // uma falha de connect não pode abortar o reconcile dos demais, nem deixar a
    // sessão presa em "connecting" para sempre (marca `closed` + backoff — o
    // próximo reconcile re-tenta).
    for (const c of conns) {
      if (!this.owns(c.phoneNumberId)) continue;
      const s = this.sessions.get(c.phoneNumberId);
      const shouldConnect =
        !s || (s.state === "closed" && this.nowFn() >= s.nextRetryAt);
      if (!shouldConnect) continue;
      try {
        await this.connect(c.tenantId, c.phoneNumberId);
      } catch (err) {
        this.markConnectFailed(c.phoneNumberId);
        this.logger.warn({
          event: "baileys_connect_failed",
          tenantId: c.tenantId,
          sessionRef: logCorrelationId(c.phoneNumberId),
          retry: "backoff",
          error: safeErrorFields(err),
        });
      }
    }
    // Fecha ÓRFÃOS: números que deixaram de ser ativos OU mudaram de dono (após
    // rebalance). Senão um socket antigo seguiria recebendo/respondendo fora do
    // roteamento atual. Não fecha os deslogados (já removidos).
    for (const [phone, s] of this.sessions) {
      if (!wanted.has(phone)) {
        await s.conn?.close().catch(() => {});
        this.sessions.delete(phone);
        this.logger.log({
          event: "baileys_socket_removed",
          tenantId: s.tenantId,
          sessionRef: logCorrelationId(phone),
        });
      }
    }
  }

  /** Retoma planos persistidos mesmo sem novo inbound ou reentrega do socket. */
  private async recoverPendingTurns(): Promise<void> {
    // Compatibilidade dos fakes antigos; produção sempre injeta o core real.
    if (typeof this.core.resumeStoredTurn !== "function") return;
    const tenantIds = new Set(
      [...this.sessions.values()]
        .filter(
          (session) =>
            session.state === "open" &&
            session.conn &&
            this.owns(session.phoneNumberId),
        )
        .map((session) => session.tenantId),
    );
    for (const tenantId of tenantIds) {
      await runWithTenant({ tenantId }, async () => {
        // Filter before LIMIT: pending turns on another worker/account must
        // not monopolize this session worker's recovery page.
        const turns = (
          await Promise.all(
            [...this.sessions.values()]
              .filter(
                (session) =>
                  session.tenantId === tenantId &&
                  this.ownsLiveSocket(session.phoneNumberId),
              )
              .map((session) =>
                listPendingAgentTurns(50, {
                  provider: "baileys",
                  channelAccountId: session.phoneNumberId,
                }),
              ),
          )
        ).flat();
        for (const turn of turns) {
          const source = turn.plan?.source;
          const [provider, accountId] = turn.conversationKey.split(":");
          if (
            provider !== "baileys" ||
            !source ||
            (source.provider && source.provider !== provider)
          )
            continue;
          if (source.channelAccountId && source.channelAccountId !== accountId)
            continue;
          const session = this.sessions.get(accountId ?? "");
          if (
            !session ||
            session.tenantId !== tenantId ||
            !this.ownsLiveSocket(session.phoneNumberId)
          )
            continue;
          try {
            // A identidade vem da conversa e do tenant; não usa um número
            // fallback quando a conta original foi removida/desconectada.
            const route = await getConnectionForConversation(
              turn.conversationId,
            );
            if (
              !route ||
              route.provider !== "baileys" ||
              route.status !== "active" ||
              route.phoneNumberId !== session.phoneNumberId
            )
              continue;
            if (!this.ownsLiveSocket(session.phoneNumberId)) continue;
            const conn: ResolvedConnection = {
              tenantId,
              connectionId: route.connectionId,
              secretRef: route.secretRef,
            };
            await this.core.resumeStoredTurn(
              turn,
              conn,
              (message, conversationId, handle) =>
                this.makeReply(session, message, conversationId, handle),
            );
          } catch (err) {
            this.logger.warn({
              event: "baileys_turn_recovery_failed",
              tenantId,
              turnId: turn.id,
              conversationId: turn.conversationId,
              error: safeErrorFields(err),
            });
          }
        }
      }).catch((err) =>
        this.logger.warn({
          event: "baileys_turn_recovery_scan_failed",
          tenantId,
          error: safeErrorFields(err),
        }),
      );
    }
  }

  /** Abre (ou reabre) o socket de um número, restaurando a sessão cifrada se houver. */
  async connect(tenantId: string, phoneNumberId: string): Promise<void> {
    const existing = this.sessions.get(phoneNumberId);
    const session: Session = existing ?? {
      tenantId,
      phoneNumberId,
      state: "connecting",
      attempts: 0,
      nextRetryAt: 0,
      terminalFails: 0,
      saveChain: Promise.resolve(),
      epoch: 0,
    };
    session.state = "connecting";
    this.sessions.set(phoneNumberId, session);

    // Nova GERAÇÃO de socket: evento atrasado do socket anterior (closed/
    // logged_out em trânsito) não pode fechar/invalidar o socket novo (Codex).
    session.epoch += 1;
    const epoch = session.epoch;

    const blob = await runWithTenant({ tenantId }, () =>
      this.store.get(phoneNumberId),
    );
    const authState = blob ? safeParse(blob) : null;
    session.conn = await this.driver.open({
      authState,
      onEvent: (e) => {
        if (session.epoch !== epoch) return; // evento de socket antigo — descarta
        void this.onEvent(session, e).catch((err) =>
          this.logger.error({
            event: "baileys_event_failed",
            tenantId,
            sessionRef: logCorrelationId(phoneNumberId),
            error: safeErrorFields(err),
          }),
        );
      },
    });
  }

  /** Falha no connect: sessão sai de "connecting" → "closed" com backoff. */
  private markConnectFailed(phoneNumberId: string): void {
    const s = this.sessions.get(phoneNumberId);
    if (!s) return;
    s.state = "closed";
    s.attempts += 1;
    s.nextRetryAt =
      this.nowFn() +
      backoffMs(
        s.attempts,
        this.cfg.baileys.reconnectBaseMs,
        this.cfg.baileys.reconnectMaxMs,
      );
  }

  private async onEvent(session: Session, e: BaileysEvent): Promise<void> {
    // O driver externo pode incluir conteúdo/credenciais no diagnóstico cru.
    if ((e as { type: string }).type === "log") {
      this.logger.debug({
        event: "baileys_driver_event",
        tenantId: session.tenantId,
        sessionRef: logCorrelationId(session.phoneNumberId),
      });
      return;
    }
    switch (e.type) {
      case "qr":
        await this.qr.publish(session.tenantId, session.phoneNumberId, {
          status: "qr",
          qr: e.qr,
          updatedAt: new Date(this.nowFn()).toISOString(),
        });
        this.logger.log({
          event: "baileys_qr_ready",
          tenantId: session.tenantId,
          sessionRef: logCorrelationId(session.phoneNumberId),
        });
        return;
      case "pairing_code":
        await this.qr.publish(session.tenantId, session.phoneNumberId, {
          status: "qr",
          qr: e.code,
          updatedAt: new Date(this.nowFn()).toISOString(),
        });
        return;
      case "creds": {
        // Sessão invalidada NÃO ressuscita blob morto (corrida clear ↔ save:
        // o flush do close dispara um creds depois do invalidate).
        if (session.state === "logged_out") return;
        // Persiste a sessão CIFRADA (reconecta sem novo QR). Nunca logar o blob.
        // Encadeado por sessão: com retry no meio, um write velho não pode
        // sobrescrever um mais novo (perderia signal keys → Bad MAC).
        const blob = JSON.stringify(e.authState);
        session.saveChain = session.saveChain.then(() =>
          this.persistSession(session, blob),
        );
        await session.saveChain;
        return;
      }
      case "connection":
        await this.onConnectionState(session, e.state, e.reason);
        return;
      case "message":
        await this.onInbound(session, e.raw);
        return;
      case "status":
        await this.onStatus(session, e.raw);
        return;
    }
  }

  /**
   * Persiste o blob cifrado com RETRY curto: um soluço do Postgres no meio da
   * conversa não pode perder signal keys (restart voltaria a keys velhas →
   * Bad MAC → re-pareamento). Falha final é logada ALTO; o próximo creds re-tenta
   * (o serialize sempre leva o estado COMPLETO atual).
   */
  private async persistSession(session: Session, blob: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      // Re-checa a CADA tentativa (Codex): invalidação no meio do retry/sleep
      // não pode deixar o retry ressuscitar o blob morto depois do clear.
      if (session.state === "logged_out") return;
      try {
        await runWithTenant({ tenantId: session.tenantId }, () =>
          this.store.save(session.phoneNumberId, blob),
        );
        return;
      } catch (err) {
        if (attempt >= this.persistRetryDelaysMs.length) {
          this.logger.error({
            event: "baileys_session_persist_failed",
            tenantId: session.tenantId,
            sessionRef: logCorrelationId(session.phoneNumberId),
            attempts: attempt + 1,
            error: safeErrorFields(err),
          });
          return;
        }
        await sleep(this.persistRetryDelaysMs[attempt]!);
      }
    }
  }

  private async onConnectionState(
    session: Session,
    state: BaileysConnState,
    reason?: string,
  ): Promise<void> {
    if (state === "open") {
      session.state = "open";
      session.attempts = 0;
      session.terminalFails = 0;
      // Pareamento REAL concluído → marca a conexão como `active` (antes estava
      // `connecting`). É aqui, não no /connect, que o tenant passa a contar como
      // conectado (banner do início, envio proativo).
      await runWithTenant({ tenantId: session.tenantId }, () =>
        setConnectionStatus(session.phoneNumberId, "active"),
      );
      await this.qr.publish(session.tenantId, session.phoneNumberId, {
        status: "connected",
        updatedAt: new Date(this.nowFn()).toISOString(),
      });
      this.logger.log({
        event: "baileys_socket_open",
        tenantId: session.tenantId,
        sessionRef: logCorrelationId(session.phoneNumberId),
      });
      return;
    }
    if (state === "logged_out") {
      await this.invalidateSession(
        session,
        `Sessão Baileys ${logCorrelationId(session.phoneNumberId)} do tenant ${session.tenantId} deslogada — exige novo pareamento (QR).`,
      );
      return;
    }
    if (state === "connecting") {
      session.state = "connecting";
      return;
    }
    // `reason` vem de lib externa — loga só um código curto/numérico (allowlist).
    const safeReason = /^[\w.-]{1,16}$/.test(reason ?? "")
      ? (reason as string)
      : "?";
    // 515 = o WhatsApp exige reinício do socket logo APÓS o pareamento
    // (comportamento normal do protocolo): reconexão IMEDIATA, sem backoff e
    // sem contar como falha — senão o cliente esperava o backoff todo para a
    // conexão recém-pareada subir.
    if (safeReason === RESTART_REQUIRED_CODE) {
      session.state = "closed";
      session.nextRetryAt = this.nowFn();
      await session.conn?.close().catch(() => {});
      this.logger.log({
        event: "baileys_socket_restart",
        tenantId: session.tenantId,
        sessionRef: logCorrelationId(session.phoneNumberId),
        code: "515",
      });
      return;
    }
    // Código TERMINAL = o WhatsApp REJEITOU a sessão (auth), não é queda de
    // rede: reconectar com o MESMO blob não resolve. Após N consecutivas, trata
    // como deslogado — status real no painel + novo QR — em vez do loop infinito
    // de reconexão com o selo "conectada" mentindo para o cliente.
    if (TERMINAL_CLOSE_CODES.has(safeReason)) {
      session.terminalFails += 1;
      if (session.terminalFails >= MAX_TERMINAL_FAILS) {
        await this.invalidateSession(
          session,
          `Sessão Baileys ${logCorrelationId(session.phoneNumberId)} do tenant ${session.tenantId} rejeitada pelo WhatsApp (cod ${safeReason}, ${session.terminalFails}× seguidas) — exige novo pareamento (QR).`,
        );
        return;
      }
    } else {
      // Queda NÃO-terminal (rede/timeout) quebra a sequência: só rejeições
      // realmente CONSECUTIVAS invalidam a sessão (Codex).
      session.terminalFails = 0;
    }
    // closed → agenda reconexão com backoff (o reconcile reabre).
    session.state = "closed";
    session.attempts += 1;
    session.nextRetryAt =
      this.nowFn() +
      backoffMs(
        session.attempts,
        this.cfg.baileys.reconnectBaseMs,
        this.cfg.baileys.reconnectMaxMs,
      );
    await session.conn?.close().catch(() => {});
    this.logger.warn({
      event: "baileys_socket_closed",
      tenantId: session.tenantId,
      sessionRef: logCorrelationId(session.phoneNumberId),
      ...(/^\d{3}$/.test(safeReason) ? { code: safeReason } : {}),
      retry: "backoff",
    });
  }

  /**
   * Sessão INVÁLIDA (logout explícito ou rejeição terminal do WhatsApp): sai do
   * roteamento, o status REAL chega ao painel (selo/início param de mentir), as
   * credenciais mortas são apagadas e o cliente é alertado a re-parear (QR).
   * `state=logged_out` vem ANTES do clear: bloqueia um creds atrasado (flush do
   * close) de re-salvar o blob morto — corrida clear ↔ save.
   */
  private async invalidateSession(
    session: Session,
    message: string,
  ): Promise<void> {
    session.state = "logged_out";
    await session.conn?.close().catch(() => {});
    // Espera saves EM VOO terminarem (Codex): um persistSession no meio do retry
    // depois do clear re-salvaria o blob morto. O retry re-checa o state e
    // aborta; aguardar aqui garante a ordem clear-por-último.
    await session.saveChain.catch(() => {});
    await runWithTenant({ tenantId: session.tenantId }, async () => {
      await setConnectionStatus(session.phoneNumberId, "disconnected");
      await this.store.clear(session.phoneNumberId);
    });
    await this.qr.publish(session.tenantId, session.phoneNumberId, {
      status: "logged_out",
      updatedAt: new Date(this.nowFn()).toISOString(),
    });
    await this.notifier.notify({
      kind: "connection_down",
      severity: "critical",
      message,
    });
    this.sessions.delete(session.phoneNumberId);
  }

  private async onInbound(
    session: Session,
    raw: Parameters<typeof buildInboundEnvelope>[1][number],
  ): Promise<void> {
    const provider = baileysProviderFor(this.registry, session.phoneNumberId);
    const msgs = provider.normalizeInboundWebhook({
      headers: {},
      query: {},
      rawBody: buildInboundEnvelope(session.phoneNumberId, [raw]),
    });
    // Conhecemos o tenant da sessão — sem DB lookup por mensagem. secretRef é o
    // default (mídia Baileys via socket é follow-up; aqui não toca o Graph).
    const conn: ResolvedConnection = {
      tenantId: session.tenantId,
      connectionId: session.phoneNumberId,
      secretRef: "whatsapp_token",
    };
    this.logger.log({
      event: "baileys_inbound",
      tenantId: session.tenantId,
      sessionRef: logCorrelationId(session.phoneNumberId),
      normalizedCount: msgs.length,
      fromMe: Boolean(raw.fromMe),
    });
    for (const m of msgs) {
      await this.core.handle(m, conn, (msgN, conversationId, handle) =>
        this.makeReply(session, msgN, conversationId, handle),
      );
      this.logger.log({
        event: "baileys_inbound_processed",
        tenantId: session.tenantId,
        sessionRef: logCorrelationId(session.phoneNumberId),
        conversationRef: logCorrelationId(m.conversationKey),
      });
    }
  }

  /**
   * Closure de resposta REATIVA: envia pelo SOCKET LOCAL (worker dono), PICADA
   * em bolhas como um humano (reply-format: parágrafo = mensagem; sanitiza
   * markdown/[n]). Idempotente por bolha: o messageId deriva do id do INBOUND +
   * índice. Os IDs estáveis ajudam a correlação/dedup, mas uma tentativa sem
   * confirmação ou um envio parcial ficam incertos e não devem ser reenviados
   * automaticamente pelo journal do turno.
   */
  private makeReply(
    session: Session,
    msg: NormalizedInboundMessage,
    conversationId: string,
    handle: LockHandle,
  ): (text: string, options?: ReplyOptions) => Promise<void> {
    return async (text: string, options?: ReplyOptions) => {
      let sendInFlight = false;
      let acceptedBubbles = 0;
      try {
        if (!(await handle.isValid())) {
          throw new Error("baileys_reply_lock_lost");
        }
        if (
          !session.conn ||
          session.state !== "open" ||
          !this.owns(session.phoneNumberId) ||
          this.sessions.get(session.phoneNumberId) !== session
        ) {
          throw new Error("baileys_reply_socket_unavailable");
        }
        const socket = session.conn;
        const epoch = session.epoch;
        const provider = baileysProviderFor(
          this.registry,
          session.phoneNumberId,
          socket,
        );
        const bubbles = formatWhatsAppReply(text);
        // IDs estáveis por turno/bolha, inclusive no replay após restart.
        const idBase = createHash("sha256")
          .update(msg.externalMessageId)
          .digest("hex")
          .slice(0, 20)
          .toUpperCase();
        for (let i = 0; i < bubbles.length; i++) {
          const bubble = bubbles[i]!;
          if (i > 0) await this.bubblePause(bubblePauseMs(bubble));
          if (i > 0 && !(await handle.isValid())) {
            throw new Error("baileys_reply_lock_lost");
          }
          if (
            !options?.allowOptOutReply &&
            ((await isHumanTakeover(conversationId)) ||
              (await isContactOptedOut(msg.from)))
          ) {
            throw new Error("baileys_reply_current_policy_blocked");
          }
          // Não continua bolhas num socket encerrado/substituído no meio do turno.
          if (
            session.state !== "open" ||
            session.conn !== socket ||
            session.epoch !== epoch ||
            this.sessions.get(session.phoneNumberId) !== session
          ) {
            throw new Error("baileys_reply_socket_changed");
          }
          // Preserva JID/LID: não reconstrói endereço oculto a partir de from.
          sendInFlight = true;
          const sent = await provider.sendMessage({
            to: msg.senderAddress ?? msg.from,
            text: bubble,
            clientMessageId: `3EB0${idBase}B${i}`,
          });
          acceptedBubbles += 1;
          sendInFlight = false;
          try {
            await recordOutboundMessage({
              conversationId,
              type: "text",
              content: { text: bubble },
              externalMessageId: sent.externalMessageId,
            });
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
          }
          await this.outbox.recordReactiveDelivery(
            {
              conversationId,
              toPhone: msg.from,
              text: bubble,
              externalMessageId: sent.externalMessageId,
              provider: "baileys",
            },
            { strict: true },
          );
        }
      } catch (cause) {
        // Uma falha local comprovada antes da primeira tentativa é recuperável.
        // Qualquer envio iniciado/aceito pode já ter alcançado o destinatário.
        throw new ReplyDeliveryError(
          sendInFlight || acceptedBubbles > 0 ? "uncertain" : "not_sent",
          "baileys_reply_failed",
          { cause },
        );
      }
    };
  }

  /** Pausa entre bolhas — injetável p/ testes determinísticos. */
  bubblePause: (ms: number) => Promise<void> = (ms) => sleep(ms);

  private async onStatus(
    session: Session,
    raw: Parameters<typeof buildStatusEnvelope>[1][number],
  ): Promise<void> {
    const provider = baileysProviderFor(this.registry, session.phoneNumberId);
    const events = provider.normalizeStatusEvents({
      headers: {},
      query: {},
      rawBody: buildStatusEnvelope(session.phoneNumberId, [raw]),
    });
    await runWithTenant({ tenantId: session.tenantId }, async () => {
      for (const ev of events) {
        await markMessageStatusByExternalId(ev.externalMessageId, ev.status);
        if (
          ev.status === "delivered" ||
          ev.status === "read" ||
          ev.status === "failed"
        ) {
          await reconcileOutboxStatus(ev.externalMessageId, ev.status);
        }
      }
    });
  }

  // ── Roteamento de ENVIO proativo (outbox/cadência) ──────────
  // Só o worker DONO do número, com socket ABERTO, envia. De outro worker, lança.
  ownsLiveSocket(phoneNumberId: string): boolean {
    const s = this.sessions.get(phoneNumberId);
    return Boolean(this.owns(phoneNumberId) && s?.conn && s.state === "open");
  }

  async sendText(
    phoneNumberId: string,
    toPhone: string,
    text: string,
    clientMessageId?: string,
  ): Promise<{ id: string }> {
    const s = this.sessions.get(phoneNumberId);
    if (!s?.conn || s.state !== "open") {
      throw new Error(
        `Sem socket Baileys aberto para ${phoneNumberId} neste worker.`,
      );
    }
    const provider = baileysProviderFor(this.registry, phoneNumberId, s.conn);
    // clientMessageId → messageId do WhatsApp (idempotência: reenvio não duplica).
    const sent = await provider.sendMessage({
      to: toPhone,
      text,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return { id: sent.externalMessageId };
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
/** Violação de unique do Postgres (23505) — transcript de bolha já registrada. */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "23505"
  );
}
