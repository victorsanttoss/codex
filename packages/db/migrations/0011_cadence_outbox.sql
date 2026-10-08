-- M8: cadência / follow-up proativo + outbox de entrega. Tudo tenant-scoped,
-- RLS ENABLE+FORCE+policy NULLIF + catálogo. FK composta (tenant_id, conversation_id)
-- impede referência cross-tenant (padrão 0007/0010).

-- opt-out (LGPD) no contato
ALTER TABLE contacts ADD COLUMN opted_out boolean NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN opted_out_at timestamptz;

CREATE TABLE outbox_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id     uuid,
  to_phone            text NOT NULL,
  kind                text NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key     text NOT NULL,
  client_message_id   text NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  external_message_id text,
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 5,
  billing             text NOT NULL DEFAULT 'service',
  scheduled_for       timestamptz NOT NULL DEFAULT now(),
  next_attempt_at     timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_messages_tenant_key_uniq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT outbox_messages_conversation_same_tenant_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE SET NULL
);
CREATE INDEX outbox_messages_status_sched_idx ON outbox_messages (status, scheduled_for);
CREATE INDEX outbox_messages_external_idx ON outbox_messages (external_message_id);

CREATE TABLE cadence_state (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  current_step    integer NOT NULL DEFAULT 0,
  next_step_at    timestamptz,
  status          text NOT NULL DEFAULT 'active',
  stop_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cadence_state_tenant_conversation_uniq UNIQUE (tenant_id, conversation_id),
  CONSTRAINT cadence_state_conversation_same_tenant_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX cadence_state_status_next_idx ON cadence_state (status, next_step_at);

CREATE TABLE message_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  language_code text NOT NULL DEFAULT 'pt_BR',
  category      text NOT NULL DEFAULT 'marketing',
  variables     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'approved',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_templates_tenant_name_lang_uniq UNIQUE (tenant_id, name, language_code)
);

-- ── RLS ──────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbox_messages', 'cadence_state', 'message_templates']
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
