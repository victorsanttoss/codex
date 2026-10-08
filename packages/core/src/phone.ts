/**
 * Normalização de telefone para **E.164** (`+<dígitos>`), domínio agnóstico a canal.
 *
 * Fonte típica no produto: o `wa_id` do WhatsApp, que já vem internacional e só com
 * dígitos (ex.: `5511987654321`). O objetivo é uma CHAVE consistente para dedup no
 * CRM — que o mesmo contato não vire `+55 11 9…`, `5511 9…` e `005511…` separados.
 *
 * Regras (conservadoras — não "adivinha" país à toa):
 *  - remove tudo que não é dígito; reconhece prefixo `+` e discagem internacional `00`;
 *  - `defaultCountryCode` (ex.: "55") é prefixado APENAS quando o número claramente
 *    não tem código de país (sem `+`/`00` e curto o bastante p/ ser local) — para
 *    telefones digitados à mão; o `wa_id` nunca precisa disso;
 *  - E.164 válido tem 8–15 dígitos; fora disso → `null` (deixa o chamador decidir).
 */
export function toE164(raw: string, defaultCountryCode?: string): string | null {
  const hadPlus = raw.trimStart().startsWith("+");
  let digits = raw.replace(/\D/g, "");
  // `00` como prefixo de discagem internacional (só quando não veio com `+`).
  if (!hadPlus && digits.startsWith("00")) digits = digits.slice(2);
  if (!digits) return null;
  // Número aparentemente local (sem CC): prefixa o país default, se dado.
  if (!hadPlus && defaultCountryCode && digits.length <= 11 && !digits.startsWith(defaultCountryCode)) {
    digits = defaultCountryCode + digits;
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return "+" + digits;
}

