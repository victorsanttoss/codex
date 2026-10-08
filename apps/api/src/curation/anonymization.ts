/**
 * Anonimização determinística (1ª camada) — ZERO PII no nicho é inegociável
 * (tenants do mesmo nicho podem ser concorrentes + LGPD). Detecta e REDIGE
 * telefone/e-mail/CPF/CNPJ/E.164/valores monetários. A verificação por LLM é a
 * 2ª camada (AnonymizationService). Conservadora: na dúvida, redige.
 */

interface PiiRule {
  type: string;
  re: RegExp;
  placeholder: string;
}

const RULES: PiiRule[] = [
  { type: "url", re: /\bhttps?:\/\/\S+|\bwww\.\S+/gi, placeholder: "[url]" },
  { type: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi, placeholder: "[email]" },
  { type: "handle", re: /(^|\s)@[a-z0-9_.]{2,}/gi, placeholder: "$1[perfil]" },
  { type: "cnpj", re: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, placeholder: "[cnpj]" },
  { type: "cpf", re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, placeholder: "[cpf]" },
  // E.164 / telefone BR (com ou sem +55, DDD, 8-9 dígitos, separadores)
  { type: "phone", re: /\+?\d{0,3}[\s.-]?\(?\d{2,3}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}\b/g, placeholder: "[telefone]" },
  // valores monetários (R$ 1.234,56 / 1234.56 reais)
  { type: "money", re: /\bR\$\s?\d[\d.,]*/gi, placeholder: "[valor]" },
  { type: "money", re: /\b\d[\d.,]*\s?(reais|mil reais)\b/gi, placeholder: "[valor]" },
  // sequência longa de dígitos solta (>=8) — telefone/doc sem formatação
  { type: "digits", re: /\b\d[\d\s.-]{7,}\d\b/g, placeholder: "[numero]" },
];

export interface RedactionResult {
  redacted: string;
  /** Tipos de PII encontrados (e redigidos). */
  found: string[];
}

/** Redige PII e devolve o texto limpo + os tipos encontrados. */
export function redactPII(text: string): RedactionResult {
  let out = text;
  const found = new Set<string>();
  for (const rule of RULES) {
    if (rule.re.test(out)) {
      found.add(rule.type);
      out = out.replace(rule.re, rule.placeholder);
    }
    rule.re.lastIndex = 0; // reseta o /g (stateful)
  }
  return { redacted: out, found: [...found] };
}

/** Há PII no texto? (após não-redigido). */
export function hasPII(text: string): boolean {
  return redactPII(text).found.length > 0;
}
