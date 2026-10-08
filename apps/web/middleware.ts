import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Cabeçalhos de segurança (CSP + anti-frame) via middleware.
 *
 * NOTA sobre a CSP de script: as páginas deste painel são geradas ESTÁTICAS pelo
 * Next, então um nonce por-requisição NÃO é aplicado aos <script> (eles são
 * assados no build). Usar `nonce`+`strict-dynamic` bloquearia TODOS os scripts e
 * quebraria a hidratação (o login não funcionava). Por isso `script-src` usa
 * `'self' 'unsafe-inline'`: os chunks do Next são arquivos de `'self'` e o
 * bootstrap inline é coberto por `'unsafe-inline'`. Risco de XSS mitigado por: o
 * React escapa tudo por padrão e NÃO há `dangerouslySetInnerHTML`/sink de HTML no
 * código. Endurecer para nonce exige renderização dinâmica (force-dynamic) — é um
 * follow-up documentado em docs/SECURITY.md.
 *
 * Este middleware NÃO faz autorização (a auth é por JWT/guards no backend).
 */
// fallback 3101: API deste fork (3001 é o SDR IA padrão na mesma máquina)
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";
let apiOrigin = "";
try {
  apiOrigin = new URL(apiUrl).origin;
} catch {
  apiOrigin = "";
}
const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://connect.facebook.net${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  `connect-src 'self' https://*.facebook.com https://connect.facebook.net${apiOrigin ? ` ${apiOrigin}` : ""}${isDev ? " ws: wss:" : ""}`,
  "frame-src 'self' https://*.facebook.com https://web.facebook.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function middleware(_request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = {
  // Todas as rotas menos assets estáticos/otimizador de imagem do Next.
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
