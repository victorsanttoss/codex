import s from "./shell.module.css";
import { NavItem } from "./Sidebar";
import { IconAlert, IconBuilding, IconCheckShield, IconGlobe, IconLayers, IconTemplate, IconUser } from "./icons";

export type PlatformNav = "visao" | "tenants" | "nichos" | "curadoria" | "templates" | "operacao" | "staff";

/**
 * Sidebar da ÁREA DA PLATAFORMA (staff — 236px, #000). Valores exatos do
 * PlatformSidebar.dc.html. Cross-tenant auditado; tenants nunca veem esta área.
 */
export function PlatformSidebar({
  active,
  tenants = 214,
  curadoriaBadge = 18,
  operacaoBadge = 3,
  staffUser = "Vitor Franco",
  staffRole = "Staff · Curadoria",
}: {
  active: PlatformNav;
  tenants?: number;
  curadoriaBadge?: number;
  operacaoBadge?: number;
  staffUser?: string;
  staffRole?: string;
}) {
  const initials = staffUser.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return (
    <aside className={[s.sidebar, s.sidebarStaff].join(" ")}>
      <div className={s.brand}>
        <span className={s.brandMark}>V4</span>
        <div>
          <div className={s.brandText}>Plataforma</div>
          <div className={s.brandSub}>Console interno</div>
        </div>
      </div>
      <div className={s.statusPill}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }} />
        Sistema operacional
      </div>

      <nav className={s.nav}>
        <NavItem href="/plataforma/visao-global" icon={<IconGlobe />} label="Visão global" active={active === "visao"} />
        <NavItem href="/plataforma/tenants" icon={<IconBuilding />} label="Tenants" active={active === "tenants"} badge={tenants} badgeTone="gray" />
        <NavItem href="/plataforma/nichos" icon={<IconLayers />} label="Nichos" active={active === "nichos"} />

        <div className={s.groupLabel}>Conhecimento</div>
        <NavItem href="/plataforma/curadoria" icon={<IconCheckShield />} label="Curadoria" active={active === "curadoria"} badge={curadoriaBadge} badgeTone="red" />
        <NavItem href="/plataforma/templates" icon={<IconTemplate />} label="Templates HSM" active={active === "templates"} />

        <div className={s.groupLabel}>Operação</div>
        <NavItem href="/plataforma/operacao" icon={<IconAlert />} label="Operação & alertas" active={active === "operacao"} badge={operacaoBadge} badgeTone="amber" />
        <NavItem href="/plataforma/staff" icon={<IconUser />} label="Staff & permissões" active={active === "staff"} />
      </nav>

      <div className={s.footerUser}>
        <span className={s.avatar}>{initials}</span>
        <div style={{ minWidth: 0 }}>
          <div className={s.footerTitle}>{staffUser}</div>
          <div className={s.footerSub}>{staffRole}</div>
        </div>
      </div>
    </aside>
  );
}
