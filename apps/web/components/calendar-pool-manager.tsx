"use client";

import { useEffect, useRef, useState } from "react";
import {
  addPoolCalendar,
  getCalendarPool,
  getMe,
  removePoolCalendar,
  type CalendarPool,
} from "../lib/api";
import { Button, Card, Input, SkeletonBlock } from "./ui";

/**
 * Gerenciador do POOL de agendas do tenant (0036) — COMPARTILHADO entre a Etapa
 * 5 do onboarding e a página de Configuração (como o KnowledgeManager). O
 * cliente conecta 0..N agendas Google (uma por recurso: profissional/vendedor/
 * corretor — o termo vem da vertical); sem nenhuma, a SDR usa a agenda da
 * plataforma. Cada vínculo valida o acesso da conta de serviço e salva na hora.
 * Mutações são admin-only no backend; agentes veem a lista em leitura.
 */
export function CalendarPoolManager() {
  const [pool, setPool] = useState<CalendarPool | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [name, setName] = useState("");
  const [calId, setCalId] = useState("");
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Guarda de ordem: ignora respostas de refresh obsoletas (achado Codex).
  const reqSeq = useRef(0);

  const noun = pool?.resourceNoun ?? { singular: "agenda", plural: "agendas" };
  // A agenda DEFAULT é a "plataforma", não um recurso do pool — não listar aqui.
  const googleCals = (pool?.calendars ?? []).filter((c) => c.provider === "google" && !c.isDefault);
  // Trava global: qualquer mutação em voo desabilita o resto (evita corrida).
  const mutating = adding || busyId !== null;

  async function refresh(): Promise<void> {
    const seq = ++reqSeq.current;
    try {
      const p = await getCalendarPool();
      if (seq === reqSeq.current) setPool(p);
    } catch {
      if (seq === reqSeq.current) {
        setPool({
          calendars: [],
          configured: false,
          serviceAccountEmail: null,
          resourceNoun: { singular: "agenda", plural: "agendas" },
        });
      }
    }
  }

  useEffect(() => {
    void refresh();
    getMe()
      .then((me) => setCanManage(me.role === "owner" || me.role === "admin"))
      .catch(() => setCanManage(false));
  }, []);

  async function doAdd() {
    setAdding(true);
    setMsg(null);
    try {
      await addPoolCalendar({ name: name.trim(), externalCalendarId: calId.trim() });
      setName("");
      setCalId("");
      setMsg({ ok: true, text: "Agenda vinculada! A SDR já enxerga a disponibilidade real." });
      await refresh();
    } catch (err) {
      setMsg({
        ok: false,
        text: err instanceof Error ? err.message : "Não foi possível vincular. Confira o ID e o compartilhamento.",
      });
    } finally {
      setAdding(false);
    }
  }

  async function doRemove(id: string) {
    setBusyId(id);
    setMsg(null);
    try {
      await removePoolCalendar(id);
      await refresh();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Não foi possível remover a agenda." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card style={{ padding: 18 }}>
      {pool === null ? (
        <SkeletonBlock height={14} />
      ) : !pool.configured ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          A integração com o Google ainda não está configurada nesta instalação da plataforma. A SDR usa a agenda
          da plataforma (menu Agenda) por enquanto.
        </p>
      ) : (
        <>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>
            Agendas do Google — uma por {noun.singular}
          </strong>
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5 }}>
            A SDR distribui os agendamentos entre as agendas conectadas: oferece um horário livre de qualquer{" "}
            {noun.singular} e reserva com quem estiver disponível. Sem nenhuma agenda conectada, ela usa a agenda da
            plataforma.
          </p>

          {canManage && (
            <>
              <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                1. No Google Agenda de cada {noun.singular}, compartilhe a agenda com o e-mail abaixo com a permissão
                <strong> “Fazer alterações em eventos”</strong>:
              </p>
              <code
                style={{
                  display: "block",
                  padding: "8px 10px",
                  background: "var(--neutral-tint, #f5f5f5)",
                  borderRadius: 8,
                  fontSize: 12.5,
                  marginBottom: 12,
                  userSelect: "all",
                }}
              >
                {pool.serviceAccountEmail}
              </code>
            </>
          )}

          {googleCals.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "0 0 12px" }}>
              {googleCals.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    border: "1px solid var(--border-300)",
                    borderRadius: 10,
                    padding: "8px 12px",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 13 }}>{c.name}</strong>
                    <div
                      className="muted"
                      style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {c.googleCalendarId}
                    </div>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      aria-label={`Remover agenda ${c.name}`}
                      onClick={() => void doRemove(c.id)}
                      disabled={mutating}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: mutating ? "default" : "pointer",
                        fontSize: 12.5,
                        fontWeight: 700,
                        color: "var(--error-text)",
                        opacity: mutating && busyId !== c.id ? 0.5 : 1,
                        padding: 4,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {busyId === c.id ? "Removendo…" : "Remover"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5 }}>
              Nenhuma agenda Google conectada — a SDR está usando a agenda da plataforma.
            </p>
          )}

          {canManage && (
            <>
              <p style={{ margin: "0 0 6px", fontSize: 13 }}>
                2. Dê um nome e cole o <strong>ID da agenda</strong> (Configurações da agenda → “Integrar agenda”):
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Input
                  value={name}
                  aria-label={`Nome do ${noun.singular}`}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`Nome (ex.: ${noun.singular} João)`}
                  style={{ flex: "1 1 150px" }}
                />
                <Input
                  value={calId}
                  aria-label="ID da agenda do Google"
                  onChange={(e) => setCalId(e.target.value)}
                  placeholder="ID da agenda (…@group.calendar.google.com)"
                  style={{ flex: "2 1 230px" }}
                />
                <Button disabled={mutating || !name.trim() || !calId.trim()} onClick={() => void doAdd()}>
                  {adding ? "Validando…" : `Adicionar ${noun.singular}`}
                </Button>
              </div>
            </>
          )}
          {msg && (
            <p
              role={msg.ok ? "status" : "alert"}
              style={{
                margin: "10px 0 0",
                fontSize: 12.5,
                fontWeight: 600,
                color: msg.ok ? "var(--success-text)" : "var(--error-text)",
              }}
            >
              {msg.text}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
