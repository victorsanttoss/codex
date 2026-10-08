"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { activateOnboarding, archiveTemplate, getAgentSettings, getOnboarding, getToken, listTemplates, logout, saveAgentSettings, saveCadenceSettings, saveOnboarding, saveSchedulingSettings, upsertTemplate } from "../../lib/api";
import { CalendarPoolManager } from "../../components/calendar-pool-manager";
import { BrokersManager } from "../../components/brokers-manager";
import { Button, Card, Input, SkeletonBlock, Textarea } from "../../components/ui";
import { KnowledgeManager } from "../../components/knowledge-manager";
import s from "./onboarding.module.css";

// Jornada do FORK IMOBILIÁRIO: a etapa 6 (Corretores parceiros) é o coração
// da vertical — sem corretores cadastrados a distribuição fica desligada.
const STEPS = [
  "Conectar WhatsApp",
  "Seu empreendimento",
  "Ensinar a SDR",
  "Qualificação",
  "Agenda de visitas",
  "Corretores parceiros",
  "Cadência & follow-up",
  "Base de conhecimento",
  "Testar no Playground",
  "Ativar",
];
/** Nº total de etapas — usado em navegação/progresso/DTO (não hardcodar 8/9). */
const LAST_STEP = STEPS.length;

type Payload = Record<string, unknown>;

/** Linha do editor de campos de qualificação (decisão do CLIENTE, não do nicho). */
interface QualRow {
  label: string;
  description?: string;
  required?: boolean;
  weight?: number;
  /** Passthrough da sugestão (novos campos nascem "string"). */
  type?: string;
  /** Passthrough da sugestão (regra eliminatória não é editável no wizard). */
  eliminatory?: unknown;
}

/** Clamp numérico com default — espelha a régua do backend (dado não-confiável). */
function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
}

/**
 * Arquiva templates followup_sem_resposta_N com N > activeCount (reedição do
 * wizard com menos passos deixaria órfãos 'approved'). Best-effort: catálogo
 * inacessível não bloqueia o wizard (o órfão não dispara — cadence.steps manda).
 */
async function archiveOrphanFollowups(activeCount: number): Promise<void> {
  try {
    const rows = await listTemplates();
    const orphans = rows.filter((r) => {
      const m = /^followup_sem_resposta_(\d+)$/.exec(r.name);
      return m && Number(m[1]) > activeCount && r.status !== "archived";
    });
    for (const o of orphans) await archiveTemplate(o.name);
  } catch {
    /* best-effort */
  }
}

/**
 * Dados do negócio (etapa 3) a partir do payload, com coerção do LEGADO
 * (products era array de chips; canPromise/cannotPromise viraram canSay/cannotSay).
 * Usado pela UI da etapa E pelo sync p/ config.business do agente.
 */
function businessFromPayload(payload: Payload): { products: string; tone: string; canSay: string; cannotSay: string } {
  return {
    products:
      typeof payload.products === "string"
        ? payload.products
        : Array.isArray(payload.products)
          ? (payload.products as string[]).join(", ")
          : "",
    tone: typeof payload.tone === "string" ? payload.tone : "",
    canSay: (payload.canSay as string) ?? (payload.canPromise as string) ?? "",
    cannotSay: (payload.cannotSay as string) ?? (payload.cannotPromise as string) ?? "",
  };
}

