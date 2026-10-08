"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "../../lib/api";

/**
 * WORKSPACE DO CORRETOR (modo 'workspace'): página mobile-first acessada pelo
 * LINK PESSOAL que o corretor recebe no WhatsApp ao aceitar um lead. Sem login
 * de usuário — o token assinado (?t=) identifica o corretor e escopa tudo aos
 * atendimentos ATIVOS dele. O gestor vê a mesma conversa em tempo real no
 * painel, porque toda mensagem passa pelo número da plataforma.
 */

const WS_TOKEN_KEY = "sdr_broker_ws_token";
const POLL_MS = 5000;

interface WsStage {
  n: number;
  stage: string;
  label: string;
}
interface WsAssignment {
  id: string;
  conversationId: string;
  leadName: string;
  stage: string | null;
  leadScore: number | null;
  leadFields: Record<string, unknown> | null;
  respondedAt: string | null;
  stageUpdatedAt: string | null;
}
interface WsMe {
  broker: { name: string };
  projectName: string;
  stages: WsStage[];
  assignments: WsAssignment[];
}
interface WsMessage {
  direction: "inbound" | "outbound";
  type: string;
  content: Record<string, unknown>;
  createdAt: string;
}

async function wsFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-broker-token": token,
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) throw new TokenError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
    const msg = Array.isArray(body?.message) ? body?.message[0] : body?.message;
    throw new Error(msg ?? `Erro ${res.status}`);
  }
  return res.json();
}

class TokenError extends Error {
  constructor() {
    super("Link expirado ou revogado. Peça um novo link ao gestor (ou aceite o próximo lead).");
  }
}

function fmtHora(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fichaResumo(f: Record<string, unknown> | null): string {
  if (!f) return "";
  const parts: string[] = [];
  const money = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/\D/g, "")) : NaN;
    return Number.isFinite(n) && n > 0 ? `R$ ${Math.round(n).toLocaleString("pt-BR")}` : null;
  };
  const renda = money(f.renda_familiar);
  if (renda) parts.push(`Renda ${renda}`);
  if (typeof f.fgts_disponivel === "boolean") parts.push(f.fgts_disponivel ? "Tem FGTS" : "Sem FGTS");
  if (typeof f.possui_imovel === "boolean" && f.possui_imovel) parts.push("Já tem imóvel");
  if (typeof f.regiao === "string" && f.regiao.trim()) parts.push(f.regiao.trim());
  return parts.join(" · ");
}

export default function CorretorPage() {
  return <CorretorWorkspace />;
}

function CorretorWorkspace() {
  // undefined = ainda resolvendo (fragment/sessionStorage); null = sem token
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [me, setMe] = useState<WsMe | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // assignment.id

  // Token: do FRAGMENT (#t= — nunca chega ao servidor/proxy, não vaza em log)
  // → sessionStorage (o link pode ser reaberto sem o fragment; removê-lo da
  // URL evita vazar o token em prints/compartilhamentos).
  useEffect(() => {
    const m = window.location.hash.match(/[#&]t=([^&]+)/);
    const fromUrl = m ? decodeURIComponent(m[1]) : null;
    if (fromUrl) {
      sessionStorage.setItem(WS_TOKEN_KEY, fromUrl);
      window.history.replaceState(null, "", "/corretor");
      setToken(fromUrl);
      return;
    }
    setToken(sessionStorage.getItem(WS_TOKEN_KEY));
  }, []);

  const refreshMe = useCallback(async () => {
    if (!token) return;
    try {
      const data = await wsFetch<WsMe>(token, "/workspace/imob/me");
      setMe(data);
      setErro(null);
    } catch (err) {
      if (err instanceof TokenError) {
        sessionStorage.removeItem(WS_TOKEN_KEY);
        setErro(err.message);
      } else {
        setErro(err instanceof Error ? err.message : "Não foi possível carregar seus atendimentos.");
      }
    }
  }, [token]);

  useEffect(() => {
    if (token === undefined) return;
    if (!token) {
      setErro("Este link precisa do seu código pessoal. Abra o link exato que a assistente enviou no seu WhatsApp.");
      return;
    }
    void refreshMe();
  }, [token, refreshMe]);

  // 1 atendimento ativo → abre direto o chat NA CHEGADA (caso comum: acabou de
  // aceitar). A tentativa é consumida no PRIMEIRO carregamento, mesmo sem
  // auto-abrir — clicar em voltar nunca re-seleciona (refinamento Codex).
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !me) return;
    autoOpened.current = true;
    if (me.assignments.length === 1 && selected === null) {
      setSelected(me.assignments[0].id);
    }
  }, [me, selected]);

  const atual = me?.assignments.find((a) => a.id === selected) ?? null;

  if (erro && !me) {
    return (
      <main style={S.page}>
        <div style={S.header}>
          <strong style={{ fontSize: 15 }}>Workspace do corretor</strong>
        </div>
        <p style={{ ...S.aviso, margin: 16 }}>{erro}</p>
      </main>
    );
  }
  if (!me) {
    return (
      <main style={S.page}>
        <div style={S.header}>
          <strong style={{ fontSize: 15 }}>Carregando seus atendimentos…</strong>
        </div>
      </main>
    );
  }

  if (atual && token) {
    return (
      <ChatView
        key={atual.id}
        token={token}
        me={me}
        assignment={atual}
        onBack={() => {
          setSelected(null);
          void refreshMe();
        }}
        onStageChanged={() => void refreshMe()}
      />
    );
  }

  return (
    <main style={S.page}>
      <div style={S.header}>
        <div>
          <strong style={{ fontSize: 15 }}>Olá, {me.broker.name}!</strong>
          <div style={{ fontSize: 12, opacity: 0.8 }}>{me.projectName} · seus atendimentos</div>
        </div>
      </div>
      {me.assignments.length === 0 ? (
        <p style={{ ...S.aviso, margin: 16 }}>
          Nenhum atendimento ativo no momento. Quando você aceitar um lead no WhatsApp, ele aparece aqui.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
          {me.assignments.map((a) => {
            const stageLabel = me.stages.find((s) => s.stage === a.stage)?.label ?? "Aguardando 1º contato";
            return (
              <button key={a.id} type="button" onClick={() => setSelected(a.id)} style={S.leadCard}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <strong style={{ fontSize: 14.5 }}>{a.leadName}</strong>
                  {a.leadScore !== null && <span style={S.scoreBadge}>score {a.leadScore}</span>}
                </div>
                <div style={{ fontSize: 12, color: "#5b6472", marginTop: 2 }}>{fichaResumo(a.leadFields) || "—"}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#0f766e", marginTop: 6 }}>{stageLabel}</div>
              </button>
            );
          })}
        </div>
      )}
      {erro && <p style={{ ...S.aviso, margin: 16 }}>{erro}</p>}
    </main>
  );
}

