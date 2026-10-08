-- Provisionamento self-service de empreendimentos (via Central): a listagem
-- de tenants da vertical imobiliária é uma consulta SYSTEM (staff de
-- plataforma), cruzando tenant_niche entre tenants — padrão 0029.
CREATE POLICY system_scan ON tenant_niche FOR SELECT
  USING (current_setting('app.system_scan', true) = 'on');
