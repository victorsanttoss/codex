# M9 — Revisão do Codex (camada de nicho + curadoria) + triagem

Revisor: OpenAI Codex (`gpt-5.5`, read-only). **3 achados CRÍTICOS** — coerente com
os três inegociáveis (zero PII, curadoria humana, isolamento por nicho).

Confirmou: leitura de `niche_knowledge` resolve o nicho server-side (`tenant_niche`)
e usa `withNiche` (tenant não forja `app.niche_id`); `curation_candidates` invisíveis
no caminho do tenant; `source_tenant_id`/`source_refs` não entram no nicho nem no
consumo; metering de curadoria em `platform_usage` (não no tenant); composição do
retriever + `nicheLayer` coerentes; dim 1024 consistente.

## Aplicado

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 1 | **CRÍTICO** | `curation_candidates` isolava só por `app.curation`, não por nicho → uma sessão de curadoria podia ler candidatos de qualquer nicho | migration 0015: policy agora exige TAMBÉM `niche_id = app.niche_id` (USING+WITH CHECK) |
| 2 | **CRÍTICO** | `/mine/:tenantId` para `:nicheId` não validava que o tenant pertence ao nicho → contaminação cruzada | `mineTenant` resolve o nicho do tenant server-side e **exige `tenantNiche === nicheId`** (lança senão) |
| 5 | **ALTO→trata como crítico** | escrita crua `insertNicheKnowledge` permitia bypass futuro do gate humano | `promoteCandidate(nicheId, candidateId, embedding)` ATÔMICO no db: re-checa `approved` na transação, insere e marca `promoted` num só passo; `CurationService.promote` usa isto |
| 3·4·8 | **CRÍTICO/ALTO** | anonimização só por regex; mineração mandava transcript CRU ao LLM; verificador usava a mesma regex | (a) **pré-redação do transcript ANTES do LLM** (mineração); (b) regex reforçada (URL, @handle, dígitos longos); (c) **verificação por LLM** opcional fail-closed quando há chave de plataforma; (d) ADR honesto: o **curador humano é o gate final** — a camada automática é best-effort |
| 7 | MÉDIO | guard de plataforma não era 100% tempo-constante (vazava tamanho) | sha256 dos dois lados + `crypto.timingSafeEqual` |
| 9 | BAIXO | `setCandidateStatus` não validava linha afetada | lança se nenhuma linha for atualizada |

## Documentado (dívida consciente)
- **#6 (ALTO) — identidade do curador**: hoje `curatorId` vem do body (a rota é
  autenticada por token de plataforma, mas não há auth por-curador). Auditoria
  imutável + identidade forte de staff ficam para a operação/painel (M-ops). O gate
  humano em si (só `approved` promove) está garantido.
- **#3 (residual)** PII perfeita (nomes/empresas/endereços) não é solucionável só em
  código — por isso o **curador humano é o gate final** (ADR 0031, reforçado). A
  verificação por LLM mitiga, não elimina.
