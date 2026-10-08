-- Revisão (auditoria M8/M13): as varreduras periódicas eram N+1 — o outbox worker
-- iterava TODOS os tenants a cada 15s (mesmo sem trabalho) e o session-worker
-- abria 1 tx por tenant para listar conexões Baileys. Policy adicional SÓ de
-- SELECT liberando leitura cross-tenant sob a flag `app.system_scan='on'`,
-- setada exclusivamente nos helpers system do @sdr/db (listTenantsWithDueOutbox,
-- listActiveConnectionsByProvider) — mesmo padrão do `app.platform_audit` (0026).
-- Tenant nenhum seta essa flag → o isolamento normal segue intacto; escrita
-- continua exigindo a perna tenant_id (as policies são permissivas/OR só p/ SELECT).
CREATE POLICY system_scan ON outbox_messages FOR SELECT
  USING (current_setting('app.system_scan', true) = 'on');
CREATE POLICY system_scan ON channel_connections FOR SELECT
  USING (current_setting('app.system_scan', true) = 'on');
