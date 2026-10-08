import {
  bigint,
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Schema da FUNDAÇÃO (M1) — apenas as 7 tabelas da base. Tabelas de embeddings
 * e demais domínios pertencem a módulos futuros.
 *
 * IMPORTANTE: RLS (enable + FORCE + policies) é aplicado nas MIGRATIONS SQL
 * (migrations/0001_init.sql), não aqui — o Drizzle pg-core não expressa RLS.
 * O teste de catálogo (rls-catalog.test.ts) garante que toda tabela
 * tenant-scoped tenha RLS forçado + policy. Ver docs/M1-codex-review.md (#1/#2).
 */

export const membershipRole = pgEnum("membership_role", ["owner", "admin", "agent"]);
export const tenantStatus = pgEnum("tenant_status", ["active", "suspended", "deleted"]);
export const tenantSecretKind = pgEnum("tenant_secret_kind", [
  "whatsapp_token",
  "crm_api_key",
  "llm_api_key",
  "embedding_api_key",
  "transcription_api_key",
]);

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ── tenants ───────────────────────────────────────────────────
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: tenantStatus("status").notNull().default("active"),
  plan: text("plan").notNull().default("free"),
  createdAt: now(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── users ─────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: now(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── memberships (N:N user<->tenant com papel) ─────────────────
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull().default("agent"),
    createdAt: now(),
  },
  (t) => ({
    uniqUserTenant: unique("memberships_user_tenant_uniq").on(t.userId, t.tenantId),
    byTenant: index("memberships_tenant_idx").on(t.tenantId),
  }),
);

// ── tenant_secrets (credenciais cifradas — envelope encryption) ─
export const tenantSecrets = pgTable(
  "tenant_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: tenantSecretKind("kind").notNull(),
    ciphertext: text("ciphertext").notNull(), // blob base64 (ver @sdr/core EnvelopeCipher)
    nonce: text("nonce").notNull(), // base64
    keyVersion: bigint("key_version", { mode: "number" }).notNull(),
    createdAt: now(),
  },
  (t) => ({
    byTenantKind: unique("tenant_secrets_tenant_kind_uniq").on(t.tenantId, t.kind),
  }),
);

// ── usage_events (metering) ───────────────────────────────────
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    model: text("model"),
    channel: text("channel"),
    tokensIn: bigint("tokens_in", { mode: "number" }),
    tokensOut: bigint("tokens_out", { mode: "number" }),
    costMicros: bigint("cost_micros", { mode: "number" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    byTenantTime: index("usage_events_tenant_time_idx").on(t.tenantId, t.occurredAt),
  }),
);

// ── processed_messages (idempotência/dedup de webhook) ────────
export const processedMessages = pgTable(
  "processed_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    conversationKey: text("conversation_key").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // dedup POR TENANT: IDs externos podem colidir entre tenants (vias não-oficiais).
    // Constraint global causaria falso-duplicado/perda de mensagem cross-tenant.
    uniqTenantProviderMsg: unique("processed_messages_tenant_provider_msg_uniq").on(
      t.tenantId,
      t.provider,
      t.externalMessageId,
    ),
    byConversation: index("processed_messages_conversation_idx").on(t.conversationKey),
  }),
);

// ── audit_log (operações sensíveis / caminho system) ─────────
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id"), // nullable: eventos system podem não ter tenant
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTenantTime: index("audit_log_tenant_time_idx").on(t.tenantId, t.at),
  }),
);

// ── M2: canal WhatsApp ────────────────────────────────────────
export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);
export const messageStatus = pgEnum("message_status", [
  "received",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
]);

