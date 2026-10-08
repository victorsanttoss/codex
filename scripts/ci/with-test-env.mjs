import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Usar apenas com serviços descartáveis: os testes criam e removem dados.
// Não carrega .env nem aplica as portas pessoais de env.imob.sh.
const root = fileURLToPath(new URL("../../", import.meta.url));
const fail = (message) => {
  console.error(`Ambiente de teste: ${message}`);
  process.exit(1);
};

const pinnedNode = readFileSync(new URL("../../.node-version", import.meta.url), "utf8").trim();
if (process.versions.node !== pinnedNode) fail(`use Node ${pinnedNode} (em execução: ${process.versions.node}).`);
if (existsSync(`${root}.env`)) fail("execute em checkout limpo, sem .env pessoal; configuração sintética é injetada por este script.");

const endpoints = {};
for (const [name, protocols] of Object.entries({
  DATABASE_URL: ["postgres:", "postgresql:"],
  MIGRATION_DATABASE_URL: ["postgres:", "postgresql:"],
  REDIS_URL: ["redis:"],
})) {
  if (!process.env[name]) fail(`defina ${name} para a infraestrutura descartável local.`);
  let url;
  try { url = new URL(process.env[name]); } catch { fail(`${name} deve ser uma URL válida.`); }
  if (!protocols.includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    fail(`${name} deve apontar para um serviço local de teste.`);
  }
  endpoints[name] = url;
}
const app = endpoints.DATABASE_URL;
const migrator = endpoints.MIGRATION_DATABASE_URL;
if (!app.username || !migrator.username || app.username === migrator.username || app.username === "postgres") {
  fail("use roles distintas de aplicação e migração, sem superuser na aplicação.");
}
if (app.host !== migrator.host || app.pathname !== migrator.pathname) {
  fail("as duas roles devem usar o mesmo banco descartável.");
}

const [command, ...args] = process.argv.slice(2);
if (!command) fail("informe o comando que será executado.");
const env = { ...process.env };
// Não mantém uma segunda KEK real injetada pelo ambiente.
for (const key of Object.keys(env)) if (/^SECRETS_KEK_V\d+$/.test(key)) delete env[key];
Object.assign(env, {
  // Habilita a regressão Queue.add/Worker real no mesmo Redis local validado.
  CRM_QUEUE_TEST_REDIS_URL: process.env.REDIS_URL,
  NODE_ENV: "test",
  APP_ROLE: "api",
  LOG_LEVEL: "warn",
  JWT_ACCESS_SECRET: "ci-only-access-secret-never-use-in-production",
  JWT_REFRESH_SECRET: "ci-only-refresh-secret-never-use-in-production",
  SECRETS_KEK_V1: Buffer.alloc(32, 7).toString("base64"),
  SECRETS_KEK_ACTIVE_VERSION: "1",
  WHATSAPP_APP_SECRET: "ci-only-meta-app-secret",
  WHATSAPP_VERIFY_TOKEN: "ci-only-meta-verify-token",
  WHATSAPP_APP_ID: "ci-only-meta-app-id",
  WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: "ci-only-meta-config-id",
  WHATSAPP_SYSTEM_USER_TOKEN: "ci-only-meta-system-token",
  WHATSAPP_GRAPH_API_BASE: "http://127.0.0.1:9",
  LLM_ANTHROPIC_API_KEY: "ci-only-mocked-anthropic-key",
  LLM_OPENAI_API_KEY: "",
  LLM_OPENAI_BASE_URL: "",
  LLM_DEFAULT_MODELS: "claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-8",
  EMBEDDINGS_API_KEY: "ci-only-mocked-embedding-key",
  EMBEDDINGS_BASE_URL: "http://127.0.0.1:9/v1",
  EMBEDDINGS_MODEL: "bge-m3",
  EMBEDDINGS_DIM: "1024",
  TRANSCRIPTION_API_KEY: "ci-only-mocked-transcription-key",
  TRANSCRIPTION_BASE_URL: "http://127.0.0.1:9/v1",
  TRANSCRIPTION_ENABLED: "true",
  BAILEYS_ENABLED: "false",
  PLATFORM_ADMIN_TOKEN: "ci-only-platform-token-never-use-in-production",
  GOOGLE_CALENDAR_SA_JSON: "",
  ALERTS_WEBHOOK_URL: "",
  WEB_ORIGIN: "http://localhost:3100",
  AUTH_COOKIE_DOMAIN: "localhost",
  AUTH_COOKIE_SECURE: "false",
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  SENTRY_DSN: "",
});

const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
if (result.error) fail(`não foi possível iniciar ${command}: ${result.error.message}`);
process.exit(result.status ?? 1);