/** Nome digitado pelo cliente → key do motor (snake_case sem acento). */
function slugifyKey(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "campo"
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [maxStep, setMaxStep] = useState(1);
  const [payload, setPayload] = useState<Payload>({});
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [stepError, setStepError] = useState("");
  // MODO REVISÃO (pós-ativação): o cliente volta ao wizard para VER e ALTERAR
  // tudo que preencheu (?revisar=1, opcional ?etapa=N). Navegação livre entre as
  // 10 etapas; cada navegação APLICA a etapa atual (nada se perde em silêncio).
  const [review, setReview] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    getOnboarding()
      .then((o) => {
        setPayload(o.payload ?? {});
        if (o.activatedAt) {
          const params = new URLSearchParams(window.location.search);
          if (!params.has("revisar")) {
            router.replace("/inicio");
            return;
          }
          const etapa = Number(params.get("etapa"));
          setReview(true);
          setMaxStep(LAST_STEP);
          setStep(Number.isInteger(etapa) && etapa >= 1 && etapa <= LAST_STEP ? etapa : 1);
          return;
        }
        setStep(o.step);
        setMaxStep(o.step);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, [router]);

  // AUTOSAVE de rascunho (torna o "Salvo automaticamente" VERDADEIRO): o que o
  // cliente digita DENTRO da etapa sobrevive a fechar o navegador — a retomada
  // continua exatamente de onde parou, não só na fronteira do Continuar.
  // Best-effort com debounce; o save BLOQUEANTE (que aplica efeitos e valida)
  // continua sendo o do Continuar/goTo. Envia SÓ o DELTA editado (Codex): o
  // servidor faz merge do patch, então um autosave em voo que aterrissa depois
  // do save do goTo não sobrescreve chaves que não são do usuário (ex.:
  // cadenceMetaPending). SÓ no fluxo normal: em modo revisão o contrato é
  // "aplica ao navegar" — rascunho fantasma divergiria da config real do agente.
  const dirtyRef = useRef(false);
  const draftRef = useRef<Payload>({});

  function patch(p: Payload) {
    Object.assign(draftRef.current, p);
    dirtyRef.current = true;
    setPayload((prev) => ({ ...prev, ...p }));
  }

  useEffect(() => {
    if (!ready || review || !dirtyRef.current) return;
    const t = setTimeout(() => {
      const delta = draftRef.current;
      draftRef.current = {};
      dirtyRef.current = false;
      void saveOnboarding(maxStep, delta).catch(() => {
        // Falhou: devolve o delta SEM sobrescrever edições mais novas.
        draftRef.current = { ...delta, ...draftRef.current };
        dirtyRef.current = true;
      });
    }, 1200);
    return () => clearTimeout(t);
  }, [payload, ready, review, maxStep]);

  /**
   * Aplica os efeitos REAIS da etapa atual (config do agente, templates,
   * cadência) antes de sair dela. Devolve o patch extra a mesclar no payload,
   * ou null em falha (stepError setado) — a navegação é BLOQUEADA: decisão do
   * cliente não aplicada não pode passar em silêncio.
   */
  async function applyStep(current: number): Promise<Payload | null> {
    // Ao SAIR da etapa 3, o que o cliente ensinou vira a camada de NEGÓCIO do
    // prompt (config.business). Sem este sync os textos ficavam SÓ no payload
    // do onboarding e a SDR nunca os via.
    if (current === 3) {
      try {
        await saveAgentSettings({ business: businessFromPayload(payload) });
      } catch {
        setStepError("Não conseguimos salvar os dados do seu negócio. Tente Continuar novamente.");
        return null;
      }
    }
    // Ao SAIR da etapa 4, a decisão do cliente vira a config REAL do tenant
    // (camada tenant > nicho — o nicho é só a sugestão inicial). DESLIGADA
    // também persiste (achado Codex): `enabled:false` chega ao motor e a SDR
    // de fato para de extrair/pontuar — antes o toggle era só visual.
    if (current === 4) {
      const enabled = payload.qualificationEnabled !== false;
      const rows = ((payload.qualificationFields as QualRow[]) ?? []).filter((r) => r.label.trim());
      const seen = new Set<string>();
      const fields = rows.flatMap((r) => {
        const key = slugifyKey(r.label);
        if (seen.has(key)) return []; // nomes duplicados → vale o primeiro
        seen.add(key);
        return [{
          key,
          type: r.type ?? "string",
          required: !!r.required,
          // Clamp na MESMA régua do backend: valor inválido invalidaria a
          // qualification INTEIRA no validQualification (cairia no default).
          weight: clampNum(r.weight, 0, 10, 1),
          // Descrição alimenta a EXTRAÇÃO (modelos pequenos precisam dela);
          // sem descrição, o próprio nome legível do campo serve.
          description: (r.description?.trim() || r.label.trim()).slice(0, 300),
          ...(r.eliminatory !== undefined && r.eliminatory !== null ? { eliminatory: r.eliminatory } : {}),
        }];
      });
      const qualifyAtScore = clampNum(payload.qualifyAtScore, 0, 30, 2);
      // Ligada sem NENHUM campo salvo: não sobrescreve (o banner da etapa avisa
      // que a configuração anterior continua valendo).
      if (!enabled || fields.length > 0) {
        try {
          await saveAgentSettings({ qualification: { enabled, qualifyAtScore, fields } });
        } catch {
          setStepError("Não conseguimos salvar seus campos de qualificação. Tente Continuar novamente.");
          return null;
        }
      }
    }
    // Ao SAIR da etapa 5 (Agenda), a decisão vira a config REAL de agendamento
    // (0034): habilitado, horários de atendimento e duração. O vínculo com o
    // Google é aplicado na hora pelo botão "Validar e vincular" (ação própria,
    // com validação de acesso) — aqui só persiste o restante.
    if (current === 5) {
      try {
        await saveSchedulingSettings({
          enabled: payload.schedulingEnabled !== false,
          durationMinutes: clampNum(payload.schedulingDuration, 15, 240, 60),
          hours: schedulingHoursFromPayload(payload),
        });
      } catch {
        setStepError("Não conseguimos salvar sua agenda. Tente Continuar novamente.");
        return null;
      }
    }
    // Etapa 6 (Corretores parceiros) salva inline pelo BrokersManager — sem
    // efeito ao sair. Ao SAIR da etapa 7, o follow-up vira REAL (M8-ext): cada
    // mensagem do cenário "sem_resposta" vira um template do catálogo (corpo
    // do cliente; na Cloud API a submissão à Meta sai automática e o status
    // fica pending até o webhook aprovar) e a cadência do motor é
    // ligada/desligada conforme o toggle.
    if (current === 7) {
      try {
        if (payload.cadenceEnabled === true) {
          const journeys = (payload.cadenceJourneys as CadenceJourney[] | undefined) ?? [];
          const main = journeys.find((j) => j.scenario === "sem_resposta");
          const steps = (main?.steps ?? [])
            .filter((st) => st.message.trim())
            .map((st) => ({ afterDays: clampNum(st.afterDays, 0, 30, 0), message: st.message.trim().slice(0, 1024) }))
            .sort((a, b) => a.afterDays - b.afterDays)
            .slice(0, 10);
          if (steps.length > 0) {
            let anyPending = false;
            for (let i = 0; i < steps.length; i++) {
              const res = await upsertTemplate({ name: `followup_sem_resposta_${i + 1}`, bodyText: steps[i]!.message });
              if (res.status === "pending") anyPending = true;
            }
            // Dias absolutos → delays RELATIVOS via alvos absolutos (achado
            // Codex: calcular delta a delta empurrava os dias seguintes quando
            // havia colisão no mesmo dia). Mesmo-dia: 1h do gatilho, +1h por
            // colisão; o delta seguinte desconta o alvo já ajustado.
            let prevTarget = 0;
            const cadSteps = steps.map((st, i) => {
              const sameDayIdx = steps.slice(0, i).filter((x) => x.afterDays === st.afterDays).length;
              const target = (st.afterDays === 0 ? 60 : st.afterDays * 1440) + sameDayIdx * 60;
              const delayMinutes = Math.max(5, target - prevTarget);
              prevTarget = target;
              return { delayMinutes, templateName: `followup_sem_resposta_${i + 1}`, languageCode: "pt_BR" };
            });
            await saveCadenceSettings({ enabled: true, steps: cadSteps });
            // Arquiva ÓRFÃOS da família (achado Codex): reedição com menos
            // passos deixava followup_sem_resposta_N 'approved' no catálogo.
            await archiveOrphanFollowups(steps.length);
            return { cadenceMetaPending: anyPending };
          }
          // Ligado sem nenhuma mensagem escrita → nada a disparar: motor OFF.
          await saveCadenceSettings({ enabled: false });
          await archiveOrphanFollowups(0);
        } else {
          await saveCadenceSettings({ enabled: false });
          await archiveOrphanFollowups(0);
        }
      } catch {
        setStepError("Não conseguimos salvar seu follow-up. Tente Continuar novamente.");
        return null;
      }
    }
    return {};
  }

  /** Aplica a etapa atual, persiste o payload e navega. Usada pelo Continuar e,
   *  no modo revisão, também pela navegação livre do stepper (edição não some). */
  async function goTo(target: number) {
    if (target === step) return;
    setSaving(true);
    setStepError("");
    try {
      const extra = await applyStep(step);
      if (extra === null) return;
      await saveOnboarding(Math.max(maxStep, target), { ...payload, ...extra });
      // Payload inteiro persistido — rascunho pendente do autosave já está coberto.
      draftRef.current = {};
      dirtyRef.current = false;
      if (Object.keys(extra).length > 0) setPayload((prev) => ({ ...prev, ...extra }));
      setStep(target);
      setMaxStep((m) => Math.max(m, target));
    } finally {
      setSaving(false);
    }
  }

  async function next() {
    await goTo(Math.min(LAST_STEP, step + 1));
  }

  /** Sai do modo revisão APLICANDO a etapa atual — a mesma regra do goTo:
   *  alteração feita não pode se perder em silêncio ao voltar ao painel. */
  async function leaveReview() {
    setSaving(true);
    setStepError("");
    try {
      const extra = await applyStep(step);
      if (extra === null) return;
      await saveOnboarding(maxStep, { ...payload, ...extra });
      draftRef.current = {};
      dirtyRef.current = false;
      router.push("/configuracao");
    } finally {
      setSaving(false);
    }
  }

  async function finish() {
    setSaving(true);
    try {
      await activateOnboarding();
      router.push("/inicio");
    } finally {
      setSaving(false);
    }
  }

  if (!ready) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }} aria-busy="true" aria-label="Carregando">
        <div style={{ width: 260, display: "flex", flexDirection: "column", gap: 10 }}>
          <SkeletonBlock height={14} width="60%" />
          <SkeletonBlock height={14} />
          <SkeletonBlock height={14} width="80%" />
        </div>
      </div>
    );
  }

  return (
    <main className={s.wrap}>
      <aside className={s.rail}>
        <div className={s.railBrand}>
          <span className={s.railMark}>V4</span>
          <strong style={{ fontSize: 14 }}>{review ? "Revisar sua SDR" : "Configurar sua SDR"}</strong>
        </div>
        {review && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void leaveReview()}
            style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: "var(--red-700)", margin: "10px 0 4px", background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            ← Voltar para Configuração
          </button>
        )}
        <div className={s.progressTrack}><div className={s.progressFill} style={{ width: `${(step / LAST_STEP) * 100}%` }} /></div>
        <div className={s.steps}>
          {STEPS.map((label, i) => {
            const n = i + 1;
            const done = n < step;
            const current = n === step;
            return (
              <button
                key={label}
                className={[s.step, current ? s.stepCurrent : ""].join(" ")}
                disabled={n > maxStep || saving}
                // Navegar pelo stepper APLICA a etapa atual antes (mesma rota do
                // Continuar) — edição nunca se perde em silêncio (achado Codex:
                // valia também para o fluxo normal, ex.: volta à etapa 3, edita,
                // pula adiante pelo stepper e o negócio ficava sem sync).
                onClick={() => n <= maxStep && void goTo(n)}
              >
                <span className={[s.stepNum, current ? s.stepNumCurrent : done ? s.stepNumDone : ""].join(" ")}>{done ? "✓" : n}</span>
                {label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => void logoutToLogin()}
          style={{ marginTop: "auto", paddingTop: 14, background: "none", border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: "var(--text-subtle)", textAlign: "left" }}
        >
          ← Sair da conta
        </button>
      </aside>

      <section className={s.content}>
        <div className={s.contentTop}><span className={s.savedDot} /> {review ? "Alterações aplicadas ao navegar entre etapas" : "Salvo automaticamente"}</div>
        <div className={s.body}>
          <Step step={step} payload={payload} patch={patch} />
        </div>
        {stepError && (
          <div role="alert" style={{ margin: "0 32px", padding: "10px 14px", borderRadius: 10, background: "var(--error-bg)", color: "var(--error-text)", fontSize: 13, fontWeight: 600 }}>
            {stepError}
          </div>
        )}
        <div className={s.footer}>
          <Button
            variant="ghost"
            disabled={step === 1 || saving}
            onClick={() => void goTo(Math.max(1, step - 1))}
          >
            Voltar
          </Button>
          {step < LAST_STEP ? (
            <Button disabled={saving} onClick={next}>{saving ? "Salvando…" : review ? "Salvar e continuar" : "Continuar"}</Button>
          ) : review ? (
            // Já ativada — revisão não re-ativa nada, aplica a etapa e volta.
            <Button disabled={saving} onClick={() => void leaveReview()}>{saving ? "Salvando…" : "Concluir revisão"}</Button>
          ) : (
            <Button disabled={saving} onClick={finish}>{saving ? "Ativando…" : "Ativar SDR"}</Button>
          )}
        </div>
      </section>
    </main>
  );
}

function Step({ step, payload, patch }: { step: number; payload: Payload; patch: (p: Payload) => void }) {
  if (step === 1) return <StepConnect payload={payload} patch={patch} />;
  if (step === 2) return <StepNiche payload={payload} patch={patch} />;
  if (step === 3) return <StepBusiness payload={payload} patch={patch} />;
  if (step === 4) return <StepQualify payload={payload} patch={patch} />;
  if (step === 5) return <StepAgenda payload={payload} patch={patch} />;
  if (step === 6) return <StepBrokers />;
  if (step === 7) return <StepCadence payload={payload} patch={patch} />;
  if (step === 8) return <StepKnowledge />;
  if (step === 9) return <StepTest />;
  return <StepActivate />;
}

/** Sai da conta no meio do wizard (trocar de conta) — o rascunho fica salvo no servidor. */
async function logoutToLogin(): Promise<void> {
  await logout();
  window.location.href = "/login";
}

/** Horários de atendimento (etapa 5) do payload, na régua do backend. */
function schedulingHoursFromPayload(payload: Payload): { startHour: number; endHour: number; days: number[] } {
  const h = (payload.schedulingHours ?? {}) as Record<string, unknown>;
  const days = Array.isArray(h.days)
    ? (h.days as unknown[]).filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6)
    : [1, 2, 3, 4, 5];
  const startHour = clampNum(h.startHour, 0, 23, 9);
  return {
    startHour,
    endHour: Math.max(clampNum(h.endHour, 1, 24, 18), startHour + 1),
    days: days.length > 0 ? days : [1, 2, 3, 4, 5],
  };
}

function Title({ kicker, title, sub }: { kicker: string; title: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div className="eyebrow" style={{ marginBottom: 6 }}>{kicker}</div>
      <h1 className="h1-page" style={{ marginBottom: 6 }}>{title}</h1>
      {sub && <p className="muted" style={{ margin: 0 }}>{sub}</p>}
    </div>
  );
}

function StepConnect({ payload, patch }: { payload: Payload; patch: (p: Payload) => void }) {
  const choice = payload.whatsapp as string | undefined;
  return (
    <div>
      <Title kicker="Etapa 1 de 10" title="Conecte o WhatsApp do empreendimento" sub="É o número que atende os leads das campanhas. Recomendamos a conexão oficial — mais estável e sem risco para o número." />
      <div className={s.cardGrid} style={{ gridTemplateColumns: "1fr 1fr" }}>
        <button className={[s.choice, choice === "oficial" ? s.choiceOn : ""].join(" ")} onClick={() => patch({ whatsapp: "oficial" })}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <strong>WhatsApp Oficial</strong>
            <span style={{ fontSize: 10.5, fontWeight: 800, color: "var(--success-text)", background: "var(--success-tint)", padding: "2px 8px", borderRadius: 999 }}>RECOMENDADO</span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Conecte em poucos cliques pela API oficial da Meta. Selo verificado, sem risco de bloqueio.</p>
          <Link href="/connect" style={{ display: "inline-block", marginTop: 12, fontSize: 13, fontWeight: 700, color: "var(--red-700)" }}>Abrir conexão oficial →</Link>
        </button>
        <button className={[s.choice, choice === "qr" ? s.choiceOn : ""].join(" ")} onClick={() => patch({ whatsapp: "qr" })}>
          <strong>Ler QR Code</strong>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>Conecta lendo um QR no app, como o WhatsApp Web. Mais rápido, porém menos estável.</p>
          <Link href="/connect-baileys" style={{ display: "inline-block", marginTop: 12, fontSize: 13, fontWeight: 700, color: "var(--red-700)" }}>Gerar QR →</Link>
        </button>
      </div>
    </div>
  );
}

/** Ramos MACRO — atalhos para quem não quer escrever (preenchem a caixa). */
// Fork imobiliário: chips do SEGMENTO (o wizard padrão tem a lista genérica).
const MACRO_NICHES = [
  "Lançamento MCMV",
  "Lançamento médio/alto padrão",
  "Loteamento",
  "Imobiliária — venda de usados",
  "Imobiliária — locação",
  "Multipropriedade / lazer",
];
function StepNiche({ payload, patch }: { payload: Payload; patch: (p: Payload) => void }) {
  const niche = (payload.niche as string | undefined) ?? "";
  const norm = niche.trim().toLowerCase();
  return (
    <div>
      <Title kicker="Etapa 2 de 10" title="Qual é o seu empreendimento?" sub="Descreva com suas palavras o que você está vendendo — isso prepara a SDR com o jeito certo de qualificar no seu mercado." />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label htmlFor="niche-ramo" className="eyebrow">Empreendimento / operação</label>
        <Textarea
          id="niche-ramo"
          value={niche}
          onChange={(e) => patch({ niche: e.target.value.slice(0, 200) })}
          placeholder="Ex.: Residencial MCMV em Sarandi-PR — apartamentos de 2 quartos, faixa 2, vendas por corretores parceiros"
          rows={3}
          maxLength={200}
        />
        <div className="caption" style={{ textAlign: "right" }}>{niche.length}/200</div>
      </div>

      <div style={{ marginTop: 18 }}>
        <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>Não quer escrever? Escolha um ramo para começar:</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {MACRO_NICHES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={norm === m.toLowerCase()}
              className={[s.chip, norm === m.toLowerCase() ? s.chipOn : ""].join(" ")}
              // Toggle: clicar no chip já ativo LIMPA o campo (desselecionar).
              onClick={() => patch({ niche: norm === m.toLowerCase() ? "" : m })}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Anexo de documento (opcional). Registra o NOME do arquivo no estado do
 * onboarding — o conteúdo ainda não é processado pela IA (wiring de ingestão é
 * follow-up); serve para o cliente já subir o material de referência.
 */
function AttachField({
  docName,
  onPick,
  onClear,
  hint,
  subject,
}: {
  docName: string;
  onPick: (name: string) => void;
  onClear: () => void;
  hint: string;
  /** Descrição do documento p/ leitores de tela (ex.: "de produtos e serviços"). */
  subject: string;
}) {
  if (docName) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, border: "1.5px solid var(--border-300)", borderRadius: 10, padding: "10px 14px", background: "var(--surface-subtle)" }}>
        <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📄 {docName}</span>
        <button type="button" onClick={onClear} aria-label={`Remover documento ${subject}`} style={{ fontSize: 12, fontWeight: 700, color: "var(--red-700)", background: "none", border: "none", cursor: "pointer", flex: "none" }}>Remover</button>
      </div>
    );
  }
  return (
    <label style={{ display: "block", position: "relative", border: "1.5px dashed var(--border-300)", borderRadius: 10, padding: 16, textAlign: "center", color: "var(--text-muted)", cursor: "pointer", background: "var(--surface-subtle)", fontSize: 13 }}>
      <input
        type="file"
        accept=".pdf,.doc,.docx,.txt,.md"
        aria-label={`Anexar documento ${subject}`}
        // Visualmente oculto mas FOCÁVEL (display:none tiraria do teclado).
        style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
        onChange={(e) => {
          const name = e.target.files?.[0]?.name;
          if (name) onPick(name);
        }}
      />
      📎 Anexar documento <span style={{ opacity: 0.7 }}>(opcional)</span> — <strong style={{ color: "var(--red-700)" }}>escolher arquivo</strong>
      <div className="caption" style={{ marginTop: 4 }}>PDF, DOC/DOCX, TXT ou MD (markdown é o que a IA lê melhor) · {hint} · a leitura automática do conteúdo chega em breve</div>
    </label>
  );
}