// Mapeia conta externa (phone_number_id) -> tenant. Tenant-scoped, mas com
// lookup por phone_number_id no caminho system (ver policy na migration 0002).
export const channelConnections = pgTable(
  "channel_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("cloud_api"),
    phoneNumberId: text("phone_number_id").notNull(),
    wabaId: text("waba_id"),
    displayPhone: text("display_phone"),
    status: text("status").notNull().default("active"),
    /** Qual kind do tenant_secrets guarda o token de envio. */
    secretRef: tenantSecretKind("secret_ref").notNull().default("whatsapp_token"),
    createdAt: now(),
    // Lifecycle (M3 / Embedded Signup)
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    systemUserId: text("system_user_id"),
    subscribedAt: timestamp("subscribed_at", { withTimezone: true }),
    lastLifecycleEventAt: timestamp("last_lifecycle_event_at", { withTimezone: true }),
  },
  (t) => ({
    // phone_number_id é GLOBALMENTE único: pertence a exatamente um tenant.
    uniqPhoneNumberId: unique("channel_connections_phone_number_id_uniq").on(t.phoneNumberId),
    byTenant: index("channel_connections_tenant_idx").on(t.tenantId),
  }),
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    waId: text("wa_id").notNull(),
    phone: text("phone"),
    profileName: text("profile_name"),
    // M8: opt-out (LGPD) — contato que pediu saída NUNCA é cadenciado.
    optedOut: boolean("opted_out").notNull().default(false),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantWaId: unique("contacts_tenant_wa_id_uniq").on(t.tenantId, t.waId),
  }),
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channel: text("channel").notNull().default("whatsapp"),
    conversationKey: text("conversation_key").notNull(),
    status: text("status").notNull().default("open"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    /** Fim da janela de 24h (free-form permitido só até aqui). */
    windowExpiresAt: timestamp("window_expires_at", { withTimezone: true }),
    // M14: humano assumiu a conversa → IA pausa nela (guardrail no handler).
    humanTakeover: boolean("human_takeover").notNull().default(false),
    humanTakeoverAt: timestamp("human_takeover_at", { withTimezone: true }),
    // M14: conversa de sandbox do Playground (excluída das listas do painel).
    sandbox: boolean("sandbox").notNull().default(false),
    createdAt: now(),
  },
  (t) => ({
    uniqTenantConversationKey: unique("conversations_tenant_key_uniq").on(
      t.tenantId,
      t.conversationKey,
    ),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: messageDirection("direction").notNull(),
    type: text("type").notNull(),
    content: jsonb("content").notNull().default(sql`'{}'::jsonb`),
    externalMessageId: text("external_message_id"),
    status: messageStatus("status").notNull(),
    error: jsonb("error"),
    createdAt: now(),
    statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // unique parcial-ish: nulls são distintos no PG, então outbound antes de ter id ok
    uniqTenantExternalMsg: unique("messages_tenant_external_uniq").on(
      t.tenantId,
      t.externalMessageId,
    ),
    byConversation: index("messages_conversation_idx").on(t.conversationId, t.createdAt),
  }),
);

export const mediaObjects = pgTable(
  "media_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    providerMediaId: text("provider_media_id").notNull(),
    mimeType: text("mime_type"),
    storageRef: text("storage_ref"),
    sha256: text("sha256"),
    size: bigint("size", { mode: "number" }),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
    // M12: cache de transcrição (speech-to-text) por mídia.
    transcription: text("transcription"),
    transcriptionSeconds: integer("transcription_seconds"),
    transcribedAt: timestamp("transcribed_at", { withTimezone: true }),
  },
  (t) => ({
    byMessage: index("media_objects_message_idx").on(t.messageId),
    byProviderMedia: index("media_objects_provider_media_idx").on(t.tenantId, t.providerMediaId),
  }),
);

// ── M5: conhecimento / RAG (pgvector) ─────────────────────────
/**
 * Dimensão FIXA do vetor de embeddings da plataforma (modelo default bge-m3 —
 * ver ADR 0019). A coluna `vector(N)` é criada com este N na migration 0006;
 * vetor de tamanho diferente é rejeitado (fail-closed) no repo e no banco.
 */
export const KNOWLEDGE_VECTOR_DIM = 1024;

