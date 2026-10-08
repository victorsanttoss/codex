-- M14: estado do ONBOARDING (wizard de 8 etapas) por tenant. Autosave por etapa:
-- guarda o passo atual + o payload acumulado (jsonb) + quando a SDR foi ativada.
-- Tenant-scoped: RLS forçada + policy por app.tenant_id (padrão NULLIF).
CREATE TABLE tenant_onboarding (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  step         integer NOT NULL DEFAULT 1,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  activated_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_onboarding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_onboarding
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
