import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Carrega o .env da raiz para os testes que tocam infra (auto-pulam sem ele).
// (Mesmo bloco do vitest.config.ts — mantido em sincronia.)
const envPath = join(__dirname, "..", "..", ".env");
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = line.slice(eq + 1).trim();
  }
}

/**
 * Config DEDICADA aos testes e2e HTTP (src/e2e/**).
 *
 * Por que não a config padrão: o e2e sobe o AppModule REAL via
 * Test.createTestingModule, e a injeção de dependências do Nest depende de
 * `emitDecoratorMetadata` (design:paramtypes) — que o esbuild (transform padrão
 * do vitest) NÃO suporta. O SWC emite a metadata (lê experimentalDecorators/
 * emitDecoratorMetadata do tsconfig). Os testes unit/integration existentes
 * instanciam services manualmente e continuam na config padrão, intocados.
 *
 * Rodar: npx vitest run --config vitest.e2e.config.ts
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["src/e2e/**/*.test.ts"],
    // Compartilha UM Postgres/Redis; sequencial evita corrida de conexões.
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