/** Tipo pgvector. Literal de driver no formato `[v1,v2,...]`. */
const vector = (dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dim})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      return value.replace(/^\[|\]$/g, "").split(",").map(Number);
    },
  });

export const knowledgeSourceKind = pgEnum("knowledge_source_kind", ["faq", "doc", "text"]);

// Fonte de conhecimento do TENANT (a camada de nicho virá em storage próprio —
// ver ADR 0021). Identidade estável por (tenant_id, external_ref) p/ re-ingestão.
export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    externalRef: text("external_ref").notNull(),
    kind: knowledgeSourceKind("kind").notNull().default("text"),
    title: text("title").notNull(),
    status: text("status").notNull().default("pending"), // pending | ready | failed
    contentHash: text("content_hash").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    dim: integer("dim").notNull(),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantExternalRef: unique("knowledge_sources_tenant_ref_uniq").on(t.tenantId, t.externalRef),
    byTenant: index("knowledge_sources_tenant_idx").on(t.tenantId),
  }),
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    embedding: vector(KNOWLEDGE_VECTOR_DIM)("embedding").notNull(),
    tokenCount: integer("token_count"),
    embeddingModel: text("embedding_model").notNull(),
    dim: integer("dim").notNull(),
    createdAt: now(),
  },
  (t) => ({
    bySource: index("knowledge_chunks_source_idx").on(t.sourceId),
    // índice vetorial hnsw (cosine) é criado na migration (drizzle não expressa).
  }),
);

// ── M6: agente SDR (estado do lead/funil, idempotência de resposta, config) ──
// Estado do lead por conversa (funil + campos qualificados + resumo rolante).
export const leadProfiles = pgTable(
  "lead_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    stage: text("stage").notNull().default("discovery"),
    status: text("status").notNull().default("new"), // new | qualified | disqualified | handoff
    score: integer("score").notNull().default(0),
    /** Campos qualificados EXTRAÍDOS pela IA (a decisão é do código). */
    fields: jsonb("fields").notNull().default(sql`'{}'::jsonb`),
    /** Resumo rolante da conversa (mantém custo/contexto sob controle). */
    summary: text("summary"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantConversation: unique("lead_profiles_tenant_conversation_uniq").on(
      t.tenantId,
      t.conversationId,
    ),
  }),
);

// Idempotência de ENVIO: a chave é reivindicada ANTES de chamar a Cloud API.
// Reivindicada → não envia de novo (no máximo um envio por passo, mesmo no retry).
export const agentResponseClaims = pgTable(
  "agent_response_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    claimKey: text("claim_key").notNull(),
    createdAt: now(),
  },
  (t) => ({
    uniqTenantClaim: unique("agent_response_claims_tenant_key_uniq").on(t.tenantId, t.claimKey),
  }),
);

// Config do agente por tenant (persona, schema de qualificação, guardrails) —
// data-driven. Resolvida por tenant agora; por nicho depois (ADR 0022).
export const agentConfigs = pgTable("agent_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  createdAt: now(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── M7: CRM built-in + agendamento + notificação ──────────────
export const crmContacts = pgTable(
  "crm_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    name: text("name"),
    fields: jsonb("fields").notNull().default(sql`'{}'::jsonb`),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantPhone: unique("crm_contacts_tenant_phone_uniq").on(t.tenantId, t.phone),
    uniqTenantId: unique("crm_contacts_tenant_id_uniq").on(t.tenantId, t.id), // p/ FK composta
  }),
);

export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull(),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    stage: text("stage").notNull().default("qualified"),
    status: text("status").notNull().default("open"),
    score: integer("score"),
    value: integer("value"),
    externalId: text("external_id"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantContact: unique("opportunities_tenant_contact_uniq").on(t.tenantId, t.contactId),
  }),
);

