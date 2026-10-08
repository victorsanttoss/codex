# ADR 0001 — Isolamento multi-tenant via RLS (FORCE)

## Contexto
Clientes podem ser concorrentes no mesmo nicho. Vazamento de dados entre tenants
é falha crítica (LGPD). Confiar só em `WHERE tenant_id` na aplicação é frágil.

## Decisão
- **Row-Level Security** em todas as tabelas tenant-scoped, com **`FORCE ROW LEVEL
  SECURITY`** (nem o owner/`migrator` burla a policy).
- Policy: `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`.
  O `NULLIF` é essencial: GUC customizado volta a **string vazia** (não `NULL`)
  após ser tocado na sessão; sem ele, `''::uuid` erraria em conexões do pool em
  vez de **negar** (deny-by-default).
- Duas roles: **`app_user`** (runtime, **`NOBYPASSRLS`**) e **`migrator`** (DDL).
- `WITH CHECK` impede inserir/atualizar para outro tenant.
- A app abre transação e faz `SET LOCAL app.tenant_id` (via `set_config(..,true)`)
  antes de qualquer query — único caminho para tabelas tenant-scoped (`withTenant`).
- `memberships` aceita ler por `tenant_id` **ou** `user_id` próprio, para o login
  funcionar antes de haver tenant ativo, sem abrir caminho privilegiado.
- Um **teste de catálogo** falha se alguma tabela tenant-scoped não tiver
  RLS+FORCE+policy.

## Consequências
Isolamento garantido pelo banco, não pela disciplina da aplicação. Operações
cross-tenant ("system") são explícitas e raras. Custo: toda query tenant-scoped
roda dentro de transação com o GUC setado.
