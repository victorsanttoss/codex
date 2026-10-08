-- M14 (dívida): IDENTIDADE POR-STAFF na área da plataforma. Antes o acesso era um
-- token ÚNICO compartilhado (PLATFORM_ADMIN_TOKEN) e a atribuição de curadoria era
-- texto livre (curatorId='staff'). Agora cada membro do platform_staff tem seu
-- PRÓPRIO token (guardamos só o hash sha256). O guard resolve o token -> a linha do
-- staff -> identidade {id,email,role}; papel é enforçado por endpoint; ações de
-- curadoria gravam o staffId real + audit_log. Resolve também a dívida do motor
-- (identidade forte do curador + auditoria).
ALTER TABLE platform_staff ADD COLUMN token_hash text;

-- Único quando presente (dois staff não compartilham token); NULL = sem token
-- (não autentica). Hash é sha256 hex de um token de alta entropia.
CREATE UNIQUE INDEX platform_staff_token_hash_uniq
  ON platform_staff (token_hash) WHERE token_hash IS NOT NULL;