export const activities = pgTable("activities", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull(),
  kind: text("kind").notNull(),
  body: text("body").notNull(),
  createdAt: now(),
});

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    whenText: text("when_text"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    details: text("details").notNull(),
    status: text("status").notNull().default("requested"),
    externalId: text("external_id"),
    // Em qual agenda do pool a reserva caiu (0036). Nullable p/ compat com
    // appointments que não passam por agenda. FK composta vive na migration.
    calendarId: uuid("calendar_id"),
    createdAt: now(),
  },
  (t) => ({
    uniqTenantKey: unique("appointments_tenant_key_uniq").on(t.tenantId, t.idempotencyKey),
  }),
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    read: boolean("read").notNull().default(false),
    createdAt: now(),
  },
  (t) => ({
    uniqTenantKey: unique("notifications_tenant_key_uniq").on(t.tenantId, t.idempotencyKey),
  }),
);

// Mapa lead(conversa) → IDs externos do CRM + status de sync (idempotência).
export const crmExternalSync = pgTable(
  "crm_external_sync",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    crmAdapter: text("crm_adapter").notNull(),
    contactExternalId: text("contact_external_id"),
    opportunityExternalId: text("opportunity_external_id"),
    status: text("status").notNull().default("pending"), // pending | synced | failed
    lastError: text("last_error"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantConversation: unique("crm_external_sync_tenant_conversation_uniq").on(
      t.tenantId,
      t.conversationId,
    ),
  }),
);

// ── M8: cadência / follow-up proativo + outbox de entrega ─────
// Outbox de saída: máquina de estados pending->sending->sent->delivered/read/failed.
// Enfileirar = inserir 'pending' com idempotency_key único (reivindica o envio).
export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    /**
     * Conexão (número) pela qual esta linha deve SAIR — registrada no enqueue a
     * partir da conversa (migration 0030). NULL = fallback por tenant (legado).
     */
    connectionId: uuid("connection_id").references(() => channelConnections.id, {
      onDelete: "set null",
    }),
    toPhone: text("to_phone").notNull(),
    kind: text("kind").notNull(), // template | free_form
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    idempotencyKey: text("idempotency_key").notNull(),
    /** Correlação no provedor (biz_opaque_callback_data) — echo nos status, NÃO dedup. */
    clientMessageId: text("client_message_id").notNull(),
    status: text("status").notNull().default("pending"),
    externalMessageId: text("external_message_id"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    /** Tarifação: 'template' (pago) | 'service' (gratuito na janela). */
    billing: text("billing").notNull().default("service"),
    /** Origem: 'proactive' (cadência/scheduler) | 'reactive' (resposta do agente, nasce 'sent'). */
    origin: text("origin").notNull().default("proactive"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantKey: unique("outbox_messages_tenant_key_uniq").on(t.tenantId, t.idempotencyKey),
    byStatusSched: index("outbox_messages_status_sched_idx").on(t.status, t.scheduledFor),
    byExternal: index("outbox_messages_external_idx").on(t.externalMessageId),
    byConnection: index("outbox_messages_connection_idx").on(t.connectionId),
  }),
);

// Estado da cadência por conversa (um follow-up por vez).
export const cadenceState = pgTable(
  "cadence_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    currentStep: integer("current_step").notNull().default(0),
    nextStepAt: timestamp("next_step_at", { withTimezone: true }),
    status: text("status").notNull().default("active"), // active | stopped | completed
    stopReason: text("stop_reason"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantConversation: unique("cadence_state_tenant_conversation_uniq").on(
      t.tenantId,
      t.conversationId,
    ),
    byStatusNext: index("cadence_state_status_next_idx").on(t.status, t.nextStepAt),
  }),
);

