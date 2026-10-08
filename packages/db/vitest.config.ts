import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Carrega o .env da raiz (se existir) para que os testes de integração que
// dependem de Postgres/Redis recebam a config. Sem .env, eles se auto-pulam.
const envPath = join(__dirname, "..", "..", ".env");
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
