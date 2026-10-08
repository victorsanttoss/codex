"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { getConnectionStatus, getMe, getToken, type Me } from "../lib/api";
import { Sidebar, type ClientNav } from "./Sidebar";
import { Topbar, type SdrState } from "./Topbar";
import { ToastProvider } from "./toast";
import { SkeletonBlock } from "./ui";
import { IconChat, IconFlask, IconHome, IconLayers, IconLeads } from "./icons";
import f from "./app-frame.module.css";

/** pathname → item ativo da sidebar. */
function activeFromPath(path: string): ClientNav {
  if (path.startsWith("/atendimento")) return "atendimento";
  if (path.startsWith("/conversas")) return "conversas";
  if (path.startsWith("/leads")) return "leads";
  if (path.startsWith("/agenda")) return "agenda";
  if (path.startsWith("/playground")) return "playground";
  if (path.startsWith("/configuracao")) return "config";
  if (path.startsWith("/conta")) return "conta";
  return "inicio";
}

/** Deriva um nome de exibição do tenant a partir do e-mail (melhor dado disponível no /auth/me). */
function tenantNameFromMe(me: Me): string {
  const domain = (me.sub ?? "").split("@")[1] ?? "";
  const base = domain.split(".")[0] ?? "";
  if (!base) return "Minha empresa";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Shell da ÁREA DO CLIENTE: guard de sessão (JWT) no cliente + app shell
 * (sidebar/topbar). A API é a fronteira real de RBAC (todo endpoint @Roles); aqui
 * é UX. Papel de plataforma (staff) NÃO usa esta área.
 */
export function ClientShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/inicio";
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState(false);
  // Estado real da conexão do WhatsApp (polling ~20s) → indicador da topbar.
  const [sdrState, setSdrState] = useState<SdrState>("connected");

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    getMe()
      .then(setMe)
      .catch(() => {
        setError(true);
        router.replace("/login");
      });
  }, [router]);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    const check = () => {
      getConnectionStatus()
        .then((s) => { if (alive) setSdrState(s.connected ? "connected" : "down"); })
        .catch(() => { /* mantém o último estado conhecido */ });
    };
    check();
    const timer = setInterval(check, 20_000);
    return () => { alive = false; clearInterval(timer); };
  }, [me]);

  if (!me) {
    return (
      <div className={f.loading} aria-busy="true" aria-label={error ? "Redirecionando" : "Carregando"}>
        <div style={{ width: 260, display: "flex", flexDirection: "column", gap: 10 }}>
          <SkeletonBlock height={14} width="60%" />
          <SkeletonBlock height={14} />
          <SkeletonBlock height={14} width="80%" />
        </div>
      </div>
    );
  }

  const active = activeFromPath(pathname);
  const initials = (me.sub ?? "").replace(/@.*/, "").slice(0, 2).toUpperCase() || "VS";

  return (
    <ToastProvider>
      <div className={f.frame}>
        <Sidebar active={active} />
        <div className={f.col}>
          <Topbar
            tenantName={tenantNameFromMe(me)}
            sdrState={sdrState}
            userInitials={initials}
            onReconnect={() => router.push("/conectar")}
          />
          <main className={f.main}>{children}</main>
          <nav className={f.mobileTabs} aria-label="Navegação">
            <Link href="/inicio" className={[f.mobileTab, active === "inicio" ? f.mobileTabActive : ""].join(" ")}><IconHome /> Início</Link>
            <Link href="/atendimento" className={[f.mobileTab, active === "atendimento" ? f.mobileTabActive : ""].join(" ")}><IconLayers /> Atendimento</Link>
            <Link href="/conversas" className={[f.mobileTab, active === "conversas" ? f.mobileTabActive : ""].join(" ")}><IconChat /> Conversas</Link>
            <Link href="/leads" className={[f.mobileTab, active === "leads" ? f.mobileTabActive : ""].join(" ")}><IconLeads /> Leads</Link>
            <Link href="/playground" className={[f.mobileTab, active === "playground" ? f.mobileTabActive : ""].join(" ")}><IconFlask /> Testar</Link>
          </nav>
        </div>
      </div>
    </ToastProvider>
  );
}

/** Placeholder padrão enquanto a tela real do épico não chega. */
export function EpicStub({ title, epic }: { title: string; epic: string }) {
  return (
    <div>
      <h1 className="h1-page" style={{ marginBottom: 18 }}>{title}</h1>
      <div className={f.stub}>
        <span className={f.stubTag}>{epic}</span>
        <p style={{ margin: 0 }}>Esta tela é entregue no {epic}. A fundação (tema, navegação, sessão) já está no ar.</p>
      </div>
    </div>
  );
}