// Catálogo de templates (HSM) aprovados — a aprovação na Meta é externa.
export const messageTemplates = pgTable(
  "message_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    languageCode: text("language_code").notNull().default("pt_BR"),
    category: text("category").notNull().default("marketing"),
    /** Lista de nomes de variáveis esperadas. */
    variables: jsonb("variables").notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("approved"),
    /**
     * Corpo da mensagem escrito pelo cliente (M8-ext). Baileys envia como texto;
     * Cloud API usa como fonte da submissão do HSM à Meta (envio segue por nome).
     */
    bodyText: text("body_text"),
    /** Id do template na Meta (Graph POST) — correlaciona o webhook de aprovação. */
    metaTemplateId: text("meta_template_id"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantNameLang: unique("message_templates_tenant_name_lang_uniq").on(
      t.tenantId,
      t.name,
      t.languageCode,
    ),
  }),
);

// ── M9: camada de NICHO + curadoria (storage de PLATAFORMA) ───
// Metering de PLATAFORMA (curadoria) — NÃO tenant-scoped, NÃO faturado ao tenant.
export const platformUsage = pgTable("platform_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(), // ex.: curation_embedding | curation_llm
  tokensIn: bigint("tokens_in", { mode: "number" }),
  tokensOut: bigint("tokens_out", { mode: "number" }),
  costMicros: bigint("cost_micros", { mode: "number" }),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

// niches: dado de referência da plataforma (não tenant-scoped). vertical × motion.
export const niches = pgTable("niches", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  vertical: text("vertical").notNull(),
  motion: text("motion").notNull(),
  /** Orientação de nicho injetada no prompt (nicheLayer). */
  guidance: text("guidance"),
  status: text("status").notNull().default("active"),
  createdAt: now(),
});

/** M14: staff da plataforma (dado de plataforma, NÃO tenant-scoped). */
export const platformStaff = pgTable("platform_staff", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").notNull().default("support"),
  /** sha256 hex do token pessoal do staff (M14). NULL = sem token, não autentica. */
  tokenHash: text("token_hash"),
  createdAt: now(),
});

// Vínculo tenant → nicho. TENANT-SCOPED (o tenant só vê o próprio vínculo);
// o servidor resolve o nicho a partir daqui (o tenant não pode forjar).
export const tenantNiche = pgTable("tenant_niche", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  nicheId: uuid("niche_id")
    .notNull()
    .references(() => niches.id, { onDelete: "restrict" }),
  createdAt: now(),
});

// Conhecimento de nicho — COMPARTILHADO entre tenants do nicho. RLS por
// `app.niche_id` (leitura); escrita exige `app.curation` (só curadoria).
export const nicheKnowledge = pgTable(
  "niche_knowledge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nicheId: uuid("niche_id")
      .notNull()
      .references(() => niches.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    embedding: vector(KNOWLEDGE_VECTOR_DIM)("embedding").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("active"), // active | retired
    sourceKind: text("source_kind").notNull().default("manual"),
    createdAt: now(),
  },
  (t) => ({
    byNiche: index("niche_knowledge_niche_idx").on(t.nicheId),
  }),
);

// Config por NICHO (M10): schema de qualificação + versão do kit aplicado.
// Mesma RLS do niche_knowledge (leitura por app.niche_id; escrita só na curadoria).
export const nicheConfigs = pgTable("niche_configs", {
  nicheId: uuid("niche_id")
    .primaryKey()
    .references(() => niches.id, { onDelete: "cascade" }),
  qualification: jsonb("qualification"),
  /** Versão (semver) do kit aplicado — idempotência. */
  kitVersion: text("kit_version"),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  createdAt: now(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Candidatos de curadoria — só acessíveis via `app.curation` (INVISÍVEIS a tenants).
export const curationCandidates = pgTable(
  "curation_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nicheId: uuid("niche_id")
      .notNull()
      .references(() => niches.id, { onDelete: "cascade" }),
    candidateType: text("candidate_type").notNull(),
    /** Conteúdo ANONIMIZADO (sem PII / sem identidade do tenant). */
    content: text("content").notNull(),
    evidenceCount: integer("evidence_count").notNull().default(1),
    /** Auditoria-only — NUNCA exposto fora da curadoria. */
    sourceTenantId: uuid("source_tenant_id"),
    sourceRefs: jsonb("source_refs").notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("pending"), // pending|approved|rejected|promoted
    redactionChecked: boolean("redaction_checked").notNull().default(false),
    curatorId: text("curator_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    byNicheStatus: index("curation_candidates_niche_status_idx").on(t.nicheId, t.status),
  }),
);

/**
 * M13: sessão CIFRADA do Baileys por número (auth state: creds + signal keys).
 * Persiste para reconectar sem re-escanear QR após restart. O blob é cifrado com
 * a mesma envelope encryption dos segredos (AAD `tenantId:baileys_session:phone`);
 * NUNCA em log. Uma linha por (tenant, número).
 */
export const baileysSessions = pgTable(
  "baileys_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    phoneNumberId: text("phone_number_id").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    keyVersion: integer("key_version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantPhone: unique("baileys_sessions_tenant_phone_uniq").on(t.tenantId, t.phoneNumberId),
  }),
);

