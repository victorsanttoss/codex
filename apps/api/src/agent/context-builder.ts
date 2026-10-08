import type { LLMMessage } from "@sdr/core";
import type { HistoryMessage } from "@sdr/db";

/** ~4 chars/token (estimativa barata, suficiente p/ orçamento). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function textOf(content: Record<string, unknown>): string {
  const t = content.text;
  return typeof t === "string" ? t : "";
}

/**
 * Monta as mensagens da conversa (user/assistant) a partir do histórico, dentro
 * de um ORÇAMENTO de tokens: mantém as mais RECENTES e descarta as antigas (o
 * contexto antigo vive no resumo rolante, injetado no system prompt). O histórico
 * já inclui a mensagem atual do lead (a pipeline persiste o inbound antes do
 * handler), então não duplicamos o texto atual.
 */
export function buildConversationMessages(
  history: HistoryMessage[],
  budgetTokens = 3000,
): LLMMessage[] {
  const all: LLMMessage[] = [];
  for (const h of history) {
    const text = textOf(h.content);
    if (!text) continue; // mídia/não-texto: ignorada no contexto textual
    all.push(h.direction === "inbound" ? { role: "user", content: text } : { role: "assistant", content: text });
  }
  // mantém o sufixo mais recente que cabe no orçamento.
  const kept: LLMMessage[] = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]!;
    const cost = estimateTokens(m.content);
    if (used + cost > budgetTokens && kept.length > 0) break;
    kept.push(m);
    used += cost;
  }
  return kept.reverse();
}
