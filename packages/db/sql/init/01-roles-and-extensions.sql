-- Executado UMA vez pelo entrypoint do Postgres (psql -f, como superuser) na
-- criação do volume. Arquivo .sql (não .sh) de propósito: roda via psql sem
-- exigir bit de execução — evita o atrito de bind-mount noexec no Docker
-- Desktop/macOS, e funciona igual em Linux/CI.
--
-- Cria as duas roles do princípio de isolamento:
--   - migrator: dono do schema, roda DDL/migrations (sem BYPASSRLS)
--   - app_user: runtime da aplicação, SEM BYPASSRLS (sujeito a RLS sempre)
-- e habilita a extensão pgvector (sem criar tabelas de embedding ainda).
--
-- Senhas/usuários vêm do ambiente do container (compose `environment:`).

\set ON_ERROR_STOP on
\getenv appuser  APP_DB_USER
\getenv apppw    APP_DB_PASSWORD
\getenv miguser  MIGRATOR_DB_USER
\getenv migpw    MIGRATOR_DB_PASSWORD

-- Extensão para embeddings (Módulo 5). Apenas a extensão; nenhuma tabela.
CREATE EXTENSION IF NOT EXISTS vector;

-- Exclusion constraint anti double-booking da agenda (M15, migration 0035).
-- Extensão exige CREATE no database — o migrator não tem; em volume JÁ criado,
-- rodar uma vez como superuser: CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Roles (volume novo => não pré-existem). :"x" cita identificador; :'x' cita literal.
CREATE ROLE :"miguser" LOGIN PASSWORD :'migpw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE :"appuser" LOGIN PASSWORD :'apppw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- O schema pertence ao migrator; ele cria as tabelas.
ALTER SCHEMA public OWNER TO :"miguser";
GRANT USAGE ON SCHEMA public TO :"appuser";

-- Toda tabela/seq que o migrator criar concede DML automático ao app_user.
ALTER DEFAULT PRIVILEGES FOR ROLE :"miguser" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"appuser";
ALTER DEFAULT PRIVILEGES FOR ROLE :"miguser" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"appuser";