function StepBusiness({ payload, patch }: { payload: Payload; patch: (p: Payload) => void }) {
  const { products, tone, canSay, cannotSay } = businessFromPayload(payload);
  const productsDoc = (payload.productsDocName as string) || "";
  const toneDoc = (payload.toneDocName as string) || "";
  return (
    <div>
      <Title kicker="Etapa 3 de 10" title="Ensine o empreendimento à SDR" sub="Descreva o que está à venda, o tom de voz e as regras do que a SDR pode ou não falar." />
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Empreendimento / imóveis</div>
          <Textarea
            aria-label="Empreendimento e imóveis à venda"
            defaultValue={products}
            onChange={(e) => patch({ products: e.target.value })}
            placeholder="Descreva da forma mais completa possível: tipologias (2 quartos, 45m²), lazer e diferenciais, localização, faixas de preço, condições de entrada, uso de FGTS/subsídio, prazo de entrega…"
            style={{ minHeight: 130 }}
          />
          <div style={{ marginTop: 10 }}>
            <AttachField subject="do empreendimento" docName={productsDoc} onPick={(n) => patch({ productsDocName: n })} onClear={() => patch({ productsDocName: "" })} hint="tabela de preços, book do empreendimento, espelho de vendas" />
          </div>
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Tom de voz</div>
          <Textarea
            aria-label="Tom de voz da SDR"
            defaultValue={tone}
            onChange={(e) => patch({ tone: e.target.value })}
            placeholder="Como você quer que a SDR fale? Ex.: acolhedora e próxima, chama pelo primeiro nome, sem gírias, evita termos técnicos…"
            style={{ minHeight: 100 }}
          />
          <div style={{ marginTop: 10 }}>
            <AttachField subject="de tom de voz" docName={toneDoc} onPick={(n) => patch({ toneDocName: n })} onClear={() => patch({ toneDocName: "" })} hint="manual de tom de voz, guia de marca" />
          </div>
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Regras — o que a SDR pode e não pode falar</div>
          <div className={s.promiseGrid}>
            <div className={[s.promiseBox, s.promiseYes].join(" ")}>
              <div className="eyebrow" style={{ color: "var(--success-text)", marginBottom: 8 }}>✓ Pode falar</div>
              <Textarea aria-label="O que a SDR pode falar" defaultValue={canSay} onChange={(e) => patch({ canSay: e.target.value })} placeholder="Ex.: valores 'a partir de', uso de FGTS e subsídio na entrada, condições de lançamento, agendar visita ao decorado…" style={{ minHeight: 80 }} />
            </div>
            <div className={[s.promiseBox, s.promiseNo].join(" ")}>
              <div className="eyebrow" style={{ color: "var(--error-text)", marginBottom: 8 }}>✕ Não pode falar</div>
              <Textarea aria-label="O que a SDR não pode falar" defaultValue={cannotSay} onChange={(e) => patch({ cannotSay: e.target.value })} placeholder="Ex.: garantir aprovação de financiamento, prometer valor exato de subsídio ou parcela, prazo de entrega diferente do oficial…" style={{ minHeight: 80 }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepQualify({ payload, patch }: { payload: Payload; patch: (p: Payload) => void }) {
  // Qualificação é OPCIONAL: default LIGADA (ausente = true); desligada, a SDR
  // só atende/conversa sem pontuar lead.
  const enabled = payload.qualificationEnabled !== false;
  const rules = typeof payload.qualificationRules === "string" ? payload.qualificationRules : "";
  const doc = (payload.qualificationDocName as string) || "";
  return (
    <div>
      <Title kicker="Etapa 4 de 10" title="Como a SDR qualifica um lead" sub="A IA extrai os dados na conversa (renda, FGTS, prazo…) e o sistema pontua o lead — qualificou, vai para um corretor parceiro." />

      <Card style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
        <div>
          <strong style={{ fontSize: 14 }}>Qualificação automática de leads</strong>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {enabled
              ? "Ativa — a SDR coleta os dados e pontua cada lead durante a conversa."
              : "Desativada — a SDR atende e responde normalmente, sem pontuar leads."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Ativar qualificação automática de leads"
          onClick={() => patch({ qualificationEnabled: !enabled })}
          style={{ flex: "none", width: 46, height: 26, borderRadius: 999, border: "none", cursor: "pointer", position: "relative", transition: "background .15s", background: enabled ? "var(--red-700)" : "var(--border-300)" }}
        >
          <span aria-hidden style={{ position: "absolute", top: 3, left: enabled ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,.25)" }} />
        </button>
      </Card>

      {enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <QualFieldsEditor payload={payload} patch={patch} />

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="eyebrow">Regras de qualificação (texto livre)</div>
            <Textarea
              aria-label="Regras de qualificação de leads"
              defaultValue={rules}
              onChange={(e) => patch({ qualificationRules: e.target.value })}
              placeholder="Descreva o que torna um lead qualificado para você. Ex.: renda familiar a partir de R$ 2.000; não possui imóvel no nome; quer mudar nos próximos 6 meses; mora na região do empreendimento…"
              style={{ minHeight: 120 }}
            />
            <AttachField subject="de regras de qualificação" docName={doc} onPick={(n) => patch({ qualificationDocName: n })} onClear={() => patch({ qualificationDocName: "" })} hint="critérios de score, playbook comercial" />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Editor dos CAMPOS de qualificação — a decisão é do CLIENTE. O nicho entra
 * apenas como SUGESTÃO inicial (semeada uma única vez a partir da config
 * resolvida); a partir daí o cliente edita, remove e adiciona à vontade, e ao
 * sair da etapa a lista vira a config do tenant (vence o nicho).
 */
function QualFieldsEditor({ payload, patch }: { payload: Payload; patch: (p: Payload) => void }) {
  const rows = payload.qualificationFields as QualRow[] | undefined;
  const score = typeof payload.qualifyAtScore === "number" ? payload.qualifyAtScore : 2;

  useEffect(() => {
    if (rows) return; // já semeado (ou o cliente já mexeu) — não sobrescrever
    getAgentSettings()
      .then((s) => {
        patch({
          qualificationFields: s.qualification.fields.map((f) => ({
            label: f.key.replace(/_/g, " "),
            description: f.description ?? "",
            required: !!f.required,
            weight: typeof f.weight === "number" ? f.weight : 1,
            type: f.type ?? "string",
            ...(f.eliminatory !== undefined && f.eliminatory !== null ? { eliminatory: f.eliminatory } : {}),
          })),
          qualifyAtScore: s.qualification.qualifyAtScore,
        });
      })
      .catch(() => patch({ qualificationFields: [] })); // sem sugestão → começa vazio
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const set = (list: QualRow[]) => patch({ qualificationFields: list });
  const update = (i: number, p: Partial<QualRow>) => set(rows!.map((r, j) => (j === i ? { ...r, ...p } : r)));

  if (!rows) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="eyebrow">Campos de qualificação</div>
        <SkeletonBlock height={38} /><SkeletonBlock height={38} /><SkeletonBlock height={38} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="eyebrow">Campos de qualificação</div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 2px" }}>
        Sugestão inicial baseada no seu ramo — <strong>você decide</strong>: edite, remova ou adicione campos. O que ficar aqui é o que vale.
      </p>
      {rows.length === 0 && (
        <div style={{ padding: "10px 14px", borderRadius: 10, background: "var(--warning-tint)", color: "var(--warning-text)", fontSize: 13 }}>
          Sem campos salvos, continua valendo a configuração anterior — adicione ao menos um campo, ou desligue a qualificação lá em cima.
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", border: "1px solid var(--border-200)", borderRadius: 10, padding: "8px 10px" }}>
          <Input
            aria-label={`Nome do campo ${i + 1}`}
            value={r.label}
            onChange={(e) => update(i, { label: e.target.value })}
            placeholder="Nome do campo (ex.: procedimento)"
            style={{ flex: "1 1 150px", minWidth: 130 }}
          />
          <Input
            aria-label={`Como identificar o campo ${i + 1} na conversa`}
            value={r.description ?? ""}
            onChange={(e) => update(i, { description: e.target.value })}
            placeholder="Como identificar na conversa (ajuda a IA)"
            style={{ flex: "2 1 220px", minWidth: 180 }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer", flex: "none" }}>
            <input type="checkbox" checked={!!r.required} onChange={(e) => update(i, { required: e.target.checked })} />
            Obrigatório
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, flex: "none" }}>
            Peso
            <Input
              aria-label={`Peso do campo ${i + 1}`}
              type="number"
              min={0}
              max={10}
              value={typeof r.weight === "number" ? r.weight : 1}
              onChange={(e) => update(i, { weight: Number(e.target.value) })}
              style={{ width: 62 }}
            />
          </label>
          <button
            type="button"
            aria-label={`Remover campo ${r.label || i + 1}`}
            onClick={() => set(rows.filter((_, j) => j !== i))}
            style={{ flex: "none", border: "none", background: "none", color: "var(--red-700)", fontWeight: 800, fontSize: 16, cursor: "pointer", padding: "2px 6px" }}
          >
            ×
          </button>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <Button variant="secondary" size="sm" onClick={() => set([...rows, { label: "", description: "", required: false, weight: 1, type: "string" }])}>
          + Adicionar campo
        </Button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
          Pontuação mínima para qualificar
          <Input
            aria-label="Pontuação mínima para qualificar"
            type="number"
            min={0}
            max={30}
            value={score}
            onChange={(e) => patch({ qualifyAtScore: Number(e.target.value) })}
            style={{ width: 62 }}
          />
        </label>
      </div>
    </div>
  );
}

/** Um passo de follow-up escrito pelo CLIENTE. */
interface CadenceStepRow {
  /** Dias após o gatilho do cenário (0 = no mesmo dia). */
  afterDays: number;
  message: string;
}
interface CadenceJourney {
  scenario: string;
  steps: CadenceStepRow[];
}

/**
 * Cenários de jornada. Só "sem_resposta" está ligado ao motor hoje (a cadência
 * do M8 arma quando o lead some); os demais ficam salvos e entram quando o motor
 * ganhar esses gatilhos — o wizard coleta desde já para não perder a decisão.
 */
const CADENCE_SCENARIOS = [
  { id: "sem_resposta", label: "Lead parou de responder", active: true, hint: "Dispara quando o lead some no meio da conversa." },
  { id: "qualificado_sem_agendamento", label: "Qualificado, mas não agendou", active: false, hint: "Lead qualificado que não marcou horário." },
  { id: "desqualificado_reengajamento", label: "Desqualificado — reengajar depois", active: false, hint: "Retomar o contato depois de um tempo." },
];

/** Sugestão inicial editável do cenário principal (o cliente reescreve à vontade). */
const CADENCE_SEED: CadenceJourney[] = [
  {
    scenario: "sem_resposta",
    steps: [
      { afterDays: 0, message: "Oi! Ficou alguma dúvida sobre o empreendimento? Estou por aqui para te ajudar 😊" },
      { afterDays: 1, message: "Passando para saber se você ainda tem interesse — posso verificar as condições de entrada e o uso do FGTS para o seu caso?" },
      { afterDays: 3, message: "Vou deixar seu atendimento aberto por aqui. Quando quiser retomar (valores, plantas, visita), é só mandar uma mensagem!" },
    ],
  },
  { scenario: "qualificado_sem_agendamento", steps: [] },
  { scenario: "desqualificado_reengajamento", steps: [] },
];

/** Rótulo amigável do status de aprovação de um template. */
const TEMPLATE_STATUS_LABEL: Record<string, { text: string; tone: "ok" | "wait" | "bad" }> = {
  approved: { text: "✓ Aprovada", tone: "ok" },
  pending: { text: "⏳ Aguardando aprovação da Meta", tone: "wait" },
  rejected: { text: "✕ Rejeitada pela Meta — reescreva a mensagem", tone: "bad" },
  paused: { text: "Pausada pela Meta", tone: "bad" },
};

const WEEKDAYS_UI = [
  { d: 1, l: "Seg" },
  { d: 2, l: "Ter" },
  { d: 3, l: "Qua" },
  { d: 4, l: "Qui" },
  { d: 5, l: "Sex" },
  { d: 6, l: "Sáb" },
  { d: 0, l: "Dom" },
];

/**
 * Etapa 5 — Agenda & horários (0034): a SDR passa a AGENDAR o lead qualificado
 * direto na agenda. O cliente escolhe onde a agenda mora (plataforma ou Google
 * via conta de serviço) e a janela de atendimento. O vínculo Google valida o
 * acesso NA HORA (botão), para o erro aparecer aqui e não no meio de uma conversa.
 */
function StepAgenda({ payload, patch }: { payload: Payload; patch: (p: Payload) => void }) {
  const enabled = payload.schedulingEnabled !== false;
  const hours = schedulingHoursFromPayload(payload);
  const duration = clampNum(payload.schedulingDuration, 15, 240, 60);

  function toggleDay(d: number) {
    const days = hours.days.includes(d) ? hours.days.filter((x) => x !== d) : [...hours.days, d];
    if (days.length === 0) return; // pelo menos um dia
    patch({ schedulingHours: { ...hours, days } });
  }

  return (
    <div>
      <Title
        kicker="Etapa 5 de 10"
        title="Agenda de visitas"
        sub="Opcional — a SDR pode oferecer dois horários reais e agendar a visita ao stand/decorado sozinha. Se preferir que só o corretor agende, desligue."
      />

      <Card style={{ padding: 18, marginBottom: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => patch({ schedulingEnabled: e.target.checked })} />
          <div>
            <strong style={{ fontSize: 14 }}>Deixar a SDR agendar sozinha</strong>
            <p className="muted" style={{ margin: "2px 0 0", fontSize: 12.5 }}>
              Desligado, a SDR volta a encaminhar o lead qualificado para o seu time marcar manualmente.
            </p>
          </div>
        </label>
      </Card>

      {enabled && (
        <>
          <Card style={{ padding: 18, marginBottom: 14 }}>
            <strong style={{ fontSize: 13.5, display: "block", marginBottom: 10 }}>Horários de atendimento</strong>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {WEEKDAYS_UI.map((w) => (
                <button
                  key={w.d}
                  type="button"
                  className={[s.choice, hours.days.includes(w.d) ? s.choiceOn : ""].join(" ")}
                  style={{ padding: "6px 12px", fontSize: 12.5 }}
                  onClick={() => toggleDay(w.d)}
                >
                  {w.l}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
              <label>
                Das{" "}
                <select value={hours.startHour} onChange={(e) => patch({ schedulingHours: { ...hours, startHour: Number(e.target.value) } })}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                  ))}
                </select>
              </label>
              <label>
                às{" "}
                <select value={hours.endHour} onChange={(e) => patch({ schedulingHours: { ...hours, endHour: Number(e.target.value) } })}>
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                    <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                  ))}
                </select>
              </label>
              <label>
                Duração:{" "}
                <select value={duration} onChange={(e) => patch({ schedulingDuration: Number(e.target.value) })}>
                  {[30, 45, 60, 90, 120].map((m) => (
                    <option key={m} value={m}>{m} min</option>
                  ))}
                </select>
              </label>
            </div>
          </Card>

          <div style={{ marginTop: 14 }}>
            <CalendarPoolManager />
          </div>
        </>
      )}
    </div>
  );
}

function StepCadence({ payload, patch }: { payload: Payload; patch: (p: Payload) => void }) {
  // Opt-in consciente (mesmo default do motor): o cliente LIGA o follow-up.
  const enabled = payload.cadenceEnabled === true;
  const journeys = (payload.cadenceJourneys as CadenceJourney[] | undefined) ?? CADENCE_SEED;
  const setJourneys = (js: CadenceJourney[]) => patch({ cadenceJourneys: js });

  // Status REAL do catálogo (aprovação da Meta chega via webhook) — badges por
  // mensagem já salva. Antes do 1º "Continuar" não há templates: sem badge.
  const [tmplStatus, setTmplStatus] = useState<Record<string, string>>({});
  useEffect(() => {
    listTemplates()
      .then((rows) => {
        const m: Record<string, string> = {};
        for (const r of rows) m[r.name] = r.status;
        setTmplStatus(m);
      })
      .catch(() => {});
  }, []);
  const anyPending = Object.entries(tmplStatus).some(
    ([name, st]) => name.startsWith("followup_sem_resposta_") && st === "pending",
  );

  return (
    <div>
      <Title kicker="Etapa 7 de 10" title="Follow-up automático" sub="Monte as jornadas de retomada: o que a SDR manda, quantos dias depois, e em qual cenário." />

      <Card style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
        <div>
          <strong style={{ fontSize: 14 }}>Follow-up automático</strong>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {enabled
              ? "Ligado — a SDR retoma o contato com as suas mensagens, nos horários comerciais."
              : "Desligado — a SDR só responde quando o lead escreve."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Ativar follow-up automático"
          // Ao LIGAR, materializa o seed no payload (Codex): sem isto, o caminho
          // "liga e Continua" salvava cadenceEnabled sem nenhuma jornada.
          onClick={() => patch({ cadenceEnabled: !enabled, ...(payload.cadenceJourneys ? {} : { cadenceJourneys: CADENCE_SEED }) })}
          style={{ flex: "none", width: 46, height: 26, borderRadius: 999, border: "none", cursor: "pointer", position: "relative", transition: "background .15s", background: enabled ? "var(--red-700)" : "var(--border-300)" }}
        >
          <span aria-hidden style={{ position: "absolute", top: 3, left: enabled ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,.25)" }} />
        </button>
      </Card>

      {enabled && anyPending && (
        <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 10, background: "var(--warning-tint)", color: "var(--warning-text)", fontSize: 13 }}>
          ⏳ Suas mensagens foram <strong>enviadas para aprovação da Meta</strong> (automático). Normalmente sai em minutos, podendo levar até 24h — a SDR só começa a enviar depois de aprovadas.
        </div>
      )}

      {enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {CADENCE_SCENARIOS.map((sc) => {
            const j = journeys.find((x) => x.scenario === sc.id) ?? { scenario: sc.id, steps: [] };
            const setSteps = (steps: CadenceStepRow[]) =>
              setJourneys(journeys.some((x) => x.scenario === sc.id)
                ? journeys.map((x) => (x.scenario === sc.id ? { ...x, steps } : x))
                : [...journeys, { scenario: sc.id, steps }]);
            return (
              <Card key={sc.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <strong style={{ fontSize: 14 }}>{sc.label}</strong>
                  <span style={{ fontSize: 10.5, fontWeight: 800, padding: "2px 9px", borderRadius: 999, background: sc.active ? "var(--success-tint)" : "#f0f0f0", color: sc.active ? "var(--success-text)" : "var(--text-muted)" }}>
                    {sc.active ? "ATIVO" : "EM BREVE"}
                  </span>
                </div>
                <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5 }}>
                  {sc.hint}
                  {!sc.active && " As mensagens ficam salvas e entram automaticamente quando este cenário for ativado."}
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {j.steps.map((st, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap", border: "1px solid var(--border-200)", borderRadius: 10, padding: "8px 10px" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, flex: "none", paddingTop: 6 }}>
                        Após
                        <Input
                          aria-label={`Dias de espera da mensagem ${i + 1} — ${sc.label}`}
                          type="number"
                          min={0}
                          max={30}
                          value={st.afterDays}
                          onChange={(e) => setSteps(j.steps.map((x, k) => (k === i ? { ...x, afterDays: clampNum(Number(e.target.value), 0, 30, 0) } : x)))}
                          style={{ width: 62 }}
                        />
                        dia(s)
                      </label>
                      <Textarea
                        aria-label={`Mensagem ${i + 1} — ${sc.label}`}
                        value={st.message}
                        onChange={(e) => setSteps(j.steps.map((x, k) => (k === i ? { ...x, message: e.target.value } : x)))}
                        placeholder="Escreva a mensagem com as suas palavras…"
                        style={{ flex: "1 1 260px", minWidth: 220, minHeight: 54 }}
                      />
                      <button
                        type="button"
                        aria-label={`Remover mensagem ${i + 1} de ${sc.label}`}
                        onClick={() => setSteps(j.steps.filter((_, k) => k !== i))}
                        style={{ flex: "none", border: "none", background: "none", color: "var(--red-700)", fontWeight: 800, fontSize: 16, cursor: "pointer", padding: "6px" }}
                      >
                        ×
                      </button>
                      {sc.active && (() => {
                        const st = TEMPLATE_STATUS_LABEL[tmplStatus[`followup_sem_resposta_${i + 1}`] ?? ""];
                        if (!st) return null;
                        return (
                          <span style={{ flexBasis: "100%", fontSize: 11.5, fontWeight: 700, color: st.tone === "ok" ? "var(--success-text)" : st.tone === "wait" ? "var(--warning-text)" : "var(--error-text)" }}>
                            {st.text}
                          </span>
                        );
                      })()}
                    </div>
                  ))}
                  {j.steps.length < 10 ? (
                    <Button variant="secondary" size="sm" onClick={() => setSteps([...j.steps, { afterDays: j.steps.length === 0 ? 0 : Math.min(30, (j.steps[j.steps.length - 1]?.afterDays ?? 0) + 1), message: "" }])}>
                      + Adicionar mensagem
                    </Button>
                  ) : (
                    <p className="muted" style={{ fontSize: 12, margin: 0 }}>Máximo de 10 mensagens por jornada (anti-spam).</p>
                  )}
                </div>
              </Card>
            );
          })}
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            Envios proativos respeitam horário comercial (9h–18h, dias úteis) e param na hora se o lead responder ou pedir para sair.
          </p>
        </div>
      )}

      <div className={s.warnBox} style={{ marginTop: 18 }}>⚠️ No WhatsApp oficial, mensagens fora da janela de 24h usam templates que <strong>precisam de aprovação da Meta</strong> — a gente cuida dessa aprovação para você.</div>
    </div>
  );
}

/**
 * Etapa 6 — Corretores parceiros (vertical imobiliária): É AQUI que entram os
 * números de WhatsApp dos corretores que recebem os leads. O gerenciador é o
 * mesmo da página de Configuração (salva na hora — sem efeito no "Continuar").
 */
function StepBrokers() {
  return (
    <div>
      <Title
        kicker="Etapa 6 de 10"
        title="Corretores parceiros"
        sub="Cadastre os corretores que vão receber os leads qualificados no WhatsApp. A SDR distribui por rodízio (região + capacidade), cobra o aceite em minutos e redistribui se ninguém responder."
      />
      <BrokersManager />
    </div>
  );
}

function StepKnowledge() {
  return (
    <div>
      <Title kicker="Etapa 8 de 10 · opcional" title="Base de conhecimento" sub="Suba a tabela de preços, o book do empreendimento, condições de financiamento e FAQ — a SDR responde com precisão a partir deles." />
      {/* Gerenciador COMPARTILHADO com a página de Configuração (o cliente
          gerencia os arquivos também depois do onboarding). */}
      <KnowledgeManager />
    </div>
  );
}

function StepTest() {
  return (
    <div>
      <Title kicker="Etapa 9 de 10" title="Teste a SDR antes de ativar" sub="Converse com a sua SDR num ambiente de teste — nada é enviado a leads nem a corretores reais." />
      <Card>
        <p style={{ marginTop: 0 }}>Abra o Playground para simular uma conversa e ver a IA qualificar em tempo real.</p>
        <Link href="/playground"><Button>Abrir Playground</Button></Link>
      </Card>
    </div>
  );
}

function StepActivate() {
  return (
    <div>
      <div className={s.successCard}>
        <span className={s.successCheck}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>
        </span>
        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.12em", color: "var(--success)", marginBottom: 8 }}>SDR AO VIVO</div>
        <h1 className="h1-hero" style={{ marginBottom: 8 }}>Tudo pronto!</h1>
        <p style={{ color: "var(--neutral-dot)", margin: 0 }}>Sua SDR de IA já está atendendo seus leads 24/7 no WhatsApp.</p>
      </div>
    </div>
  );
}
