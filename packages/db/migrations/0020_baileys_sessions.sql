-- M13: sessão cifrada do Baileys por número (canal não-oficial). Permite
-- reconectar sem re-escanear o QR após restart. O blob (creds + signal keys) é
-- cifrado fora do banco (envelope encryption, AAD tenantId:baileys_session:phone).
-- Tenant-scoped: RLS forçada + policy por app.tenant_id (padrão NULLIF).
CREATE TABLE baileys_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number_id text NOT NULL,
  ciphertext      text NOT NULL,
  nonce           text NOT NULL,
  key_version     integer NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT baileys_sessions_tenant_phone_uniq UNIQUE (tenant_id, phone_number_id)
);

ALTER TABLE baileys_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE baileys_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON baileys_sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
