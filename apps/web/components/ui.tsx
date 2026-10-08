import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TdHTMLAttributes,
  TextareaHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import s from "./ui.module.css";

/** Biblioteca de primitivos do design V4. Tokens vêm de globals.css. */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};
export function Button({ variant = "primary", size = "md", className, ...rest }: ButtonProps) {
  const v = { primary: s.btnPrimary, secondary: s.btnSecondary, ghost: s.btnGhost, danger: s.btnDanger }[variant];
  const sz = size === "sm" ? s.btnSm : s.btnMd;
  return <button className={[s.btn, v, sz, className].filter(Boolean).join(" ")} {...rest} />;
}

export function Card({ children, pad = true, hover = false, className, style }: { children: ReactNode; pad?: boolean; hover?: boolean; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={[s.card, pad ? s.cardPad : "", hover ? s.cardHover : "", className].filter(Boolean).join(" ")} style={style}>
      {children}
    </div>
  );
}

type Tone = "neutral" | "success" | "warning" | "danger" | "brand";
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  const t = { neutral: s.badgeNeutral, success: s.badgeSuccess, warning: s.badgeWarning, danger: s.badgeDanger, brand: s.badgeBrand }[tone];
  return <span className={[s.badge, t].join(" ")}>{children}</span>;
}

/** Status do lead — mapa de cores e rótulos do handoff (pill com tinta + dot). */
export type LeadStatus = "new" | "qualified" | "handoff" | "disqualified" | "error";
const LEAD_META: Record<LeadStatus, { bg: string; fg: string; dot: string; color: string; label: string }> = {
  new: { bg: "#f0f0f0", fg: "#595959", dot: "var(--lead-novo)", color: "var(--lead-novo)", label: "Novo" },
  qualified: { bg: "var(--success-tint)", fg: "var(--success-text)", dot: "var(--lead-qualificado)", color: "var(--lead-qualificado)", label: "Qualificado" },
  handoff: { bg: "var(--warning-tint)", fg: "var(--warning-text)", dot: "var(--lead-handoff)", color: "var(--lead-handoff)", label: "Atendimento humano" },
  disqualified: { bg: "#f0f0f0", fg: "#595959", dot: "var(--lead-desqualificado)", color: "var(--lead-desqualificado)", label: "Desqualificado" },
  error: { bg: "var(--error-bg)", fg: "var(--error-text)", dot: "var(--lead-erro)", color: "var(--lead-erro)", label: "Erro / queda" },
};
export function leadStatusMeta(status: string): { bg: string; fg: string; dot: string; color: string; label: string } {
  return LEAD_META[(status as LeadStatus)] ?? LEAD_META.new;
}
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const meta = leadStatusMeta(status);
  return (
    <span className={s.statusPill} style={{ background: meta.bg, color: meta.fg }}>
      <span className={s.pillDot} style={{ background: meta.dot }} />
      {label ?? meta.label}
    </span>
  );
}
/** Alias de compatibilidade — o StatusDot antigo virou pill. */
export const StatusDot = StatusPill;

/** Tradução de status técnicos para pt-BR (tabelas staff/conta). */
const STATUS_PT: Record<string, string> = {
  active: "Ativo",
  inactive: "Inativo",
  suspended: "Suspenso",
  approved: "Aprovado",
  pending: "Em análise",
  rejected: "Rejeitado",
  scheduled: "Agendado",
  confirmed: "Confirmado",
  canceled: "Cancelado",
  cancelled: "Cancelado",
  owner: "Dono",
  admin: "Admin",
  agent: "Atendente",
  curator: "Curador",
  support: "Suporte",
};
export function statusLabelPt(value: string): string {
  return STATUS_PT[value.toLowerCase()] ?? value;
}

