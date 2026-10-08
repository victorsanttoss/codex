/** Pequenos helpers compartilhados das telas de leads/conversas. */

export function ScoreTag({ score }: { score: number }) {
  const tone = score >= 70 ? "danger" : score >= 40 ? "warning" : "neutral";
  const bg = { danger: "var(--error-bg)", warning: "var(--warning-tint)", neutral: "#f0f0f0" }[tone];
  const fg = { danger: "var(--error-text)", warning: "var(--warning-text)", neutral: "var(--text-muted)" }[tone];
  return <span style={{ fontSize: 11, fontWeight: 800, padding: "3px 9px", borderRadius: 999, background: bg, color: fg }}>SCORE {score}</span>;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
