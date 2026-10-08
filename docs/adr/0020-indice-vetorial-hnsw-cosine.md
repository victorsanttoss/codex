# ADR 0020 — Índice vetorial (HNSW + cosseno)

## Contexto
A recuperação faz KNN sobre `knowledge_chunks.embedding` (`vector(1024)`).
pgvector oferece `ivfflat` e `hnsw`, com operadores L2 / inner product / cosseno.

## Decisão
- **Índice `hnsw`** com `vector_cosine_ops` (operador `<=>`). HNSW não exige
  treino/`lists` (ao contrário do ivfflat) e dá boa recall/latência mesmo com a
  tabela ainda pequena/crescendo — adequado a tenants de tamanhos variados.
- **Cosseno** porque os embeddings são normalizados (ADR 0019); `score = 1 -
  distância` (1 = idêntico). `minScore` filtra similaridade mínima.
- Criado na **migration** (`CREATE INDEX ... USING hnsw`), não no Drizzle (pg-core
  não expressa índice vetorial). Roda dentro da transação da migration (não usa
  `CONCURRENTLY`).
- A busca roda **sob `withTenant`** (RLS): o índice acelera, mas o isolamento é
  garantido pela policy, não pelo `WHERE`.

## Consequências
KNN rápido sem etapa de treino. Parâmetros do HNSW (`m`, `ef_construction`,
`ef_search`) ficam no default do pgvector por ora — afináveis depois por volume.
Se algum tenant crescer muito, avaliar partição/`ef_search` ou ivfflat dedicado.
Busca híbrida (vetor + keyword) é melhoria futura (fora do M5).