/**
 * M14: estado do onboarding (wizard) por tenant. Autosave por etapa; payload jsonb
 * acumulado; activated_at marca a SDR ao vivo. RLS por tenant.
 */
export const tenantOnboarding = pgTable("tenant_onboarding", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  step: integer("step").notNull().default(1),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Sessões de REFRESH (ADR 0006, dívida fechada na 0031): uma linha por refresh
 * token emitido. Guarda só o sha256 do `jti` embutido no JWT. Rotação no
 * refresh (revoga a antiga, emite nova); reuso de token rotacionado revoga
 * TODAS as sessões do usuário (OWASP). RLS por tenant OU pelo próprio usuário
 * (padrão memberships — refresh/logout rodam antes de haver tenant ativo).
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique("auth_sessions_token_hash_uniq"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: now(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    byUser: index("auth_sessions_user_idx").on(t.userId),
  }),
);

/**
 * Quarentena de inbound (0032): payload do webhook cujo destino é uma conexão
 * NÃO-ativa (disconnected/connecting) — antes era descartado em silêncio. O
 * payload é o MESMO job da WebhookQueue ({headers, query, rawBody}) para replay
 * fiel (assinatura verifica de novo); o sweep re-enfileira quando a conexão
 * volta a `active` e marca replayed_at. Dedup do pipeline protege duplicatas.
 */
export const inboundQuarantine = pgTable(
  "inbound_quarantine",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    phoneNumberId: text("phone_number_id").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    replayedAt: timestamp("replayed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pendingIdx: index("inbound_quarantine_pending_idx").on(t.tenantId, t.receivedAt),
  }),
);

/**
 * Agenda da plataforma (0034): estilo Google Agenda, N agendas por tenant
 * (v1 usa a default). `provider` decide de onde vem a DISPONIBILIDADE e para
 * onde vai o evento agendado pela SDR: 'internal' (só esta tabela) ou 'google'
 * (freebusy + insert na agenda externa via conta de serviço da plataforma).
 */
export const calendars = pgTable(
  "calendars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Agenda principal"),
    timezone: text("timezone").notNull().default("America/Sao_Paulo"),
    provider: text("provider").notNull().default("internal"),
    externalCalendarId: text("external_calendar_id"),
    isDefault: boolean("is_default").notNull().default(true),
    // NULL = agenda ativa (participa do pool de agendamento); setado = removida
    // do pool sem apagar o histórico (soft-delete, 0036).
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantId: unique("calendars_tenant_id_uniq").on(t.tenantId, t.id),
  }),
);

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    calendarId: uuid("calendar_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    status: text("status").notNull().default("confirmed"),
    source: text("source").notNull().default("manual"),
    appointmentId: uuid("appointment_id"),
    externalEventId: text("external_event_id"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    rangeIdx: index("calendar_events_range_idx").on(t.tenantId, t.calendarId, t.startsAt),
  }),
);

// ── 0037 — vertical imobiliária: distribuição p/ corretores + SLA ────────────

