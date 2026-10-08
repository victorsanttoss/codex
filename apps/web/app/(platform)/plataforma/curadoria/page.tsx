"use client";
import { useEffect, useState } from "react";
import { approveCandidate, getCandidates, getPlatformNiches, promoteCandidate, rejectCandidate, type CandidateRow, type PlatformNiche } from "../../../../lib/api";
import { Badge, Button, Card, EmptyState, Select, Textarea } from "../../../../components/ui";
import { useToast } from "../../../../components/toast";
import { PlatformError, PlatformTitle } from "../../../../components/platform-bits";
import { IconCheckShield } from "../../../../components/icons";
import s from "./curadoria.module.css";

function contentOf(c: CandidateRow): { q: string; a: string } {
  const content = c.content as Record<string, unknown>;
  const q = String(content.question ?? content.pattern ?? "");
  const a = String(content.answer ?? content.response ?? JSON.stringify(content));
  return { q, a };
}

export default function CuradoriaPage() {
  const toast = useToast();
  const [niches, setNiches] = useState<PlatformNiche[]>([]);
  const [nicheId, setNicheId] = useState("");
  const [cands, setCands] = useState<CandidateRow[]>([]);
  const [selId, setSelId] = useState("");
  const [draft, setDraft] = useState(""); // resposta editável do candidato selecionado
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => { getPlatformNiches().then((n) => { setNiches(n); setNicheId(n[0]?.id ?? ""); }).catch((e: Error) => setErr(e.message)); }, []);
  useEffect(() => { if (nicheId) reload(); }, [nicheId]); // eslint-disable-line react-hooks/exhaustive-deps
  function reload() {
    getCandidates(nicheId, "pending")
      .then((rows) => {
        setCands(rows);
        setSelId((prev) => (rows.some((r) => r.id === prev) ? prev : rows[0]?.id ?? ""));
      })
      .catch((e: Error) => setErr(e.message));
  }

  const sel = cands.find((c) => c.id === selId) ?? null;
  useEffect(() => { setDraft(sel ? contentOf(sel).a : ""); }, [selId, sel]);

  async function act(id: string, label: string, fn: () => Promise<unknown>) {
    setBusy(id);
    try { await fn(); toast(label); reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }
  if (err.includes("UNAUTHORIZED")) return <PlatformError message={err} />;

  const selNoPii = sel ? sel.piiFlag !== true : false;
  const selEdited = sel ? draft.trim() !== contentOf(sel).a.trim() : false;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12 }}>
        <PlatformTitle>Curadoria de conhecimento</PlatformTitle>
        <Select value={nicheId} onChange={(e) => setNicheId(e.target.value)} style={{ width: "auto", minWidth: 180 }} aria-label="Nicho">
          {niches.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </Select>
      </div>
      <p className="muted" style={{ marginTop: 0, marginBottom: 18, fontSize: 13 }}>Fila de candidatos a conhecimento. Aprovação é HUMANA; promover exige zero PII.</p>

      {cands.length === 0 ? (
        <Card pad={false}>
          <EmptyState
            title="Fila vazia"
            hint="Nenhum candidato pendente neste nicho — volte quando as conversas gerarem novos aprendizados."
            icon={<IconCheckShield />}
          />
        </Card>
      ) : (
        <div className={s.wrap}>
          {/* Fila */}
          <div className={s.queue}>
            {cands.map((c) => {
              const { q, a } = contentOf(c);
              const noPii = c.piiFlag !== true;
              return (
                <button key={c.id} className={[s.queueItem, c.id === selId ? s.queueItemOn : ""].join(" ")} onClick={() => setSelId(c.id)}>
                  <span className={s.queueHead}>
                    <Badge tone="neutral">{c.candidateType}</Badge>
                    {noPii ? <Badge tone="success">Zero PII</Badge> : <Badge tone="warning">Revisar PII</Badge>}
                  </span>
                  <span className={s.queuePreview}>{q || a}</span>
                </button>
              );
            })}
          </div>

          {/* Revisão */}
          {sel && (
            <div className={s.review}>
              {selNoPii ? (
                <div className={s.piiBanner}>✓ Zero PII detectado · VERIFICADO</div>
              ) : (
                <div className={[s.piiBanner, s.piiBannerWarn].join(" ")}>⚠ Possível PII — revise antes de aprovar</div>
              )}
              {contentOf(sel).q && (
                <div className={s.chatStrip}>
                  <div className={s.questionBubble}>{contentOf(sel).q}</div>
                </div>
              )}
              <div className={s.reviewBody}>
                <span className="eyebrow">Resposta proposta {selEdited && "· editada"}</span>
                <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} style={{ minHeight: 120 }} />
                <span className="caption">Ajuste o texto antes de aprovar — a versão editada é a que entra na base.</span>
              </div>
              <div className={s.actions}>
                <Button size="sm" variant="danger" disabled={!!busy} onClick={() => act(sel.id, "Candidato rejeitado", () => rejectCandidate(nicheId, sel.id))}>Rejeitar</Button>
                <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => act(sel.id, "✓ Aprovado", () => approveCandidate(nicheId, sel.id, selEdited ? draft : undefined))}>Aprovar</Button>
                <Button
                  size="sm"
                  disabled={!!busy || !selNoPii}
                  title={selNoPii ? undefined : "Promoção exige zero PII"}
                  onClick={() => act(sel.id, "✓ Aprovado e promovido", async () => { await approveCandidate(nicheId, sel.id, selEdited ? draft : undefined); await promoteCandidate(nicheId, sel.id); })}
                >
                  Aprovar &amp; promover
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
