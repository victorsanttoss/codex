import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Carrega o .env da raiz para os testes que tocam infra (auto-pulam sem ele).
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

export default defineConfig({
  // esbuild com decorators legados (NestJS) para os arquivos importados nos testes.
  esbuild: { target: "es2022" },
  test: {
    // src/e2e/** fica FORA desta config: o e2e sobe o AppModule real e a DI do
    // Nest exige emitDecoratorMetadata, que o esbuild não emite — roda via SWC
    // na vitest.e2e.config.ts (`npx vitest run --config vitest.e2e.config.ts`).
    include: ["src/!(e2e)/**/*.test.ts"],
    // Os testes de integração compartilham UM Postgres; rodar os arquivos em um
    // único fork (sequencial) evita corrida de conexões/closeDb entre arquivos.
    poolOptions: { forks: { singleFork: true } },
  },
});
