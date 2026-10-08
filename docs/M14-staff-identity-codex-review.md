# Revisão Codex — Identidade por-staff na Área da Plataforma (M14, dívida)

Revisão de arquitetura (Codex, `--sandbox read-only`) da mudança de identidade
por-staff (token pessoal + papel + auditoria). **Nenhum achado CRÍTICO.** Todos os
achados ALTO/MÉDIO/BAIXO foram tratados.

## ALTO — corrigidos

1. **Auditoria de plataforma bloqueada pela RLS.** `insertAuditLog()` insere
   `tenant_id = NULL`, mas `audit_log` é FORCE RLS com a policy `tenant_isolation`
   (`WITH CHECK tenant_id = app.tenant_id`) — a role `app` (NOBYPASSRLS) teria o
   INSERT **rejeitado**, e a ação sensível já teria sido aplicada. Os testes não
   pegaram porque exercitavam o *service*, não o controller.
   → **Fix:** migration `0026` adiciona a policy permissiva `platform_audit` (linhas
   SEM tenant sob a flag `app.platform_audit`); `insertAuditLog` roda numa transação
   que seta a flag (transaction-local) para eventos de plataforma. Novo teste
   `audit.test.ts` prova o INSERT pela role `app` **e** o isolamento sem a flag.

2. **Auditoria fora da transação da mutação.** A ação (approve/promote/kit.apply)
   commita antes do `insertAuditLog`; se a trilha falhasse, a API retornaria erro
   sobre uma ação já aplicada.
   → **Fix:** com a RLS corrigida, falha de audit vira rara (só indisponibilidade de
   banco). Adotamos auditoria **best-effort pós-commit**: falha loga `warn` e NÃO
   mascara a ação bem-sucedida (`auditBestEffort` na curadoria; try/catch no kit).
   Trade-off documentado (ADR 0044): trilha append-only best-effort, não atômica.

## MÉDIO — corrigido

3. **`@RequireStaffRole("curator")` no controller inteiro** deixava `curator` criar
   nicho e atribuir nicho a tenant (gestão estrutural, não curadoria).
   → **Fix:** roles por-handler — `createNiche` e `assign` exigem `admin`; ações de
   curadoria (approve/reject/promote/createCandidate/mine) seguem `curator`
   (metadata do handler sobrescreve o default do controller).

## BAIXO — corrigidos

4. **`setStaffTokenHash` aceitava qualquer texto.** → valida sha256 hex de 64 chars
   em runtime **e** `CHECK (token_hash ~ '^[0-9a-f]{64}$')` na migration 0026.

5. **`normalizeRole` rebaixava papel desconhecido para `support`** (mascarava
   corrupção). → agora **nega** a identidade quando o papel não é `admin|curator|
   support` (fail-closed) e loga erro operacional.

## Confirmado limpo pelo Codex

- Sem injeção SQL (usos de `sql\`…${v}\`` parametrizados).
- Sem vazamento de token/hash em `/platform/me` nem `/platform/staff` (os SELECT não
  retornam `token_hash`).

## Estado

326 testes verdes (db 67, api 141). Typecheck + web build OK.
