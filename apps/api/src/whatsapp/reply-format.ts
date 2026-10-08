/**
 * Formata a resposta do agente para o WhatsApp "de humano" (regra de retorno):
 *
 * 1. SANITIZA o que o WhatsApp não renderiza / o lead não pode ver:
 *    - markdown `**negrito**`/`__x__` → `*negrito*` (WhatsApp usa asterisco único);
 *    - títulos `#`/listas markdown viram texto plano;
 *    - marcadores de fonte do RAG (`[1]`) NUNCA vão ao lead (a instrução de
 *      citação era de auditoria e vazava na conversa — achado do walkthrough).
 * 2. PICOTA em "bolhas": parágrafo (linha em branco) vira mensagem separada,
 *    como um humano digitando — com teto de bolhas (excedente agrega na última)
 *    e bolha muito curta colada na anterior (evita spam de mensagens de 2 palavras).
 */

/** Teto de mensagens por turno (anti-spam; o prompt também instrui "máx. 3"). */
export const MAX_REPLY_BUBBLES = 3;

/** Bolha menor que isto cola na anterior (fragmento, não mensagem própria). */
const MIN_BUBBLE_CHARS = 25;

/** Pausa "digitando" entre bolhas, proporcional ao tamanho da PRÓXIMA bolha. */
export function bubblePauseMs(nextBubble: string): number {
  return Math.min(2_200, 500 + nextBubble.length * 12);
}

export function sanitizeWhatsAppText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, "*$1*") // markdown bold → bold do WhatsApp
    .replace(/__(.+?)__/gs, "_$1_") // markdown underline-bold → itálico WA
    .replace(/^#{1,6}\s+/gm, "") // títulos markdown não existem no WhatsApp
    // Marcador de citação do RAG ([1]..[99]) — nunca lead-facing. Restrito a
    // 1-2 dígitos em fim de trecho (Codex): não corromper "[código 123]" etc.;
    // o prompt também instrui a nunca emitir colchetes numerados.
    .replace(/\s*\[\d{1,2}\](?=$|[\s.,;:!?)])/gm, "")
    .trim();
}

/**
 * Remove um PREÂMBULO de raciocínio que alguns modelos vazam no início da
 * resposta (ex.: "Need answer about hours; no tool needed."). O texto ao lead é
 * sempre PT sobre o negócio — uma 1ª linha com marcadores de planejamento em
 * inglês nunca é legítima. Só remove se sobrar conteúdo depois.
 */
// Só frases em inglês INEQUÍVOCAS de planejamento interno (nunca abertura
// legítima de um SDR que responde em PT). NÃO usar "tool" solto: o \b do JS
// quebra em letras acentuadas e casaria nome de bairro/empreendimento com
// "tool" (achado da revisão adversarial). Apóstrofo reto e tipográfico.
const LEAKED_PREAMBLE =
  /\b(?:no tool needed|tool call|tool use|using the tool|let me|i['’]?ll|i will|i need|i should|here['’]?s|the user|need answer|offer available|respond with)\b/i;

export function stripLeakedPreamble(text: string): string {
  const lines = text.split("\n");
  while (true) {
    const idx = lines.findIndex((l) => l.trim() !== "");
    if (idx === -1) break;
    const first = lines[idx]!.trim();
    const hasMore = lines.slice(idx + 1).some((l) => l.trim() !== "");
    if (LEAKED_PREAMBLE.test(first) && hasMore) {
      lines.splice(0, idx + 1);
    } else break;
  }
  return lines.join("\n").trim();
}

/**
 * Remove LINHAS repetidas verbatim: modelos pequenos às vezes repetem a saudação
 * ou a pergunta na mesma geração (ex.: "Olá! ... 😊 / Me fala seu nome? / Olá!
 * ... 😊 / Me fala seu nome?"). Mantém a 1ª ocorrência e a ordem; colapsa as
 * quebras de parágrafo criadas pela remoção.
 */
export function dedupeRepeatedLines(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const key = raw.trim();
    if (key === "") {
      out.push("");
      continue;
    }
    if (seen.has(key)) continue; // linha idêntica já vista — descarta
    seen.add(key);
    out.push(raw);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function formatWhatsAppReply(text: string, maxBubbles = MAX_REPLY_BUBBLES): string[] {
  const sanitized = dedupeRepeatedLines(stripLeakedPreamble(sanitizeWhatsAppText(text)));
  if (!sanitized) return [];
  const parts = sanitized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const bubbles: string[] = [];
  for (const p of parts) {
    const overCap = bubbles.length >= maxBubbles;
    const tooShort = p.length < MIN_BUBBLE_CHARS && bubbles.length > 0;
    if (overCap || tooShort) {
      bubbles[bubbles.length - 1] += `\n\n${p}`;
    } else {
      bubbles.push(p);
    }
  }
  return bubbles;
}
