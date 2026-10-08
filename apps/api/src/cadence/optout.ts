/**
 * Detecção de OPT-OUT (LGPD) — função PURA. Conservadora: casa frases curtas de
 * saída. Falso-positivo (parar uma cadência à toa) é melhor que falso-negativo
 * (continuar mandando para quem pediu pra parar).
 */
const OPT_OUT_PATTERNS: RegExp[] = [
  // comandos curtos isolados ("pare", "parar", "stop", "sair")
  /^(pare|parar|stop|sair|cancelar)\.?!?$/i,
  // "para(r) de me mandar/enviar/escrever/incomodar" (contexto de mensagens)
  /\bpar(e|ar) de (me )?(mandar|enviar|escrever|chamar|incomodar|perturbar|mensag)/i,
  /\bn[ãa]o (quero|desejo)\b.*\b(mensagens?|contato|receber|nada)/i,
  /\bn[ãa]o me (mande|envie|escreva|chame|perturbe)\b/i,
  /\bn[ãa]o env[ie]e? mais\b/i,
  /\bdescadastr/i,
  /\bcancelar inscri/i,
  /\bsair da lista\b/i,
  /\bme (tire?|remova)\b.*\b(da lista|do grupo|daqui|disso)/i,
  /\bunsubscribe\b/i,
];

export function isOptOutText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // mensagens longas raramente são comando de opt-out — evita falso positivo.
  if (t.length > 160) return false;
  return OPT_OUT_PATTERNS.some((re) => re.test(t));
}
