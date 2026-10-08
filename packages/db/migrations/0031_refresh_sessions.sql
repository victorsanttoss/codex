-- Revogação de refresh token (fecha a dívida do ADR 0006). Antes o refresh era
-- um JWT stateless de 30d: logout e troca de senha não revogavam nada. Agora
-- cada refresh emitido tem uma SESSÃO server-side: o JWT carrega um `jti` de
-- alta entropia e a tabela guarda só o sha256 dele (vazamento do banco não
-- permite montar um refresh válido). No refresh o token é ROTACIONADO (revoga a
-- sessão antiga, emite nova); reuso de token já rotacionado revoga TODAS as
-- sessões do usuário (detecção de roubo, padrão OWASP). Logout revoga a sessão
-- apresentada. Access token segue stateless (expiração curta, ~15min).
CREATE TABLE auth_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL, -- sha256 hex do jti do refresh JWT (nunca o token)
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  -- jti é único por emissão (sessões não compartilham token).
  CONSTRAINT auth_sessions_token_hash_uniq UNIQUE (token_hash),
  -- mesmo formato do platform_staff.token_hash (0026): sha256 hex de 64 chars.
  CONSTRAINT auth_sessions_token_hash_fmt CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
-- Lookups são por usuário (refresh/logout/revogação global + sweep no login).
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

-- RLS no padrão de memberships (0001): a sessão precisa ser acessível pelo
-- PRÓPRIO usuário (app.user_id) — refresh/logout acontecem ANTES de haver
-- tenant ativo no contexto, e a revogação global (reuso detectado / troca de
-- senha) cruza os tenants do usuário. A perna user_id também no WITH CHECK
-- permite o UPDATE de revoked_at pelo caminho withUser; um contexto de usuário
-- só toca as PRÓPRIAS sessões (deny-by-default para o resto).
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth_sessions
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
