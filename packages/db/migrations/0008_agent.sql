-- M6: agente SDR — estado do lead/funil, idempotência de envio, config por tenant.
-- Tudo tenant-scoped: RLS ENABLE+FORCE+policy NULLIF + catálogo.

CREATE TABLE lead_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  stage           text NOT NULL DEFAULT 'discovery',
  status          text NOT NULL DEFAULT 'new',
  score           integer NOT NULL DEFAULT 0,
  fields          jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_profiles_tenant_conversation_uniq UNIQUE (tenant_id, conversation_id)
);

-- Idempotência de envio: chave reivindicada antes de chamar a Cloud API.
CREATE TABLE agent_response_claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  claim_key   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_response_claims_tenant_key_uniq UNIQUE (tenant_id, claim_key)
);

CREATE TABLE agent_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── RLS: isolamento puro por tenant_id (mesma policy NULLIF do resto) ──
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_profiles', 'agent_response_claims', 'agent_configs']
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
