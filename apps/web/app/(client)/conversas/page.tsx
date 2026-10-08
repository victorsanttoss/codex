"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  getConversationDetail,
  getConversations,
  sendConversationMessage,
  setTakeover,
  type ConversationRow,
  type HistoryMessage,
} from "../../../lib/api";
import { Button, ErrorState, SkeletonBlock } from "../../../components/ui";
import { useToast } from "../../../components/toast";
import s from "./conversas.module.css";

export default function ConversasPage() {
  return (
    <Suspense
      fallback={
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-busy="true">
          <SkeletonBlock height={23} width={180} />
          <SkeletonBlock height={320} style={{ borderRadius: 12 }} />
        </div>
      }
    >
      <Conversas />
    </Suspense>
  );
}

function fmtHour(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function lastActivity(c: ConversationRow): string | null {
  const a = c.lastInboundAt ? new Date(c.lastInboundAt).getTime() : 0;
  const b = c.lastOutboundAt ? new Date(c.lastOutboundAt).getTime() : 0;
  const max = Math.max(a, b);
  return max > 0 ? new Date(max).toISOString() : null;
}

function Conversas() {
  const router = useRouter();
  const sp = useSearchParams();
  const selected = sp.get("c");
  const [filter, setFilter] = useState<"all" | "handoff" | "qualified">("all");
  const [list, setList] = useState<ConversationRow[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    getConversations({ handoff: filter === "handoff" ? 1 : undefined, qualified: filter === "qualified" ? 1 : undefined })
      .then((p) => setList(p.rows))
      .catch((e: Error) => { setList([]); setError(e.message); });
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const selectedRow = list?.find((c) => c.conversationId === selected) ?? null;

  return (
    <div>
      <h1 className="h1-page" style={{ marginBottom: 16 }}>Conversas</h1>
      <div className={s.wrap}>
        <div className={s.list}>
          <div className={s.filters}>
            {[["all", "Todas"], ["handoff", "Handoff"], ["qualified", "Qualificados"]].map(([v, l]) => (
              <button key={v} className={[s.filterBtn, filter === v ? s.filterBtnOn : ""].join(" ")} onClick={() => setFilter(v as typeof filter)}>{l}</button>
            ))}
          </div>
          {list === null && (
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }} aria-busy="true">
              <SkeletonBlock height={38} style={{ borderRadius: 8 }} />
              <SkeletonBlock height={38} style={{ borderRadius: 8 }} />
              <SkeletonBlock height={38} style={{ borderRadius: 8 }} />
            </div>
          )}
          {error && (
            <div style={{ padding: 14 }}>
              <ErrorState message="Não conseguimos buscar suas conversas." detail={error} onRetry={load} />
            </div>
          )}
          {list?.map((c) => (
            <div key={c.conversationId} className={[s.convItem, selected === c.conversationId ? s.convItemOn : ""].join(" ")} onClick={() => router.push(`/conversas?c=${c.conversationId}`)}>
              <span className={s.convAvatar}>{(c.name ?? c.waId).slice(0, 2).toUpperCase()}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--ink-900)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name ?? c.waId}</div>
                <div className="caption" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.humanTakeover ? "🙋 Em atendimento humano" : c.leadStatus ? `Lead: ${c.leadStatus}` : "Conversa ativa"}
                </div>
              </div>
              <span className={s.convTime}>{fmtHour(lastActivity(c))}</span>
            </div>
          ))}
          {list?.length === 0 && !error && <div style={{ padding: 24, textAlign: "center" }} className="muted">Nenhuma conversa.</div>}
        </div>

        {selected ? (
          <ConversationPanel
            key={selected}
            conversationId={selected}
            initialTakeover={selectedRow?.humanTakeover ?? false}
            title={selectedRow ? selectedRow.name ?? selectedRow.waId : "Conversa"}
          />
        ) : (
          <div className={s.panel}><div className={s.empty}>Selecione uma conversa</div></div>
        )}
      </div>
    </div>
  );
}

