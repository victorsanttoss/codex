import { z } from "zod";

/**
 * Configuração 12-factor validada na borda. A app NUNCA lê `process.env`
 * diretamente fora deste módulo — sempre via `loadConfig()`, tipado e validado.
 */

const durationLike = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/, "use formato como 15m, 30d, 3600s");

/**
 * Booleano tolerante a string de ENV. `z.coerce.boolean()` faz Boolean(str), o
 * que transforma "false" em TRUE — perigoso para flags de segurança. Aqui
 * "false"/"0"/"no"/"off" (case-insensitive) viram false; o resto vira true.
 */
const boolLike = z.preprocess(
  (v) => (typeof v === "string" ? !/^(false|0|no|off)$/i.test(v.trim()) : v),
  z.boolean(),
);

const ConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  /**
   * Papel do processo (M11): separa api (HTTP) / worker (consumidores de fila) /
   * scheduler (cron/scans). `all` roda tudo num processo (dev). Em VPS, sobe-se a
   * MESMA imagem com APP_ROLE diferente por container.
   */
  app: z.object({
    role: z.enum(["api", "worker", "scheduler", "session-worker", "all"]).default("all"),
  }),

  database: z.object({
    url: z.string().url(),
    migrationUrl: z.string().url(),
  }),

  redis: z.object({
    url: z.string().url(),
  }),

  api: z.object({
    port: z.coerce.number().int().positive().default(3001),
  }),

  /**
   * Origem(ns) do painel web para o CORS da API (lido AQUI, nunca de process.env
   * fora deste módulo). Aceita lista separada por vírgula. Em produção o
   * superRefine abaixo rejeita `localhost` e wildcard `*` (nunca wildcard com
   * credentials).
   */
  web: z.object({
    origin: z.string().default("http://localhost:3000"),
  }),

  auth: z.object({
    accessSecret: z.string().min(32, "JWT_ACCESS_SECRET muito curto (>=32)"),
    refreshSecret: z.string().min(32, "JWT_REFRESH_SECRET muito curto (>=32)"),
    accessTtl: durationLike.default("15m"),
    refreshTtl: durationLike.default("30d"),
    cookieDomain: z.string().default("localhost"),
    cookieSecure: boolLike.default(false),
  }),

  secrets: z.object({
    /** Mapa versão -> KEK (base64 de exatamente 32 bytes). Permite rotação. */
    keks: z.record(
      z.string(),
      z.string().refine(
        (b64) => {
          try {
            return Buffer.from(b64, "base64").length === 32;
          } catch {
            return false;
          }
        },
        { message: "KEK deve ser base64 de exatamente 32 bytes (openssl rand -base64 32)" },
      ),
    ),
    activeVersion: z.coerce.number().int().positive(),
  }),

  observability: z.object({
    otelEndpoint: z.string().url().optional(),
    otelServiceName: z.string().default("sdr-api"),
    sentryDsn: z.string().optional(),
  }),

  /**
   * Segredos da PLATAFORMA (você é o Tech Provider — um app só para todos os
   * tenants). appSecret valida a assinatura do webhook; verifyToken responde ao
   * challenge GET. NÃO confundir com o token de envio, que é por tenant
   * (TenantSecretsStore). Opcionais para não exigir em contextos sem webhook.
   */
  whatsapp: z.object({
    appSecret: z.string().optional(),
    verifyToken: z.string().optional(),
    graphApiBase: z.string().url().default("https://graph.facebook.com"),
    graphApiVersion: z.string().default("v21.0"),
    // Embedded Signup (M3) — segredos/IDs da PLATAFORMA.
    appId: z.string().optional(),
    embeddedSignupConfigId: z.string().optional(),
    systemUserToken: z.string().optional(),
  }),

  /** LLM (M4) — chave de plataforma (fallback) e modelos default da cadeia. */
  llm: z.object({
    anthropicApiKey: z.string().optional(),
    /**
     * Override OpenAI-compatible para o CHAT do agente (self-hosted vLLM/Ollama OU
     * provedor por token). Quando `openaiBaseURL` está setado, o LlmService roteia
     * o agente para este provedor (em vez do Anthropic) usando `defaultModels` como
     * nomes de modelo. Modelos self-hosted entram com preço {0,0} (fail-closed).
     */
    openaiBaseURL: z.string().url().optional(),
    openaiApiKey: z.string().optional(),
    /** Cadeia default (mais barato primeiro é decidido pelo roteador via preço). */
    defaultModels: z
      .array(z.string())
      .default(["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"]),
  }),

  /**
   * Embeddings (M5) — provedor OpenAI-compatible (self-hosted vLLM/Ollama OU por
   * token). `dim` DEVE casar com a coluna vector(N) (1024, bge-m3 — ADR 0019).
   * A chave por tenant vem do TenantSecretsStore (embedding_api_key/llm_api_key);
   * `apiKey` aqui é só o fallback de plataforma (vazio em self-hosted).
   */
  embeddings: z.object({
    baseURL: z.string().url().default("https://api.openai.com/v1"),
    defaultModel: z.string().default("bge-m3"),
    apiKey: z.string().optional(),
    dim: z.coerce.number().int().positive().default(1024),
    maxBatch: z.coerce.number().int().positive().default(96),
    /** Timeout por requisição na INGESTÃO (fila) e embeds de plataforma.
     * Self-hosted em CPU (Ollama) precisa de folga: bge-m3 leva ~3s/chunk —
     * um lote estoura os 15s fácil. */
    timeoutMs: z.coerce.number().int().positive().default(15_000),
    /** Timeout do embed de RETRIEVAL — separado de propósito: a folga da
     * ingestão NÃO pode segurar o caminho quente da conversa (RAG por turno). */
    retrievalTimeoutMs: z.coerce.number().int().positive().default(15_000),
  }),

  /**
   * Transcrição / speech-to-text (M12). `enabled=false` desliga o passo de
   * enriquecimento (áudio cai na política não-texto do M6). `baseURL`
   * configurável cobre Whisper auto-hospedado e provedores por token. Os limites
   * de duração/tamanho são o principal freio de custo do passo.
   */
  transcription: z.object({
    enabled: z
      .preprocess((v) => (typeof v === "string" ? !/^(false|0|no|off)$/i.test(v.trim()) : v), z.boolean())
      .default(true),
    baseURL: z.string().url().default("https://api.openai.com/v1"),
    defaultModel: z.string().default("whisper-1"),
    apiKey: z.string().optional(),
    languageHint: z.string().default("pt"),
    maxDurationSeconds: z.coerce.number().int().positive().default(300),
    maxBytes: z.coerce.number().int().positive().default(16 * 1024 * 1024),
  }),

  /**
   * Plataforma (M9) — staff de curadoria. `adminToken` protege as rotas de
   * curadoria/nicho (não são do tenant; usam token de plataforma, não JWT).
   */
  platform: z.object({
    // O token de bootstrap dá admin TOTAL da plataforma (fallback compartilhado
    // no PlatformStaffGuard) — exige alta entropia quando presente.
    adminToken: z.string().min(32, "PLATFORM_ADMIN_TOKEN muito curto (>=32)").optional(),
  }),

  /**
   * Canal NÃO-OFICIAL via Baileys (M13). `index`/`total` definem a ATRIBUIÇÃO
   * STICKY: cada número mora num session-worker fixo (hash(número) % total ===
   * index). `enabled=false` desliga o pool. Risco/ToS: ver ADR — default do
   * produto é a Cloud API oficial.
   */
  baileys: z
    .object({
      enabled: z
        .preprocess((v) => (typeof v === "string" ? !/^(false|0|no|off)$/i.test(v.trim()) : v), z.boolean())
        .default(false),
      workerIndex: z.coerce.number().int().min(0).default(0),
      workerTotal: z.coerce.number().int().min(1).default(1),
      reconnectBaseMs: z.coerce.number().int().positive().default(2000),
      reconnectMaxMs: z.coerce.number().int().positive().default(60000),
      qrTtlSeconds: z.coerce.number().int().positive().default(90),
    })
    // Sharding sticky inválido: index fora de [0, total) deixaria um worker sem
    // shard (ou duplicaria) — falha rápido na config.
    .refine((b) => b.workerIndex < b.workerTotal, {
      message: "SESSION_WORKER_INDEX deve ser < SESSION_WORKER_TOTAL",
      path: ["workerIndex"],
    }),

  /**
   * Google Calendar (0034) — chave de CONTA DE SERVIÇO da PLATAFORMA (uma para
   * todos os tenants; cada cliente compartilha a agenda do profissional com o
   * e-mail da SA e cola o ID da agenda no onboarding). Aceita o JSON da chave
   * puro ou em base64. Ausente → integração Google indisponível (agenda interna
   * continua funcionando).
   */
  googleCalendar: z.object({
    serviceAccountJson: z.string().optional(),
  }),

  /**
   * Operação (M11) — alertas internos para o operador (Telegram/Slack/webhook) e
   * limiares de alerta. Sem webhook → alertas só em log.
   */
  alerts: z.object({
    webhookUrl: z.string().url().optional(),
    diskThresholdPercent: z.coerce.number().int().min(1).max(100).default(85),
    outboxFailedThreshold: z.coerce.number().int().min(1).default(20),
    queueBacklogThreshold: z.coerce.number().int().min(1).default(1000),
  }),
});