function ChatView({
  token,
  me,
  assignment,
  onBack,
  onStageChanged,
}: {
  token: string;
  me: WsMe;
  assignment: WsAssignment;
  onBack: () => void;
  onStageChanged: () => void;
}) {
  const [messages, setMessages] = useState<WsMessage[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);
  const [stageBusy, setStageBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const countRef = useRef(0);

  const stageLabel = me.stages.find((s) => s.stage === assignment.stage)?.label ?? "Marcar etapa";

  const poll = useCallback(async () => {
    try {
      const data = await wsFetch<{ messages: WsMessage[] }>(
        token,
        `/workspace/imob/conversations/${assignment.conversationId}/messages?limit=100`,
      );
      setMessages(data.messages);
      setErro(null);
    } catch (err) {
      // atendimento fechado/redistribuído no meio do chat → volta pra lista
      if (err instanceof TokenError || (err instanceof Error && err.message.includes("fora dos seus"))) {
        onBack();
        return;
      }
      setErro(err instanceof Error ? err.message : "Falha ao atualizar a conversa.");
    }
  }, [token, assignment.conversationId, onBack]);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // autoscroll só quando chega mensagem nova (não a cada poll)
  useEffect(() => {
    const n = messages?.length ?? 0;
    if (n !== countRef.current) {
      countRef.current = n;
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  async function doSend() {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setErro(null);
    // id estável por tentativa → reenvio após falha de rede não duplica
    const clientMessageId = `ws-${assignment.id}-${Date.now()}`;
    try {
      await wsFetch(token, `/workspace/imob/conversations/${assignment.conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: t, clientMessageId }),
      });
      setText("");
      await poll();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível enviar. Tente de novo.");
    } finally {
      setSending(false);
    }
  }

  async function doStage(stage: string) {
    if (stageBusy) return;
    setStageBusy(true);
    setErro(null);
    try {
      const res = await wsFetch<{ ok: true; stage: string; closed: boolean }>(
        token,
        `/workspace/imob/assignments/${assignment.id}/stage`,
        { method: "POST", body: JSON.stringify({ stage }) },
      );
      setStageOpen(false);
      onStageChanged();
      if (res.closed) onBack();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível registrar a etapa.");
    } finally {
      setStageBusy(false);
    }
  }

  const resumo = useMemo(() => fichaResumo(assignment.leadFields), [assignment.leadFields]);

  return (
    <main style={S.page}>
      <div style={S.header}>
        <button type="button" onClick={onBack} aria-label="Voltar para a lista" style={S.backBtn}>
          ‹
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ fontSize: 14.5, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {assignment.leadName}
          </strong>
          <div style={{ fontSize: 11.5, opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {resumo || me.projectName}
          </div>
        </div>
        <button type="button" onClick={() => setStageOpen((v) => !v)} style={S.stageBtn}>
          {stageLabel} ▾
        </button>
      </div>

      {stageOpen && (
        <div style={S.stageMenu}>
          {me.stages.map((s) => (
            <button
              key={s.stage}
              type="button"
              disabled={stageBusy}
              onClick={() => void doStage(s.stage)}
              style={{ ...S.stageItem, fontWeight: s.stage === assignment.stage ? 800 : 500 }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <div style={S.chatArea}>
        {messages === null ? (
          <p style={{ ...S.aviso, margin: 16 }}>Carregando conversa…</p>
        ) : (
          <>
            {messages.map((m, i) => {
              const out = m.direction === "outbound";
              const body = String(m.content.text ?? m.content.transcription ?? "");
              return (
                <div key={i} style={{ display: "flex", justifyContent: out ? "flex-end" : "flex-start" }}>
                  <div style={{ ...S.bubble, ...(out ? S.bubbleOut : S.bubbleIn) }}>
                    <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {body || `[${m.type}]`}
                    </span>
                    <span style={S.hora}>{fmtHora(m.createdAt)}</span>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {erro && <p style={{ ...S.aviso, margin: "0 14px 8px" }}>{erro}</p>}

      <div style={S.composer}>
        <textarea
          value={text}
          aria-label="Mensagem para o lead"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void doSend();
            }
          }}
          placeholder="Mensagem para o lead…"
          rows={1}
          style={S.input}
        />
        <button type="button" onClick={() => void doSend()} disabled={sending || !text.trim()} style={S.sendBtn}>
          {sending ? "…" : "Enviar"}
        </button>
      </div>
    </main>
  );
}

// Estilo inline mobile-first (a página vive FORA do shell do painel — o
// corretor abre no navegador do celular, direto do WhatsApp).
const S: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    maxWidth: 640,
    margin: "0 auto",
    background: "#f4f5f7",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "12px 14px",
    background: "#111827",
    color: "#fff",
    position: "sticky",
    top: 0,
    zIndex: 2,
  },
  backBtn: {
    background: "none",
    border: "none",
    color: "#fff",
    fontSize: 26,
    lineHeight: 1,
    padding: "0 6px 2px 0",
    cursor: "pointer",
  },
  stageBtn: {
    background: "#0f766e",
    color: "#fff",
    border: "none",
    borderRadius: 999,
    padding: "7px 12px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  stageMenu: {
    display: "flex",
    flexDirection: "column",
    background: "#fff",
    borderBottom: "1px solid #e2e5ea",
  },
  stageItem: {
    textAlign: "left",
    background: "none",
    border: "none",
    borderTop: "1px solid #eef0f3",
    padding: "12px 16px",
    fontSize: 13.5,
    cursor: "pointer",
  },
  chatArea: {
    flex: 1,
    overflowY: "auto",
    padding: "14px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  bubble: {
    maxWidth: "82%",
    borderRadius: 14,
    padding: "8px 12px",
    fontSize: 13.5,
    lineHeight: 1.45,
    display: "inline-flex",
    flexDirection: "column",
    boxShadow: "0 1px 1px rgba(0,0,0,0.05)",
  },
  bubbleIn: { background: "#fff", color: "#111827", borderTopLeftRadius: 4 },
  bubbleOut: { background: "#d1f4e5", color: "#0b3d2e", borderTopRightRadius: 4 },
  hora: { fontSize: 10, opacity: 0.6, alignSelf: "flex-end", marginTop: 2 },
  composer: {
    display: "flex",
    gap: 8,
    padding: "10px 12px calc(10px + env(safe-area-inset-bottom))",
    background: "#fff",
    borderTop: "1px solid #e2e5ea",
  },
  input: {
    flex: 1,
    resize: "none",
    border: "1px solid #d5d9e0",
    borderRadius: 12,
    padding: "10px 12px",
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
  },
  sendBtn: {
    background: "#111827",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    padding: "0 16px",
    fontSize: 13.5,
    fontWeight: 700,
    cursor: "pointer",
  },
  leadCard: {
    textAlign: "left",
    background: "#fff",
    border: "1px solid #e2e5ea",
    borderRadius: 12,
    padding: "12px 14px",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  scoreBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: "#0f766e",
    background: "#d1f4e5",
    borderRadius: 999,
    padding: "2px 8px",
    whiteSpace: "nowrap",
  },
  aviso: {
    background: "#fff7ed",
    border: "1px solid #fdba74",
    color: "#9a3412",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 13,
  },
};
