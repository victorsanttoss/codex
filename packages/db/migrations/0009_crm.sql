-- M7: CRM built-in + agendamento + notificação + mapa de sync. Tudo tenant-scoped,
-- RLS ENABLE+FORCE+policy NULLIF + catálogo. FK composta (tenant_id, contact_id)
-- impede referência cross-tenant (defesa além do RLS — padrão da migration 0007).

CREATE TABLE crm_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  name        text,
  fields      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_contacts_tenant_phone_uniq UNIQUE (tenant_id, phone),
  CONSTRAINT crm_contacts_tenant_id_uniq UNIQUE (tenant_id, id)
);

CREATE TABLE opportunities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  title           text NOT NULL,
  stage           text NOT NULL DEFAULT 'qualified',
  status          text NOT NULL DEFAULT 'open',
  score           integer,
  value           integer,
  external_id     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunities_tenant_contact_uniq UNIQUE (tenant_id, contact_id),
  CONSTRAINT opportunities_contact_same_tenant_fk
    FOREIGN KEY (tenant_id, contact_id) REFERENCES crm_contacts (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL,
  kind        text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activities_contact_same_tenant_fk
    FOREIGN KEY (tenant_id, contact_id) REFERENCES crm_contacts (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE appointments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  when_text       text,
  starts_at       timestamptz,
  details         text NOT NULL,
  status          text NOT NULL DEFAULT 'requested',
  external_id     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_tenant_key_uniq UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  kind            text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL,
  read            boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_tenant_key_uniq UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE crm_external_sync (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id         uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  crm_adapter             text NOT NULL,
  contact_external_id     text,
  opportunity_external_id text,
  status                  text NOT NULL DEFAULT 'pending',
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_external_sync_tenant_conversation_uniq UNIQUE (tenant_id, conversation_id)
);

-- ── RLS ──────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_contacts', 'opportunities', 'activities', 'appointments', 'notifications', 'crm_external_sync']
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
