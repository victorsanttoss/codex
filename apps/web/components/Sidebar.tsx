"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "../lib/api";
import s from "./shell.module.css";
import { IconCalendar, IconChat, IconGear, IconHome, IconLayers, IconLeads, IconFlask, IconLogout, IconUser } from "./icons";

export type BadgeTone = "red" | "gray" | "amber";

/** Item de navegação reutilizável (cliente e staff). */
export function NavItem({
  href,
  icon,
  label,
  active,
  badge,
  badgeTone = "red",
}: {
  href: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  badge?: number | string;
  badgeTone?: BadgeTone;
}) {
  const toneCls = { red: s.badgeRed, gray: s.badgeGray, amber: s.badgeAmber }[badgeTone];
  const show = badge !== undefined && badge !== 0 && badge !== "0";
  return (
    <Link href={href} className={[s.item, active ? s.itemActive : ""].join(" ")} aria-current={active ? "page" : undefined}>
      {icon}
      <span className={s.itemLabel}>{label}</span>
      {show && <span className={[s.navBadge, toneCls].join(" ")}>{badge}</span>}
    </Link>
  );
}

export type ClientNav =
  | "inicio"
  | "atendimento"
  | "conversas"
  | "leads"
  | "agenda"
  | "playground"
  | "config"
  | "conta";

/**
 * Sidebar da ÁREA DO CLIENTE (228px, #1a1a1a). Itens + grupo Ajustes + rodapé com
 * toggle "SDR ativa". `active` marca o item atual; linguagem sem termos técnicos.
 */
export function Sidebar({ active, conversasBadge = 0 }: { active: ClientNav; conversasBadge?: number }) {
  return (
    <aside className={s.sidebar}>
      <div className={s.brand}>
        <span className={s.brandMark}>V4</span>
        <span className={s.brandText}>SDR de IA</span>
      </div>

      <nav className={s.nav}>
        <NavItem href="/inicio" icon={<IconHome />} label="Início" active={active === "inicio"} />
        {/* Kanban da distribuição aos corretores (migrado da Central Menin) */}
        <NavItem href="/atendimento" icon={<IconLayers />} label="Atendimento" active={active === "atendimento"} />
        <NavItem href="/conversas" icon={<IconChat />} label="Conversas" active={active === "conversas"} badge={conversasBadge} />
        <NavItem href="/leads" icon={<IconLeads />} label="Leads" active={active === "leads"} />
        <NavItem href="/agenda" icon={<IconCalendar />} label="Agenda" active={active === "agenda"} />
        <NavItem href="/playground" icon={<IconFlask />} label="Playground" active={active === "playground"} />

        <div className={s.groupLabel}>Ajustes</div>
        <NavItem href="/configuracao" icon={<IconGear />} label="Configuração" active={active === "config"} />
        <NavItem href="/conta" icon={<IconUser />} label="Conta & uso" active={active === "conta"} />
      </nav>

      <div className={s.footerCard}>
        <span className={s.toggle} aria-hidden />
        <div>
          <div className={s.footerTitle}>SDR ativa</div>
          <div className={s.footerSub}>atendendo 24/7</div>
        </div>
      </div>
      <button type="button" className={s.logoutBtn} onClick={() => void doLogout()}>
        <IconLogout width={15} height={15} /> Sair da conta
      </button>
    </aside>
  );
}

/** Revoga a sessão e recarrega no /login — reload limpo p/ trocar de conta. */
async function doLogout(): Promise<void> {
  await logout();
  window.location.href = "/login";
}