export function Kpi({ label, value, delta, dense }: { label: string; value: ReactNode; delta?: string; dense?: boolean }) {
  const down = delta ? /^[-↓]/.test(delta.trim()) : false;
  const deltaText = delta ? delta.trim().replace(/^[-↓]\s*/, "") : "";
  return (
    <Card pad={!dense} className={dense ? s.kpiDense : undefined}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>{label}</div>
      <div className={dense ? s.kpiNumDense : "kpi-num"}>{value}</div>
      {delta && (
        <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700, color: down ? "var(--error-text)" : "var(--success-text)" }}>
          {down ? `↓ ${deltaText}` : delta}
        </div>
      )}
    </Card>
  );
}

export function EmptyState({ title, hint, icon, action }: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.state}>
      {icon && <span className={s.stateIcon} aria-hidden>{icon}</span>}
      <div className="h3" style={{ color: "var(--ink-900)", marginBottom: 6 }}>{title}</div>
      {hint && <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>{hint}</p>}
      {action}
    </div>
  );
}
/**
 * Estado de erro humano: nada de mensagem técnica no texto visível — o detalhe
 * técnico vai (opcionalmente) no title= para diagnóstico.
 */
export function ErrorState({ message, detail, onRetry }: { message?: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className={s.errCard} title={detail} role="alert">
      <strong className={s.errTitle}>Não foi possível carregar</strong>
      <p className={s.errText}>{message ?? "Algo deu errado ao buscar seus dados. Verifique a conexão e tente de novo."}</p>
      {onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>Tentar de novo</Button>}
    </div>
  );
}
export function SkeletonRows({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c}><div className={s.skel} style={{ width: c === 0 ? "70%" : "50%" }} /></td>
          ))}
        </tr>
      ))}
    </>
  );
}
/** Bloco shimmer avulso (linhas, cards, gráficos em carregamento). */
export function SkeletonBlock({ height = 14, width = "100%", style }: { height?: number | string; width?: number | string; style?: React.CSSProperties }) {
  return <div className={s.skel} style={{ height, width, ...style }} aria-hidden />;
}
/** Skeleton no formato de um cartão de KPI. */
export function SkeletonKpi() {
  return (
    <Card aria-hidden>
      <div className={s.skel} style={{ width: 90, height: 10, marginBottom: 14 }} />
      <div className={s.skel} style={{ width: 64, height: 26 }} />
    </Card>
  );
}

/** Tabela base (cabeçalho uppercase, linhas clicáveis). */
export const tableClass = s.table;
export const rowClickable = s.rowClickable;
/** Células avulsas para tabelas fora de .table (mesma pele do design). */
export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={[s.th, className].filter(Boolean).join(" ")} {...rest} />;
}
export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={[s.td, className].filter(Boolean).join(" ")} {...rest} />;
}

export function Pager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (p: number) => void }) {
  if (pageCount <= 1) return null;
  const pages = Array.from({ length: pageCount }, (_, i) => i).slice(Math.max(0, page - 2), Math.max(0, page - 2) + 5);
  return (
    <div className={s.pager}>
      <button className={s.pageBtn} disabled={page === 0} onClick={() => onPage(page - 1)}>‹</button>
      {pages.map((p) => (
        <button key={p} className={[s.pageBtn, p === page ? s.pageBtnOn : ""].join(" ")} onClick={() => onPage(p)}>{p + 1}</button>
      ))}
      <button className={s.pageBtn} disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)}>›</button>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={s.field}>
      <span className={s.label}>{label}</span>
      {children}
    </label>
  );
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={s.input} {...props} />;
}
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={[s.select, className].filter(Boolean).join(" ")} {...rest} />;
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={[s.input, s.textarea, className].filter(Boolean).join(" ")} {...rest} />;
}

/** Mini-modal de confirmação do DS — substitui o confirm() nativo. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirmar",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className={s.modalOverlay} role="dialog" aria-modal="true" aria-label={title} onClick={onCancel}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()}>
        <strong className={s.modalTitle}>{title}</strong>
        <p className={s.modalText}>{message}</p>
        <div className={s.modalActions}>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>Cancelar</Button>
          <Button variant={danger ? "danger" : "primary"} size="sm" disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
