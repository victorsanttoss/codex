"use client";

import { useEffect, useRef, useState } from "react";
import {
  createImobAgency,
  createImobBrokerApi,
  getImobAgencies,
  getImobBrokers,
  getImobSettings,
  getImobWorkspaceLink,
  getMe,
  patchImobBroker,
  setImobBrokerModeApi,
  type ImobAgency,
  type ImobBroker,
  type ImobBrokerMode,
} from "../lib/api";
import { Button, Card, Input, SkeletonBlock } from "./ui";

/**
 * Gerenciador de CORRETORES PARCEIROS (vertical imobiliária) — COMPARTILHADO
 * entre a etapa "Corretores parceiros" do onboarding e a página de
 * Configuração (mesmo padrão do CalendarPoolManager). É AQUI que entram os
 * números de WhatsApp dos corretores: a SDR envia a ficha do lead qualificado
 * para esses números e reconhece as respostas deles (aceite "1", status 1-6).
 * Mutações são admin-only no backend.
 */
export function BrokersManager() {
  const [brokers, setBrokers] = useState<ImobBroker[] | null>(null);
  const [agencies, setAgencies] = useState<ImobAgency[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // form de novo corretor
  const [name, setName] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [regions, setRegions] = useState("");
  const [capacity, setCapacity] = useState("10");
  const [agencyId, setAgencyId] = useState("");
  const [newAgency, setNewAgency] = useState("");
  // modo de atendimento (por empreendimento): ficha × workspace
  const [mode, setMode] = useState<ImobBrokerMode | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [linkBusyId, setLinkBusyId] = useState<string | null>(null);
  // Guarda de ordem: ignora respostas de refresh obsoletas (padrão do pool).
  const reqSeq = useRef(0);

  const mutating = adding || busyId !== null;
  const activeAgencies = agencies.filter((a) => !a.archivedAt);

  async function refresh(): Promise<void> {
    const seq = ++reqSeq.current;
    try {
      const [b, a, s] = await Promise.all([getImobBrokers(), getImobAgencies(), getImobSettings()]);
      if (seq === reqSeq.current) {
        setBrokers(b.brokers);
        setAgencies(a.agencies);
        setMode(s.brokerMode);
      }
    } catch {
      if (seq === reqSeq.current) setBrokers([]);
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
      // imobiliária nova digitada vence o select
      let agency = agencyId || undefined;
      const agencyName = newAgency.trim();
      if (agencyName) {
        const res = await createImobAgency(agencyName);
        agency = res.agencyId;
        setNewAgency("");
      }
      const regionList = regions
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      const cap = Number(capacity);
      await createImobBrokerApi({
        name: name.trim(),
        whatsapp: whatsapp.trim(),
        ...(agency ? { agencyId: agency } : {}),
        ...(regionList.length ? { regions: regionList } : {}),
        ...(Number.isFinite(cap) && cap > 0 ? { dailyCapacity: Math.floor(cap) } : {}),
      });
      setName("");
      setWhatsapp("");
      setRegions("");
      setCapacity("10");
      setMsg({ ok: true, text: "Corretor cadastrado! Ele já pode receber leads da SDR no WhatsApp." });
      await refresh();
    } catch (err) {
      setMsg({
        ok: false,
        text: err instanceof Error ? err.message : "Não foi possível cadastrar. Confira o número de WhatsApp.",
      });
    } finally {
      setAdding(false);
    }
  }

  async function doToggleActive(b: ImobBroker) {
    setBusyId(b.id);
    setMsg(null);
    try {
      await patchImobBroker(b.id, { active: !b.active });
      await refresh();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Não foi possível atualizar o corretor." });
    } finally {
      setBusyId(null);
    }
  }

  async function doArchive(b: ImobBroker) {
    setBusyId(b.id);
    setMsg(null);
    try {
      await patchImobBroker(b.id, { archived: true });
      await refresh();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Não foi possível remover o corretor." });
    } finally {
      setBusyId(null);
    }
  }

  async function doSetMode(next: ImobBrokerMode) {
    if (mode === next || modeBusy) return;
    setModeBusy(true);
    setMsg(null);
    try {
      await setImobBrokerModeApi(next);
      setMode(next);
      setMsg({
        ok: true,
        text:
          next === "workspace"
            ? "Modo Workspace ativado: no próximo aceite o corretor recebe um link pessoal e atende pela plataforma."
            : "Modo Ficha ativado: no aceite o corretor recebe o telefone do lead e atende pelo WhatsApp dele.",
      });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Não foi possível trocar o modo." });
    } finally {
      setModeBusy(false);
    }
  }

  async function doCopyLink(b: ImobBroker) {
    setLinkBusyId(b.id);
    setMsg(null);
    try {
      const { link } = await getImobWorkspaceLink(b.id);
      await navigator.clipboard.writeText(link);
      setMsg({ ok: true, text: `Link do workspace de ${b.name} copiado — envie a ele por WhatsApp.` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Não foi possível gerar o link." });
    } finally {
      setLinkBusyId(null);
    }
  }

  return (
    <Card style={{ padding: 18 }}>
      {brokers === null ? (
        <SkeletonBlock height={14} />
      ) : (
        <>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 4 }}>
            Corretores que recebem os leads qualificados
          </strong>
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5 }}>
            A SDR envia a ficha de cada lead qualificado para o WhatsApp do corretor da vez (rodízio por
            região e capacidade). O corretor responde <strong>1</strong> para aceitar — se não responder no
            prazo, o lead vai para o próximo. Sem nenhum corretor cadastrado, a distribuição fica desligada.
          </p>

          {/* Modo de atendimento do empreendimento (0040): decide o que o
              corretor recebe no ACEITE — telefone do lead × link do workspace */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 14px" }}>
            {(
              [
                {
                  value: "ficha" as const,
                  title: "Ficha (WhatsApp do corretor)",
                  desc: "No aceite, o corretor recebe o telefone do lead e atende pelo WhatsApp pessoal dele. Você acompanha pelos status (1-6) que ele reporta.",
                },
                {
                  value: "workspace" as const,
                  title: "Workspace (pela plataforma)",
                  desc: "No aceite, o corretor recebe um link pessoal e atende POR AQUI, pelo número do empreendimento. Você vê a conversa inteira em tempo real.",
                },
              ]
            ).map((opt) => {
              const checked = mode === opt.value;
              return (
                <label
                  key={opt.value}
                  style={{
                    flex: "1 1 240px",
                    border: checked ? "2px solid var(--brand, #e11d2e)" : "1px solid var(--border-300)",
                    borderRadius: 10,
                    padding: "10px 12px",
                    cursor: canManage && !modeBusy ? "pointer" : "default",
                    opacity: mode === null ? 0.6 : 1,
                  }}
                >
                  <input
                    type="radio"
                    name="imob-broker-mode"
                    value={opt.value}
                    checked={checked}
                    disabled={!canManage || modeBusy || mode === null}
                    onChange={() => void doSetMode(opt.value)}
                    style={{ marginRight: 6 }}
                  />
                  <strong style={{ fontSize: 12.5 }}>{opt.title}</strong>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{opt.desc}</div>
                </label>
              );
            })}
          </div>

          {brokers.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "0 0 12px" }}>
              {brokers.map((b) => (
                <div
                  key={b.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    border: "1px solid var(--border-300)",
                    borderRadius: 10,
                    padding: "8px 12px",
                    opacity: b.active ? 1 : 0.6,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 13 }}>
                      {b.name}
                      {!b.active && <span className="muted"> (pausado)</span>}
                    </strong>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      WhatsApp {b.whatsapp}
                      {b.agencyName ? ` · ${b.agencyName}` : ""}
                      {b.regions.length ? ` · ${b.regions.join(", ")}` : ""}
                      {` · até ${b.dailyCapacity} leads/dia`}
                    </div>
                  </div>
                  {canManage && (
                    <div style={{ display: "flex", gap: 10, whiteSpace: "nowrap" }}>
                      {mode === "workspace" && (
                        <button
                          type="button"
                          aria-label={`Copiar link do workspace do corretor ${b.name}`}
                          onClick={() => void doCopyLink(b)}
                          disabled={mutating || linkBusyId !== null}
                          style={{ background: "none", border: "none", cursor: mutating ? "default" : "pointer", fontSize: 12.5, fontWeight: 700, color: "var(--brand, #e11d2e)", padding: 4 }}
                        >
                          {linkBusyId === b.id ? "Gerando…" : "Link do workspace"}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`${b.active ? "Pausar" : "Reativar"} corretor ${b.name}`}
                        onClick={() => void doToggleActive(b)}
                        disabled={mutating}
                        style={{ background: "none", border: "none", cursor: mutating ? "default" : "pointer", fontSize: 12.5, fontWeight: 700, color: "var(--text-subtle)", padding: 4 }}
                      >
                        {busyId === b.id ? "…" : b.active ? "Pausar" : "Reativar"}
                      </button>
                      <button
                        type="button"
                        aria-label={`Remover corretor ${b.name}`}
                        onClick={() => void doArchive(b)}
                        disabled={mutating}
                        style={{ background: "none", border: "none", cursor: mutating ? "default" : "pointer", fontSize: 12.5, fontWeight: 700, color: "var(--error-text)", padding: 4 }}
                      >
                        {busyId === b.id ? "Removendo…" : "Remover"}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5 }}>
              Nenhum corretor cadastrado — os leads qualificados NÃO estão sendo distribuídos.
            </p>
          )}

          {canManage && (
            <>
              <p style={{ margin: "0 0 6px", fontSize: 13 }}>
                Cadastre cada corretor com o <strong>WhatsApp que ele realmente usa</strong> (com DDD, ex.:
                44 99900-1234) — é por esse número que a SDR fala com ele:
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <Input
                  value={name}
                  aria-label="Nome do corretor"
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nome (ex.: João)"
                  style={{ flex: "1 1 140px" }}
                />
                <Input
                  value={whatsapp}
                  aria-label="WhatsApp do corretor"
                  onChange={(e) => setWhatsapp(e.target.value)}
                  placeholder="WhatsApp (55 44 99900-1234)"
                  style={{ flex: "1 1 170px" }}
                />
                <Input
                  value={regions}
                  aria-label="Regiões que o corretor atende"
                  onChange={(e) => setRegions(e.target.value)}
                  placeholder="Regiões (opcional, ex.: Sarandi, Marialva)"
                  style={{ flex: "1 1 200px" }}
                />
                <Input
                  value={capacity}
                  aria-label="Capacidade de leads por dia"
                  onChange={(e) => setCapacity(e.target.value)}
                  placeholder="Leads/dia"
                  inputMode="numeric"
                  style={{ flex: "0 1 90px" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <select
                  value={agencyId}
                  aria-label="Imobiliária do corretor"
                  onChange={(e) => setAgencyId(e.target.value)}
                  disabled={!!newAgency.trim()}
                  style={{ flex: "1 1 170px", padding: "9px 10px", borderRadius: 10, border: "1px solid var(--border-300)", fontSize: 13, background: "var(--surface, #fff)" }}
                >
                  <option value="">Sem imobiliária (independente)</option>
                  {activeAgencies.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <Input
                  value={newAgency}
                  aria-label="Nova imobiliária"
                  onChange={(e) => setNewAgency(e.target.value)}
                  placeholder="…ou nova imobiliária (ex.: ABC Imóveis)"
                  style={{ flex: "1 1 190px" }}
                />
                <Button
                  disabled={mutating || !name.trim() || whatsapp.replace(/\D/g, "").length < 10}
                  onClick={() => void doAdd()}
                >
                  {adding ? "Cadastrando…" : "Adicionar corretor"}
                </Button>
              </div>
            </>
          )}

          {msg && (
            <p
              role={msg.ok ? "status" : "alert"}
              style={{ margin: "10px 0 0", fontSize: 12.5, fontWeight: 600, color: msg.ok ? "var(--success-text)" : "var(--error-text)" }}
            >
              {msg.text}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
