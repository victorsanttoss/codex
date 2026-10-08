import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifica a assinatura `X-Hub-Signature-256` da Meta: HMAC-SHA256 do corpo
 * BRUTO com o app secret da plataforma. Comparação em tempo constante.
 */
export function verifyMetaSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(body).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Gera a assinatura (usado por fixtures de teste). */
export function signMetaBody(rawBody: string | Buffer, appSecret: string): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return "sha256=" + createHmac("sha256", appSecret).update(body).digest("hex");
}