/**
 * Placeholders conhecidos dos arquivos-modelo (.env.example). Se um SEGREDO em
 * produção ainda os contém, o operador esqueceu de trocar — falha o boot.
 */
const PLACEHOLDER_PATTERN = /troque|GERE_|CHANGE|example|xxxx/i;

/** Uma origem é insegura para prod se for localhost/vazia ou o wildcard `*`. */
function isLocalOrigin(origin: string): boolean {
  const o = origin.trim().toLowerCase();
  return o.length === 0 || o.includes("localhost") || o.includes("127.0.0.1");
}

/**
 * ENDURECIMENTO EM PRODUÇÃO (nada muda em dev/test): quando NODE_ENV=production,
 * exige postura segura e falha o boot com mensagem apontando QUAL variável
 * corrigir. Segredos ausentes, placeholders esquecidos, cookie inseguro ou CORS
 * frouxo derrubam o processo cedo — em vez de rodar exposto.
 */
const HardenedConfigSchema = ConfigSchema.superRefine((cfg, ctx) => {
  if (cfg.nodeEnv !== "production") return;

  const fail = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };

  // Cookies de sessão precisam ser Secure + domínio real atrás de HTTPS.
  if (cfg.auth.cookieSecure !== true) {
    fail(["auth", "cookieSecure"], "em produção AUTH_COOKIE_SECURE deve ser true (cookies só por HTTPS)");
  }
  if (isLocalOrigin(cfg.auth.cookieDomain)) {
    fail(["auth", "cookieDomain"], "em produção defina AUTH_COOKIE_DOMAIN com o domínio real (não localhost/vazio)");
  }

  // Segredos de plataforma obrigatórios em prod.
  if (!cfg.whatsapp.appSecret) {
    fail(["whatsapp", "appSecret"], "em produção WHATSAPP_APP_SECRET é obrigatório (valida a assinatura do webhook)");
  }
  if (!cfg.platform.adminToken) {
    fail(["platform", "adminToken"], "em produção PLATFORM_ADMIN_TOKEN é obrigatório (admin de bootstrap da plataforma)");
  }

  // CORS: origem real, nunca localhost nem wildcard com credentials.
  const origins = cfg.web.origin.split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.length === 0 || origins.some(isLocalOrigin)) {
    fail(["web", "origin"], "em produção WEB_ORIGIN deve ser a origem real do painel (não localhost/vazio)");
  }
  if (origins.includes("*")) {
    fail(["web", "origin"], "WEB_ORIGIN não pode ser wildcard `*` — o CORS usa credentials");
  }

  // Placeholders esquecidos em qualquer segredo → boot falha apontando a variável.
  const secretVars: [string, string | undefined][] = [
    ["JWT_ACCESS_SECRET", cfg.auth.accessSecret],
    ["JWT_REFRESH_SECRET", cfg.auth.refreshSecret],
    ["WHATSAPP_APP_SECRET", cfg.whatsapp.appSecret],
    ["WHATSAPP_VERIFY_TOKEN", cfg.whatsapp.verifyToken],
    ["PLATFORM_ADMIN_TOKEN", cfg.platform.adminToken],
    ["DATABASE_URL", cfg.database.url],
    ["MIGRATION_DATABASE_URL", cfg.database.migrationUrl],
    ...Object.entries(cfg.secrets.keks).map(
      ([v, k]) => [`SECRETS_KEK_V${v}`, k] as [string, string],
    ),
  ];
  for (const [name, value] of secretVars) {
    if (value && PLACEHOLDER_PATTERN.test(value)) {
      fail([name], `${name} ainda contém um placeholder do .env.example — gere um valor real`);
    }
  }
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** Coleta as KEKs versionadas a partir de SECRETS_KEK_V1, SECRETS_KEK_V2, ... */
function collectKeks(env: NodeJS.ProcessEnv): Record<string, string> {
  const keks: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^SECRETS_KEK_V(\d+)$/.exec(key);
    if (match && value) keks[match[1]!] = value;
  }
  return keks;
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = HardenedConfigSchema.safeParse({
    nodeEnv: clean(env.NODE_ENV),
    logLevel: clean(env.LOG_LEVEL),
    app: { role: clean(env.APP_ROLE) },
    database: {
      url: clean(env.DATABASE_URL),
      migrationUrl: clean(env.MIGRATION_DATABASE_URL),
    },
    redis: { url: clean(env.REDIS_URL) },
    api: { port: clean(env.API_PORT) },
    web: { origin: clean(env.WEB_ORIGIN) },
    auth: {
      accessSecret: clean(env.JWT_ACCESS_SECRET),
      refreshSecret: clean(env.JWT_REFRESH_SECRET),
      accessTtl: clean(env.JWT_ACCESS_TTL),
      refreshTtl: clean(env.JWT_REFRESH_TTL),
      cookieDomain: clean(env.AUTH_COOKIE_DOMAIN),
      cookieSecure: clean(env.AUTH_COOKIE_SECURE),
    },
    secrets: {
      keks: collectKeks(env),
      activeVersion: clean(env.SECRETS_KEK_ACTIVE_VERSION),
    },
    observability: {
      otelEndpoint: clean(env.OTEL_EXPORTER_OTLP_ENDPOINT),
      otelServiceName: clean(env.OTEL_SERVICE_NAME),
      sentryDsn: clean(env.SENTRY_DSN),
    },
    whatsapp: {
      appSecret: clean(env.WHATSAPP_APP_SECRET),
      verifyToken: clean(env.WHATSAPP_VERIFY_TOKEN),
      graphApiBase: clean(env.WHATSAPP_GRAPH_API_BASE),
      graphApiVersion: clean(env.WHATSAPP_GRAPH_API_VERSION),
      appId: clean(env.WHATSAPP_APP_ID),
      embeddedSignupConfigId: clean(env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID),
      systemUserToken: clean(env.WHATSAPP_SYSTEM_USER_TOKEN),
    },
    llm: {
      ...(clean(env.LLM_ANTHROPIC_API_KEY) ? { anthropicApiKey: clean(env.LLM_ANTHROPIC_API_KEY) } : {}),
      ...(clean(env.LLM_OPENAI_BASE_URL) ? { openaiBaseURL: clean(env.LLM_OPENAI_BASE_URL) } : {}),
      ...(clean(env.LLM_OPENAI_API_KEY) ? { openaiApiKey: clean(env.LLM_OPENAI_API_KEY) } : {}),
      ...(clean(env.LLM_DEFAULT_MODELS)
        ? { defaultModels: clean(env.LLM_DEFAULT_MODELS)!.split(",").map((s) => s.trim()) }
        : {}),
    },
    embeddings: {
      ...(clean(env.EMBEDDINGS_BASE_URL) ? { baseURL: clean(env.EMBEDDINGS_BASE_URL) } : {}),
      ...(clean(env.EMBEDDINGS_MODEL) ? { defaultModel: clean(env.EMBEDDINGS_MODEL) } : {}),
      ...(clean(env.EMBEDDINGS_API_KEY) ? { apiKey: clean(env.EMBEDDINGS_API_KEY) } : {}),
      ...(clean(env.EMBEDDINGS_DIM) ? { dim: clean(env.EMBEDDINGS_DIM) } : {}),
      ...(clean(env.EMBEDDINGS_MAX_BATCH) ? { maxBatch: clean(env.EMBEDDINGS_MAX_BATCH) } : {}),
      ...(clean(env.EMBEDDINGS_TIMEOUT_MS) ? { timeoutMs: clean(env.EMBEDDINGS_TIMEOUT_MS) } : {}),
      ...(clean(env.EMBEDDINGS_RETRIEVAL_TIMEOUT_MS)
        ? { retrievalTimeoutMs: clean(env.EMBEDDINGS_RETRIEVAL_TIMEOUT_MS) }
        : {}),
    },
    transcription: {
      ...(clean(env.TRANSCRIPTION_ENABLED) ? { enabled: clean(env.TRANSCRIPTION_ENABLED) } : {}),
      ...(clean(env.TRANSCRIPTION_BASE_URL) ? { baseURL: clean(env.TRANSCRIPTION_BASE_URL) } : {}),
      ...(clean(env.TRANSCRIPTION_MODEL) ? { defaultModel: clean(env.TRANSCRIPTION_MODEL) } : {}),
      ...(clean(env.TRANSCRIPTION_API_KEY) ? { apiKey: clean(env.TRANSCRIPTION_API_KEY) } : {}),
      ...(clean(env.TRANSCRIPTION_LANGUAGE) ? { languageHint: clean(env.TRANSCRIPTION_LANGUAGE) } : {}),
      ...(clean(env.TRANSCRIPTION_MAX_DURATION_SECONDS) ? { maxDurationSeconds: clean(env.TRANSCRIPTION_MAX_DURATION_SECONDS) } : {}),
      ...(clean(env.TRANSCRIPTION_MAX_BYTES) ? { maxBytes: clean(env.TRANSCRIPTION_MAX_BYTES) } : {}),
    },
    baileys: {
      ...(clean(env.BAILEYS_ENABLED) ? { enabled: clean(env.BAILEYS_ENABLED) } : {}),
      ...(clean(env.SESSION_WORKER_INDEX) ? { workerIndex: clean(env.SESSION_WORKER_INDEX) } : {}),
      ...(clean(env.SESSION_WORKER_TOTAL) ? { workerTotal: clean(env.SESSION_WORKER_TOTAL) } : {}),
      ...(clean(env.BAILEYS_RECONNECT_BASE_MS) ? { reconnectBaseMs: clean(env.BAILEYS_RECONNECT_BASE_MS) } : {}),
      ...(clean(env.BAILEYS_RECONNECT_MAX_MS) ? { reconnectMaxMs: clean(env.BAILEYS_RECONNECT_MAX_MS) } : {}),
      ...(clean(env.BAILEYS_QR_TTL_SECONDS) ? { qrTtlSeconds: clean(env.BAILEYS_QR_TTL_SECONDS) } : {}),
    },
    platform: {
      ...(clean(env.PLATFORM_ADMIN_TOKEN) ? { adminToken: clean(env.PLATFORM_ADMIN_TOKEN) } : {}),
    },
    googleCalendar: {
      ...(clean(env.GOOGLE_CALENDAR_SA_JSON)
        ? { serviceAccountJson: clean(env.GOOGLE_CALENDAR_SA_JSON) }
        : {}),
    },
    alerts: {
      ...(clean(env.ALERTS_WEBHOOK_URL) ? { webhookUrl: clean(env.ALERTS_WEBHOOK_URL) } : {}),
      ...(clean(env.ALERTS_DISK_THRESHOLD) ? { diskThresholdPercent: clean(env.ALERTS_DISK_THRESHOLD) } : {}),
      ...(clean(env.ALERTS_OUTBOX_FAILED_THRESHOLD) ? { outboxFailedThreshold: clean(env.ALERTS_OUTBOX_FAILED_THRESHOLD) } : {}),
      ...(clean(env.ALERTS_QUEUE_BACKLOG_THRESHOLD) ? { queueBacklogThreshold: clean(env.ALERTS_QUEUE_BACKLOG_THRESHOLD) } : {}),
    },
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuração inválida:\n${issues}`);
  }

  const cfg = parsed.data;
  if (!cfg.secrets.keks[String(cfg.secrets.activeVersion)]) {
    throw new Error(
      `SECRETS_KEK_ACTIVE_VERSION=${cfg.secrets.activeVersion} não tem KEK correspondente (defina SECRETS_KEK_V${cfg.secrets.activeVersion}).`,
    );
  }
  return cfg;
}
