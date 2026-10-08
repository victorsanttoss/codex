# ADR 0030 — RLS por NICHO (isolamento de conhecimento compartilhado)

## Contexto
A camada de nicho é **compartilhada** entre tenants do mesmo nicho — que podem ser
**concorrentes**. Não pode usar a RLS por tenant (cada tenant veria só o seu). E os
candidatos de curadoria (dados crus, com origem) **não podem** ser legíveis por
nenhum tenant.

## Decisão
- Storage de nicho é de **PLATAFORMA** (não tenant-scoped). Novo eixo de
  isolamento: `app.niche_id` (GUC), além do `app.tenant_id`.
- **`niche_knowledge`** (RLS FORCE): `USING (niche_id = NULLIF(current_setting(
  'app.niche_id', true),'')::uuid)` → tenant lê só o conhecimento do PRÓPRIO nicho.
  **`WITH CHECK` exige também `app.curation='on'`** → tenant **lê mas NÃO escreve**;
  escrita só pelo caminho de curadoria.
- **`curation_candidates`** (RLS FORCE): `USING/WITH CHECK (app.curation='on')` →
  **invisíveis a tenants** (o caminho do tenant nunca seta `app.curation`).
- **Resolução server-side**: o nicho do tenant vem de `tenant_niche` (tenant-scoped),
  lido sob `withTenant` — o tenant **não escolhe/forja** o nicho. Helpers:
  `withNiche(nicheId)` (leitura) e `withCuration(nicheId)` (curadoria: `app.curation`
  + `app.niche_id`).

## Consequências
Tenants de um nicho compartilham conhecimento sem se ver; ninguém escreve no nicho
fora da curadoria; candidatos crus ficam restritos à plataforma. O isolamento é
provado por testes próprios (nicho A × B; candidatos invisíveis ao tenant; tenant
não escreve `niche_knowledge`). `niches` é dado de referência (sem RLS de tenant).
