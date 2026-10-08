"use client";
import { useEffect, useState } from "react";
import {
  createStaff,
  deleteStaff,
  getPlatformMe,
  getPlatformStaff,
  rotateStaffToken,
  type PlatformMe,
  type StaffRow,
} from "../../../../lib/api";
import { Badge, Button, Card, ConfirmDialog, Field, Input, Select, Td, Th, statusLabelPt } from "../../../../components/ui";
import { useToast } from "../../../../components/toast";
import { PlatformError, PlatformTitle } from "../../../../components/platform-bits";

const PERMS = [
  { perm: "Impersonar tenant", admin: true, curator: false, support: true },
  { perm: "Aprovar conhecimento", admin: true, curator: true, support: false },
  { perm: "Editar nichos", admin: true, curator: true, support: false },
  { perm: "Gerenciar staff", admin: true, curator: false, support: false },
];

type Pending = { kind: "rotate" | "delete"; member: StaffRow } | null;

export default function StaffPage() {
  const toast = useToast();
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [me, setMe] = useState<PlatformMe | null>(null);
  const [err, setErr] = useState("");
  // Token recém-gerado (criação/rotação) — mostrado UMA única vez.
  const [freshToken, setFreshToken] = useState<{ label: string; token: string } | null>(null);
  const [form, setForm] = useState({ name: "", email: "", role: "support" });
  const [busy, setBusy] = useState(false);
  // Confirmação pendente (substitui o confirm() nativo).
  const [pending, setPending] = useState<Pending>(null);

  const reload = () => getPlatformStaff().then(setStaff).catch((e: Error) => setErr(e.message));
  useEffect(() => {
    reload();
    getPlatformMe().then(setMe).catch(() => {});
  }, []);

  async function onCreate() {
    setBusy(true);
    try {
      const created = await createStaff(form.email.trim(), form.name.trim(), form.role);
      setFreshToken({ label: `Token de ${created.name} (${created.email})`, token: created.token });
      setForm({ name: "", email: "", role: "support" });
      toast("✓ Membro criado");
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmPending() {
    if (!pending) return;
    const { kind, member } = pending;
    setBusy(true);
    try {
      if (kind === "rotate") {
        const { token } = await rotateStaffToken(member.id);
        setFreshToken({ label: `Novo token de ${member.name} (${member.email})`, token });
        toast("✓ Token rotacionado");
      } else {
        await deleteStaff(member.id);
        toast("Membro removido");
        await reload();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  if (err && staff.length === 0) return <PlatformError message={err} onRetry={() => { setErr(""); reload(); }} />;
  const isAdmin = me?.role === "admin";

  return (
    <div>
      <PlatformTitle>Staff &amp; permissões</PlatformTitle>
      {me && (
        <Card style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="caption">
            Conectado como <strong>{me.id === "platform-admin" ? "Admin (token compartilhado)" : me.name}</strong>
          </span>
          <Badge tone={me.role === "admin" ? "brand" : "neutral"}>{statusLabelPt(me.role)}</Badge>
        </Card>
      )}

      {freshToken && (
        <Card style={{ marginBottom: 16, border: "1px solid var(--warning-text)" }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>{freshToken.label}</div>
          <code style={{ display: "block", padding: 10, background: "var(--surface-subtle)", borderRadius: 8, fontSize: 12, wordBreak: "break-all", userSelect: "all" }}>
            {freshToken.token}
          </code>
          <p className="caption" style={{ margin: "8px 0 0", color: "var(--warning-text)" }}>
            Copie agora — este token não será mostrado de novo (só o hash fica no banco).
          </p>
          <Button style={{ marginTop: 10 }} onClick={() => setFreshToken(null)}>Já copiei</Button>
        </Card>
      )}

      <Card pad={false} style={{ marginBottom: 20 }}>
        <div style={{ padding: 14 }} className="eyebrow">Membros</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {staff.map((m) => (
              <tr key={m.id} style={me && m.id === me.id ? { background: "var(--surface-subtle)" } : undefined}>
                <Td>
                  <strong>{m.name}</strong>{me && m.id === me.id && <span className="caption" style={{ marginLeft: 6 }}>(você)</span>}
                  <div className="caption">{m.email}</div>
                </Td>
                <Td style={{ textAlign: "right" }}>
                  <Badge tone={m.role === "admin" ? "brand" : "neutral"}>{statusLabelPt(m.role)}</Badge>
                  {isAdmin && (
                    <span style={{ marginLeft: 10, whiteSpace: "nowrap" }}>
                      <button style={linkBtn} onClick={() => setPending({ kind: "rotate", member: m })}>rotacionar token</button>
                      {me!.id !== m.id && (
                        <button style={{ ...linkBtn, color: "var(--error-text)" }} onClick={() => setPending({ kind: "delete", member: m })}>remover</button>
                      )}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
            {staff.length === 0 && <tr><Td className="muted">Sem staff cadastrado.</Td></tr>}
          </tbody>
        </table>
      </Card>

      {isAdmin && (
        <Card style={{ marginBottom: 20 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Novo membro</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 140px auto", gap: 10, alignItems: "end" }}>
            <Field label="Nome">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Maria Silva" />
            </Field>
            <Field label="Email">
              <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="maria@v4.local" />
            </Field>
            <Field label="Papel">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="support">Suporte</option>
                <option value="curator">Curador</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            <Button disabled={busy || !form.name.trim() || !form.email.trim()} onClick={onCreate}>
              {busy ? "Criando…" : "Criar + gerar token"}
            </Button>
          </div>
        </Card>
      )}

      <h2 className="h2" style={{ marginBottom: 4 }}>Matriz de permissões</h2>
      <p className="caption" style={{ color: "var(--text-subtle)", marginTop: 0, marginBottom: 10 }}>
        Enforçada no backend por papel (guard de plataforma). Ações de curadoria e de gestão de staff são atribuídas ao staff e registradas em auditoria.
      </p>
      <Card pad={false}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr><Th>Permissão</Th><Th>Admin</Th><Th>Curador</Th><Th>Suporte</Th></tr></thead>
          <tbody>
            {PERMS.map((r) => (
              <tr key={r.perm}>
                <Td>{r.perm}</Td>
                <Td>{r.admin ? "✓" : "—"}</Td>
                <Td>{r.curator ? "✓" : "—"}</Td>
                <Td>{r.support ? "✓" : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "rotate" ? "Rotacionar token" : "Remover membro"}
        message={
          pending?.kind === "rotate"
            ? `Rotacionar o token de ${pending.member.name}? O token atual deixa de funcionar na hora.`
            : `Remover ${pending?.member.name ?? ""} do staff? O acesso é revogado na hora.`
        }
        confirmLabel={pending?.kind === "rotate" ? "Rotacionar" : "Remover"}
        danger={pending?.kind === "delete"}
        busy={busy}
        onConfirm={onConfirmPending}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

const linkBtn: React.CSSProperties = { background: "none", border: "none", padding: 0, marginLeft: 10, fontSize: 12, cursor: "pointer", textDecoration: "underline", color: "var(--text-subtle)" };
