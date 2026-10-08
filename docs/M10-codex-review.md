# M10 — Revisão do Codex (verticais/kits) + triagem

Revisor: OpenAI Codex (`gpt-5.5`, read-only). **Sem achados CRÍTICOS** (2 altos, 4
médios). Confirmou: kits genéricos/sem PII; `platform_authored` não aposenta
`curation`; metering do kit em `platform_usage`; `materializeTemplatesForTenant` no
contexto do tenant com `status=pending`; FK `ON DELETE CASCADE`; `niche_configs`
fora de `TENANT_SCOPED_TABLES` (coerente).

## Aplicado

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 1 | ALTO | A policy combinada de `niche_knowledge`/`niche_configs` permitia **DELETE/UPDATE** só com `app.niche_id` (sem `app.curation`) — um tenant poderia apagar/alterar conhecimento do próprio nicho. (Buraco também no M9.) | migration 0017: policies SEPARADAS — `FOR SELECT` por `app.niche_id`; `FOR ALL` (insert/update/delete) exige `app.curation='on'` |
| 3 | MÉDIO | Versionamento só comparava igualdade → versão menor/ inválida reaplicava e aposentava a mais nova | `compareSemver`: aplica só se `kit.version > current` (semver); igual = no-op; downgrade/ inválido = recusa |
| 4 | MÉDIO | Guard de PII só no `knowledge[].content` | `validateKit`: valida estrutura + varre **todos** os textos (guidance, compliance.notes, knowledge, templates) por PII ANTES de qualquer write/embedding |
| 5 | MÉDIO | `insertNicheKnowledge(sourceKind: string)` exportado permitia inserir `'curation'` sem `promoteCandidate` | tipo restrito a `'platform_authored' \| 'manual'` (nunca `'curation'` pela porta pública) |
| 6 | MÉDIO | `validQualification` fraca (tipo fora do enum, pesos negativos, required não-bool) | predicate estrito: `type ∈ {string,number,boolean}`, `qualifyAtScore` finito ≥0, pesos finitos ≥0, `key` string, `required`/eliminatórios coerentes |

## Documentado (dívida consciente)
- **#2 (ALTO) — atomicidade de `apply()`**: check de versão + retire + inserts +
  config rodam em transações separadas; aplicação concorrente da MESMA versão
  poderia duplicar. Mitigado por #3 (semver: igual = no-op) e pelo fato de ser
  ação de **staff de plataforma** (concorrência ~nula). Lock por nicho
  (`pg_advisory_xact_lock`) numa única transação de curadoria fica como hardening
  (o embedding por item é network, então a transação única exige pré-embedar tudo
  antes do bloco transacional) — registrado.
