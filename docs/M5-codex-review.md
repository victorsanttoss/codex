# M5 — Revisão do Codex (Conhecimento/RAG) + triagem

Revisor: OpenAI Codex (`gpt-5.5`, read-only) sobre a port `EmbeddingProvider`, o
adaptador `embeddings-openai-compat`, o catálogo de preços de embeddings, o schema
+ migrations + repos de conhecimento, e o módulo `knowledge` da api. Sem achados
CRÍTICOS.

Confirmou: a busca KNN roda sob `withTenant`/`SET LOCAL app.tenant_id`, as duas
tabelas têm `ENABLE`+`FORCE` RLS + policy `NULLIF` — **sem caminho nominal p/
tenant A ler chunk de B**. Resolução de chave `embedding_api_key → llm_api_key →
plataforma` correta; self-hosted sem chave suportado; AAD `tenantId:kind`; nenhuma
chave logada; `recordUsage` no tenant ativo; literal de vetor é parametrizado (sem
injeção SQL).

## Aplicado

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 1 | ALTO | Race entre dois ingests da mesma `externalRef`: job antigo podia marcar `ready` com chunks de conteúdo velho | `replaceSourceChunks(sourceId, chunks, expectedContentHash)` re-checa o `content_hash` na transação e **aborta** se mudou — chunks sempre correspondem ao hash persistido |
| 2 | ALTO | `cfg.embeddings.dim` divergente de `KNOWLEDGE_VECTOR_DIM`/`vector(1024)` só falhava depois (após pagar embedding) | `EmbeddingService` **falha na construção** (DI) se `cfg.embeddings.dim !== KNOWLEDGE_VECTOR_DIM` |
| 3 | MÉDIO | `SearchDto.topK/minScore/query` sem validação de faixa (`NaN`, topK gigante, query sem limite) | `@IsInt @Min(1) @Max(50)` topK, `@IsNumber @Min(-1) @Max(1)` minScore, `@MaxLength` query; controller usa os valores já validados |
| 4 | MÉDIO | `assertVectorDim` só checava tamanho — `NaN`/`Infinity` passariam | passa a exigir `Number.isFinite` em todo elemento (fail-closed) |
| 5 | MÉDIO | Parser de batch reordenava por `index` mas aceitava índices duplicados/faltando | exige conjunto exato `{0..n-1}` quando há `index`; senão aceita só se todos vierem sem `index` (ordem original) |
| 6 | MÉDIO | Sem FK composta `(tenant_id, source_id)` — bug com `sourceId` poderia cruzar tenant | migration 0007: `UNIQUE (tenant_id, id)` em sources + FK `(tenant_id, source_id)` em chunks |
| 7 | BAIXO | Conteúdo só-espaços marcava fonte `ready` com zero chunks | controller rejeita `normalizeContent(content)` vazio (400) |
| 8 | BAIXO | Teste de agnosticismo não bloqueava `@sdr/embeddings-*` | regex ampliada p/ `@sdr/embeddings-` (import + dep no package.json) |

Extra (sugestão do Codex): `recordUsage` de embeddings agora marca
`metadata.purpose = 'ingest' | 'retrieval'` p/ análise de custo.

## Sem ação (confirmado)
Isolamento por RLS, resolução/sigilo de chave, parametrização do vetor (sem
injeção), idempotência por `content_hash`, fail-closed de preço e de dimensão no
banco (coluna `vector(1024)`) — todos OK.
