"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { clearPlatformToken, getPlatformMe, getPlatformToken, setPlatformToken, type PlatformMe } from "../lib/api";
import { PlatformSidebar, type PlatformNav } from "./PlatformSidebar";
import { Button, Card, Field, Input, SkeletonBlock } from "./ui";
import { ToastProvider } from "./toast";
import { IconSearch } from "./icons";
import f from "./app-frame.module.css";

function activeFromPath(path: string): PlatformNav {
  if (path.includes("/tenants")) return "tenants";
  if (path.includes("/nichos")) return "nichos";
  if (path.includes("/curadoria")) return "curadoria";
  if (path.includes("/templates")) return "templates";
  if (path.includes("/operacao")) return "operacao";
  if (path.includes("/staff")) return "staff";
  return "visao";
}

const NAV_TITLES: Record<PlatformNav, string> = {
  visao: "Visão global",
  tenants: "Tenants",
  nichos: "Nichos",
  curadoria: "Curadoria de conhecimento",
  templates: "Templates HSM",
  operacao: "Operação & alertas",
  staff: "Staff & permissões",
};

/** Topbar da Área da Plataforma: título 17/800 + busca decorativa + avatar 30px. */
export function PlatformTopbar({ title, initials }: { title: string; initials: string }) {
  return (
    <header className={f.platformTopbar}>
      <h1 className={f.platformTopbarTitle}>{title}</h1>
      <div className={f.platformTopbarRight}>
        <span className={f.platformSearch}>
          <IconSearch width={14} height={14} />
          Buscar tenant…
        </span>
        <span className={f.platformAvatar} aria-label="Staff">{initials}</span>
      </div>
    </header>
  );
}

/**
 * Shell da ÁREA DA PLATAFORMA (staff). Gate pelo TOKEN PESSOAL do staff (separado
 * do JWT do tenant — tenants nunca acessam esta área). O token é VALIDADO contra
 * o backend (GET /platform/me), que devolve a identidade real (nome/papel); o
 * papel é enforçado por endpoint no servidor. A matriz de permissões da tela de
 * staff documenta a política.
 */
export function PlatformShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/plataforma/visao-global";
  const [me, setMe] = useState<PlatformMe | null | undefined>(undefined); // undefined=carregando
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!getPlatformToken()) { setMe(null); return; }
    getPlatformMe().then(setMe).catch(() => { clearPlatformToken(); setMe(null); });
  }, []);

  async function submit() {
    const token = value.trim();
    if (!token) return;
    setBusy(true); setErr("");
    setPlatformToken(token);
    try {
      setMe(await getPlatformMe()); // valida o token e traz a identidade real
    } catch {
      clearPlatformToken();
      setErr("Token inválido ou sem acesso à plataforma.");
    } finally {
      setBusy(false);
    }
  }

  if (me === undefined) {
    return (
      <div className={f.loading} aria-busy="true" aria-label="Carregando">
        <div style={{ width: 260, display: "flex", flexDirection: "column", gap: 10 }}>
          <SkeletonBlock height={14} width="60%" />
          <SkeletonBlock height={14} />
          <SkeletonBlock height={14} width="80%" />
        </div>
      </div>
    );
  }

  if (me === null) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--black)" }}>
        <Card style={{ width: 360 }}>
          <h2 className="h2" style={{ marginBottom: 4 }}>Área da Plataforma</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Acesso restrito ao staff V4. Informe o seu token pessoal de staff.</p>
          <Field label="Token de staff">
            <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="seu-token-de-staff" />
          </Field>
          {err && <p style={{ color: "var(--error-text)", fontSize: 12, margin: "8px 0 0" }}>{err}</p>}
          <Button style={{ marginTop: 14, width: "100%" }} disabled={!value || busy} onClick={submit}>
            {busy ? "Verificando…" : "Entrar"}
          </Button>
        </Card>
      </div>
    );
  }

  const label = me.id === "platform-admin" ? "Admin (token compartilhado)" : `${me.name} · ${me.role}`;
  const active = activeFromPath(pathname);
  const initials = (me.name ?? "V4").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase() || "V4";
  return (
    <ToastProvider>
      <div className={f.frame}>
        <PlatformSidebar active={active} tenants={214} curadoriaBadge={18} operacaoBadge={3} staffUser={label} />
        <div className={f.col}>
          <PlatformTopbar title={NAV_TITLES[active]} initials={initials} />
          <main className={f.main}>{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}

export function PlatformStub({ title, note }: { title: string; note?: string }) {
  return (
    <div>
      <h1 className="h1-page" style={{ marginBottom: 18 }}>{title}</h1>
      <div className={f.stub}>
        <span className={f.stubTag}>Épico 6</span>
        <p style={{ margin: 0 }}>{note ?? "Tela da Área da Plataforma — entregue no Épico 6."}</p>
      </div>
    </div>
  );
}