function ConversationPanel({ conversationId, initialTakeover, title }: { conversationId: string; initialTakeover: boolean; title: string }) {
  const toast = useToast();
  const [history, setHistory] = useState<HistoryMessage[] | null>(null);
  const [error, setError] = useState("");
  // Inicializa do dado real da lista (getConversations → humanTakeover).
  const [takeover, setTk] = useState(initialTakeover);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => { setTk(initialTakeover); }, [initialTakeover]);

  const load = useCallback(() => {
    setError("");
    getConversationDetail(conversationId)
      .then((d) => setHistory(d.history))
      .catch((e: Error) => { setHistory([]); setError(e.message); });
  }, [conversationId]);

  useEffect(() => { load(); }, [load]);

  async function toggleTakeover() {
    setBusy(true);
    try {
      const next = !takeover;
      await setTakeover(conversationId, next);
      setTk(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A IA "está digitando" quando segue no comando e a última mensagem é do lead.
  const last = history && history.length > 0 ? history[history.length - 1] : null;
  const typing = !takeover && last?.direction === "inbound";

  /** Envio manual (composer): append otimista da bolha; erro vira toast e desfaz.
   * Idempotência: o retry da MESMA mensagem (após falha) reusa a chave — o
   * backend deduplica e não manda duas vezes para o lead. */
  const retryKeyRef = useRef<{ text: string; key: string } | null>(null);
  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    const key =
      retryKeyRef.current?.text === text ? retryKeyRef.current.key : crypto.randomUUID();
    setSending(true);
    const optimistic: HistoryMessage = {
      direction: "outbound",
      type: "text",
      content: { text },
      createdAt: new Date().toISOString(),
    };
    setHistory((h) => [...(h ?? []), optimistic]);
    setDraft("");
    try {
      await sendConversationMessage(conversationId, text, key);
      retryKeyRef.current = null;
    } catch (e) {
      // desfaz o append otimista, devolve o texto ao input e guarda a chave p/ retry
      retryKeyRef.current = { text, key };
      setHistory((h) => (h ? h.filter((m) => m !== optimistic) : h));
      setDraft(text);
      toast(`✗ ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={s.panel}>
      <div className={s.panelHead}>
        <strong style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</strong>
        <Button size="sm" variant={takeover ? "secondary" : "primary"} disabled={busy} onClick={toggleTakeover}>
          {takeover ? "Devolver à IA" : "Assumir conversa"}
        </Button>
      </div>
      {takeover && <div className={s.takeoverBanner}>Você assumiu esta conversa — a IA está pausada aqui.</div>}
      <div className={s.thread}>
        {history === null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-busy="true">
            <SkeletonBlock height={38} width="55%" style={{ borderRadius: 10 }} />
            <SkeletonBlock height={38} width="60%" style={{ borderRadius: 10, alignSelf: "flex-end" }} />
            <SkeletonBlock height={38} width="45%" style={{ borderRadius: 10 }} />
          </div>
        )}
        {error && <ErrorState message="Não conseguimos carregar as mensagens desta conversa." detail={error} onRetry={load} />}
        {history?.map((m, i) => <Bubble key={i} m={m} />)}
        {typing && (
          <div className={s.typingBubble} aria-label="A SDR está digitando">
            <span /><span /><span />
          </div>
        )}
        {history?.length === 0 && !error && <div className={s.empty} style={{ color: "#667781" }}>Sem mensagens.</div>}
      </div>
      {/* Composer: ATIVO quando o humano assumiu (envio manual pela API do
          painel); com a IA no comando permanece desabilitado. */}
      <div className={s.composer}>
        <input
          className={s.composerInput}
          disabled={!takeover || sending}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={takeover ? "Escreva uma mensagem…" : "A IA está atendendo — assuma para responder"}
          aria-label="Escrever mensagem"
        />
        <Button
          disabled={!takeover || sending || !draft.trim()}
          onClick={() => void send()}
          title={takeover ? "Enviar mensagem" : "Assuma a conversa para responder"}
        >
          {sending ? "Enviando…" : "Enviar"}
        </Button>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: HistoryMessage }) {
  const out = m.direction === "outbound";
  const text = String(m.content.text ?? "");
  const isAudio = m.type === "media" && (m.content.mediaType === "audio" || m.content.transcription);
  // A transcrição de áudio é espelhada em content.text (ver setInboundTranscription);
  // content.transcription é legado de outra tabela. Aceita os dois.
  const transcription = (m.content.transcription ?? (isAudio ? m.content.text : undefined)) as
    | string
    | undefined;
  const time = new Date(m.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return (
    <div className={[s.bubble, out ? s.outbound : s.inbound].join(" ")}>
      {isAudio ? (
        <div>
          <div className={s.audio}>
            <span className={s.audioPlay}><svg width="12" height="12" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z" /></svg></span>
            <span style={{ height: 18, flex: 1, background: "repeating-linear-gradient(90deg,#bbb 0 2px,transparent 2px 4px)", borderRadius: 2 }} />
            <span className="caption">áudio</span>
          </div>
          {transcription && <div className={s.transcript}>“{transcription}”</div>}
        </div>
      ) : (
        text || `[${m.type}]`
      )}
      <span className={s.bubbleMeta}>{time}{out && <span className={s.tick}> ✓✓</span>}</span>
    </div>
  );
}
