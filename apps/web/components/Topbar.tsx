"use client";

import s from "./topbar.module.css";
import { IconBell, IconChevronDown, IconSearch } from "./icons";

/** Estado da SDR sempre visível no topo (3 estados, linguagem do cliente). */
export type SdrState = "connected" | "answering" | "down";

export function SdrStatusIndicator({ state, onReconnect }: { state: SdrState; onReconnect?: () => void }) {
  if (state === "down") {
    return (
      <span className={[s.sdr, s.sdrDown].join(" ")} role="status">
        <span className={[s.sdrDot, s.dotRed, s.pulseRed].join(" ")} />
        Conexão caída
        <button type="button" className={s.reconnect} onClick={onReconnect}>Reconectar</button>
      </span>
    );
  }
  if (state === "answering") {
    return (
      <span className={[s.sdr, s.sdrAnswering].join(" ")} role="status">
        <span className={[s.sdrDot, s.dotGreen, s.pulse].join(" ")} />
        Respondendo agora
        <span className={s.typing} aria-hidden><span /><span /><span /></span>
      </span>
    );
  }
  return (
    <span className={[s.sdr, s.sdrConnected].join(" ")} role="status">
      <span className={[s.sdrDot, s.dotGreen].join(" ")} />
      SDR conectada
    </span>
  );
}

/**
 * Topbar da área do cliente: seletor de tenant + indicador SDR + busca +
 * notificações + avatar. Apresentacional (a ligação de dados vem nos épicos).
 */
export function Topbar({
  tenantName = "Demo Co",
  tenantCity,
  sdrState = "connected",
  userInitials = "VS",
  hasNotifications = false,
  onReconnect,
}: {
  tenantName?: string;
  tenantCity?: string;
  sdrState?: SdrState;
  userInitials?: string;
  hasNotifications?: boolean;
  onReconnect?: () => void;
}) {
  return (
    <header className={s.topbar}>
      <button className={s.tenant} type="button">
        <span className={s.tenantMark}>{tenantName.slice(0, 2).toUpperCase()}</span>
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.1 }}>
          {tenantName}
          {tenantCity && <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-subtle)" }}>{tenantCity}</span>}
        </span>
        <IconChevronDown width={16} height={16} />
      </button>

      <SdrStatusIndicator state={sdrState} onReconnect={onReconnect} />

      <span className={s.spacer} />

      <span className={s.search}>
        <IconSearch width={16} height={16} />
        <input placeholder="Buscar conversa, lead…" aria-label="Buscar" />
      </span>
      <button className={s.iconBtn} type="button" aria-label="Notificações">
        <IconBell />
        {hasNotifications && <span className={s.notifDot} />}
      </button>
      <button className={s.userAvatar} type="button" aria-label="Conta">
        {userInitials}
      </button>
    </header>
  );
}
