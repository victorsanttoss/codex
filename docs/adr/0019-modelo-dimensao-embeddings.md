# ADR 0019 — Modelo e dimensão de embeddings (PT-BR)

## Contexto
A SDR opera em **português**. O RAG precisa de um modelo de embeddings com bom
desempenho multilíngue (PT-BR) e de uma **dimensão fixa** para a coluna
`vector(N)` e o índice. Trocar a dimensão depois exige recriar coluna/índice.

## Decisão
- **Modelo default: `bge-m3`** (multilíngue forte, inclui PT; roda self-hosted via
  vLLM/Ollama e também por provedores por token) — **dimensão N = 1024**.
- A dimensão é **fixada** em `KNOWLEDGE_VECTOR_DIM = 1024` (db) e na coluna
  `vector(1024)` (migration 0006). `cfg.embeddings.dim` (default 1024) DEVE casar.
- **Embeddings normalizados** (assume-se norma L2 = 1) → usamos distância de
  **cosseno**. O adaptador é OpenAI-compatible (`/embeddings`), então o operador
  troca de modelo/provedor sem tocar o núcleo.
- **Fail-closed de dimensão**: vetor de tamanho ≠ N é rejeitado no repo e no banco
  (a coluna `vector(1024)` recusa). Cada chunk guarda `embedding_model` + `dim`
  para detectar rollover de modelo no futuro.

## Consequências
Qualidade adequada em PT-BR com opção self-hosted (custo de infra, não por token).
Mudar o modelo/dimensão é uma migração consciente (nova coluna/índice + reindex),
não uma troca de config silenciosa. O `reindex` re-embeda fontes existentes quando
o modelo muda (mesma dimensão).