export const imobAgencies = pgTable(
  "imob_agencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    uniqTenantId: unique("imob_agencies_tenant_id_uniq").on(t.tenantId, t.id),
    uniqTenantName: unique("imob_agencies_tenant_name_uniq").on(t.tenantId, t.name),
  }),
);

export const imobBrokers = pgTable(
  "imob_brokers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agencyId: uuid("agency_id"),
    name: text("name").notNull(),
    // dígitos E.164 sem '+' — identifica o corretor no inbound
    whatsapp: text("whatsapp").notNull(),
    // LID do Baileys quando conhecido (conexão não-oficial)
    waId: text("wa_id"),
    regions: text("regions").array().notNull().default(sql`'{}'::text[]`),
    dailyCapacity: integer("daily_capacity").notNull().default(10),
    // 0040: bump invalida links do workspace emitidos antes (revogação)
    accessTokenVersion: integer("access_token_version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantId: unique("imob_brokers_tenant_id_uniq").on(t.tenantId, t.id),
    uniqTenantWhatsapp: unique("imob_brokers_tenant_whatsapp_uniq").on(t.tenantId, t.whatsapp),
    // 0038: wa_id único quando preenchido (identidade do corretor no inbound)
    uniqTenantWaId: uniqueIndex("imob_brokers_tenant_wa_id_uniq")
      .on(t.tenantId, t.waId)
      .where(sql`wa_id IS NOT NULL`),
    agencyFk: foreignKey({
      name: "imob_brokers_agency_same_tenant_fk",
      columns: [t.tenantId, t.agencyId],
      foreignColumns: [imobAgencies.tenantId, imobAgencies.id],
    }),
  }),
);

export const imobAssignments = pgTable(
  "imob_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    brokerId: uuid("broker_id").notNull(),
    // offered → accepted | declined | expired | closed
    status: text("status").notNull().default("offered"),
    // funil pós-aceite (atualizado pelo corretor via WhatsApp)
    stage: text("stage"),
    attempt: integer("attempt").notNull().default(1),
    offeredAt: timestamp("offered_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    stageUpdatedAt: timestamp("stage_updated_at", { withTimezone: true }),
    // o que o próximo número do corretor responde: 'accept' | 'status'
    awaitingReply: text("awaiting_reply"),
    promptedAt: timestamp("prompted_at", { withTimezone: true }),
    followupCount: integer("followup_count").notNull().default(0),
    // 0040: modo vigente na OFERTA ('ficha' | 'workspace') — oferta e aceite
    // usam o mesmo modo mesmo se o admin trocar a config no meio
    offerMode: text("offer_mode").notNull().default("ficha"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTenantId: unique("imob_assignments_tenant_id_uniq").on(t.tenantId, t.id),
    brokerIdx: index("imob_assignments_broker_idx").on(t.tenantId, t.brokerId, t.offeredAt),
    slaIdx: index("imob_assignments_sla_idx").on(t.status, t.expiresAt),
    // uma atribuição ATIVA por lead (a redistribuição fecha a anterior)
    oneActivePerConv: uniqueIndex("imob_assignments_one_active_per_conv")
      .on(t.tenantId, t.conversationId)
      .where(sql`status IN ('offered', 'accepted')`),
    // 0038: uma oferta aguardando ACEITE por corretor (evita "1" ambíguo)
    onePendingAcceptPerBroker: uniqueIndex("imob_assignments_one_pending_accept_per_broker")
      .on(t.tenantId, t.brokerId)
      .where(sql`status = 'offered' AND awaiting_reply = 'accept'`),
    conversationFk: foreignKey({
      name: "imob_assignments_conversation_same_tenant_fk",
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }),
    brokerFk: foreignKey({
      name: "imob_assignments_broker_same_tenant_fk",
      columns: [t.tenantId, t.brokerId],
      foreignColumns: [imobBrokers.tenantId, imobBrokers.id],
    }),
  }),
);

