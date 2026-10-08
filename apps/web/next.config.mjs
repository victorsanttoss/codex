/** @type {import('next').NextConfig} */

// A CSP (com NONCE por requisição) e os cabeçalhos de segurança são definidos no
// middleware.ts — nonce não pode ser estático aqui. Mantemos só o reactStrictMode.
const nextConfig = {
  reactStrictMode: true,
  // Limita os workers de prerender a um tamanho adequado ao runner de CI.
  experimental: { cpus: 2 },
};

export default nextConfig;
