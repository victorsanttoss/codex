-- Fundação multi-tenant (M1). Roda como a role `migrator` (dona das tabelas).
-- pgvector e as roles já foram criadas pelo init do container.

-- ── Tipos enumerados ─────────────────────────────────────────
CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'agent');
CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'deleted');
CREATE TYPE tenant_secret_kind AS ENUM ('whatsapp_token', 'crm_api_key');

-- ── Tabelas de identidade (NÃO tenant-scoped) ────────────────
-- Acessadas pelo caminho de auth/system (resolução de login e memberships
-- acontece ANTES de haver um tenant ativo no contexto).
CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  status     tenant_status NOT NULL DEFAULT 'active',
  plan       text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Tabelas tenant-scoped ────────────────────────────────────
CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       membership_role NOT NULL DEFAULT 'agent',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_user_tenant_uniq UNIQUE (user_id, tenant_id)
);
CREATE INDEX memberships_tenant_idx ON memberships (tenant_id);

CREATE TABLE tenant_secrets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        tenant_secret_kind NOT NULL,
  ciphertext  text NOT NULL,
  nonce       text NOT NULL,
  key_version bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_secrets_tenant_kind_uniq UNIQUE (tenant_id, kind)
);

CREATE TABLE usage_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type        text NOT NULL,
  model       text,
  channel     text,
  tokens_in   bigint,
  tokens_out  bigint,
  cost_micros bigint,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX usage_events_tenant_time_idx ON usage_events (tenant_id, occurred_at);

CREATE TABLE processed_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider            text NOT NULL,
  external_message_id text NOT NULL,
  conversation_key    text NOT NULL,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  -- dedup POR TENANT (IDs externos podem colidir entre tenants em vias não-oficiais).
  CONSTRAINT processed_messages_tenant_provider_msg_uniq
    UNIQUE (tenant_id, provider, external_message_id)
);
CREATE INDEX processed_messages_conversation_idx ON processed_messages (conversation_key);

CREATE TABLE audit_log (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  actor     text NOT NULL,
  action    text NOT NULL,
  target    text,
  metadata  jsonb NOT NULL DEFAULT '{}'::jsonb,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_time_idx ON audit_log (tenant_id, at);

-- ── Row-Level Security (deny-by-default + FORCE) ─────────────
-- FORCE garante que NEM o owner (migrator) burla a policy (achado ALTO do Codex).
-- A policy usa current_setting('app.tenant_id', true): sem contexto => NULL =>
-- nenhuma linha visível. WITH CHECK impede inserir/atualizar para outro tenant.
--
-- Tabelas de NEGÓCIO: isolamento puro por tenant_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_secrets', 'usage_events', 'processed_messages', 'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- NULLIF(...,''): GUC customizado volta a string vazia (não NULL) após ser
    -- tocado na sessão; sem isso, ''::uuid erraria em vez de negar (deny-by-default).
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    $f$, t);
  END LOOP;
END $$;

-- memberships é tenant-scoped, mas precisa ser legível pelo PRÓPRIO usuário
-- durante o login (antes de existir tenant ativo). Sem abrir caminho
-- privilegiado: a policy aceita ver por tenant_id OU pelo próprio user_id.
-- Tudo permanece no app_user (sem BYPASSRLS). FORCE continua valendo.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