export const imobEvents = pgTable(
  "imob_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    assignmentId: uuid("assignment_id"),
    brokerId: uuid("broker_id"),
    // qualified | offered | accepted | declined | expired | stage_changed |
    // followup_sent | note | alert | exhausted
    type: text("type").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: now(),
  },
  (t) => ({
    uniqTenantId: unique("imob_events_tenant_id_uniq").on(t.tenantId, t.id),
    convIdx: index("imob_events_conv_idx").on(t.tenantId, t.conversationId, t.createdAt),
    typeIdx: index("imob_events_type_idx").on(t.tenantId, t.type, t.createdAt),
    conversationFk: foreignKey({
      name: "imob_events_conversation_same_tenant_fk",
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }),
    assignmentFk: foreignKey({
      name: "imob_events_assignment_same_tenant_fk",
      columns: [t.tenantId, t.assignmentId],
      foreignColumns: [imobAssignments.tenantId, imobAssignments.id],
    }),
    brokerFk: foreignKey({
      name: "imob_events_broker_same_tenant_fk",
      columns: [t.tenantId, t.brokerId],
      foreignColumns: [imobBrokers.tenantId, imobBrokers.id],
    }),
  }),
);

// 0040 — settings da vertical imobiliária (modo de atendimento do corretor)
export const imobSettings = pgTable("imob_settings", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // 'ficha' (corretor atende no WhatsApp pessoal) | 'workspace' (pela plataforma)
  brokerMode: text("broker_mode").notNull().default("ficha"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 0041 — plano e efeitos persistidos do turno reativo; lease com fencing.
export const agentTurns = pgTable(
  "agent_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    conversationKey: text("conversation_key").notNull(),
    plan: jsonb("plan"),
    status: text("status").notNull().default("planning"),
    replyStatus: text("reply_status").notNull().default("pending"),
    completedEffects: jsonb("completed_effects").notNull().default(sql`'[]'::jsonb`),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqEvent: unique("agent_turns_event_uniq").on(t.tenantId, t.conversationId, t.externalMessageId),
    recoverableIdx: index("agent_turns_recoverable_idx")
      .on(t.tenantId, t.conversationId, t.createdAt, t.id)
      .where(sql`status = 'ready'`),
    conversationFk: foreignKey({
      name: "agent_turns_conversation_same_tenant_fk",
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete("cascade"),
  }),
);

/** Tabelas tenant-scoped: TODAS precisam de RLS forçado + policy (ver migrations). */
export const TENANT_SCOPED_TABLES = [
  "memberships",
  "tenant_secrets",
  "usage_events",
  "processed_messages",
  "audit_log",
  "channel_connections",
  "contacts",
  "conversations",
  "messages",
  "media_objects",
  // M5
  "knowledge_sources",
  "knowledge_chunks",
  // M6
  "lead_profiles",
  "agent_response_claims",
  "agent_turns",
  "agent_configs",
  // M7
  "crm_contacts",
  "opportunities",
  "activities",
  "appointments",
  "notifications",
  "crm_external_sync",
  // M8
  "outbox_messages",
  "cadence_state",
  "message_templates",
  // M9 (tenant-scoped; niche_knowledge/curation_candidates têm RLS PRÓPRIA por nicho/curadoria)
  "tenant_niche",
  // M13 — canal não-oficial (Baileys)
  "baileys_sessions",
  // M14 — onboarding (wizard)
  "tenant_onboarding",
  // 0031 — sessões de refresh (revogação/rotação, ADR 0006)
  "auth_sessions",
  // 0032 — quarentena de inbound (conexão não-ativa)
  "inbound_quarantine",
  // 0034 — agenda da plataforma
  "calendars",
  "calendar_events",
  // 0037 — vertical imobiliária (fork sdr-ia-imob)
  "imob_agencies",
  "imob_brokers",
  "imob_assignments",
  "imob_events",
  // 0040 — settings da vertical (modo do corretor)
  "imob_settings",
] as const;
