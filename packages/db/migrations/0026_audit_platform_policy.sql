-- Revisão Codex (ALTO): auditoria de PLATAFORMA (tenant_id NULL) era BLOQUEADA.
-- A policy `tenant_isolation` (0001) exige `tenant_id = app.tenant_id` no WITH
-- CHECK, então um INSERT de evento de plataforma (sem tenant) pela role `app`
-- (NOBYPASSRLS) falharia — e a ação sensível já teria sido aplicada. Policies do
-- Postgres são permissivas (OR): adiciona uma policy que libera SÓ linhas SEM
-- tenant sob a flag `app.platform_audit='on'` (setada apenas no caminho system,
-- via insertAuditLog). Tenant nenhum seta essa flag → segue isolado.
CREATE POLICY platform_audit ON audit_log
  USING (tenant_id IS NULL AND current_setting('app.platform_audit', true) = 'on')
  WITH CHECK (tenant_id IS NULL AND current_setting('app.platform_audit', true) = 'on');

-- Revisão Codex (BAIXO): token_hash deve ser sha256 hex de 64 chars (ou NULL).
ALTER TABLE platform_staff
  ADD CONSTRAINT platform_staff_token_hash_fmt
  CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$');
