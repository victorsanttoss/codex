-- M2: canal WhatsApp — conexões, contatos, conversas, mensagens, mídia.
-- Roda como `migrator`. Todas tenant-scoped com RLS ENABLE+FORCE+policy.

CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE message_status AS ENUM (
  'received', 'queued', 'sent', 'delivered', 'read', 'failed'
);

-- Mapeia phone_number_id -> tenant. phone_number_id é GLOBALMENTE único.
CREATE TABLE channel_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'cloud_api',
  phone_number_id text NOT NULL,
  waba_id         text,
  display_phone   text,
  status          text NOT NULL DEFAULT 'active',
  secret_ref      tenant_secret_kind NOT NULL DEFAULT 'whatsapp_token',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_connections_phone_number_id_uniq UNIQUE (phone_number_id)
);
CREATE INDEX channel_connections_tenant_idx ON channel_connections (tenant_id);

CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wa_id         text NOT NULL,
  phone         text,
  profile_name  text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contacts_tenant_wa_id_uniq UNIQUE (tenant_id, wa_id)
);

CREATE TABLE conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel           text NOT NULL DEFAULT 'whatsapp',
  conversation_key  text NOT NULL,
  status            text NOT NULL DEFAULT 'open',
  last_inbound_at   timestamptz,
  last_outbound_at  timestamptz,
  window_expires_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_tenant_key_uniq UNIQUE (tenant_id, conversation_key)
);

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction           message_direction NOT NULL,
  type                text NOT NULL,
  content             jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_message_id text,
  status              message_status NOT NULL,
  error               jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  status_updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_tenant_external_uniq UNIQUE (tenant_id, external_message_id)
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

CREATE TABLE media_objects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id        uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider_media_id text NOT NULL,
  mime_type         text,
  storage_ref       text,
  sha256            text,
  size              bigint,
  downloaded_at     timestamptz
);
CREATE INDEX media_objects_message_idx ON media_objects (message_id);

-- ── RLS ──────────────────────────────────────────────────────
-- Tabelas de negócio: isolamento puro por tenant_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts', 'conversations', 'messages', 'media_objects']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    $f$, t);
  END LOOP;
END $$;

-- channel_connections: acesso normal por tenant_id OU lookup por phone_number_id
-- no caminho system (set_config app.resolve_phone), sem expor a tabela inteira.
ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_connections
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR phone_number_id = NULLIF(current_setting('app.resolve_phone', true), '')
  )
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
