-- WORKSPACE DO CORRETOR (opção por tenant): o empreendimento escolhe entre
-- 'ficha' (padrão — corretor recebe o telefone e atende no WhatsApp pessoal)
-- e 'workspace' (corretor atende PELA plataforma via link pessoal; conversa
-- 100% visível em tempo real). Tabela de settings da vertical é extensível
-- (futuro: SLA por tenant).
CREATE TABLE imob_settings (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  broker_mode text NOT NULL DEFAULT 'ficha'
    CONSTRAINT imob_settings_broker_mode_check CHECK (broker_mode IN ('ficha', 'workspace')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE imob_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE imob_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON imob_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Revogação do link do workspace: bump da versão invalida todos os tokens
-- emitidos antes (o guard compara a versão embutida no token).
ALTER TABLE imob_brokers ADD COLUMN access_token_version integer NOT NULL DEFAULT 1;

-- Modo vigente NO MOMENTO DA OFERTA (achado Codex): oferta e aceite usam o
-- MESMO modo mesmo se o admin trocar a config no meio — e o workspace só
-- enxerga atendimentos ofertados como 'workspace' (ofertas 'ficha' seguem o
-- fluxo antigo até o fim, sem mudar de canal no meio do atendimento).
ALTER TABLE imob_assignments ADD COLUMN offer_mode text NOT NULL DEFAULT 'ficha'
  CONSTRAINT imob_assignments_offer_mode_check CHECK (offer_mode IN ('ficha', 'workspace'));
