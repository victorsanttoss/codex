# ADR 0021 — Conhecimento em camadas + retriever componível

## Contexto
O produto terá conhecimento em **camadas**: base (plataforma) + **nicho**
(compartilhado entre tenants do mesmo nicho, após curadoria) + **tenant**. As
niche packs são compartilhadas e entram em módulo posterior. No M5 só existe a
camada do **tenant**. Não queremos reescrever a busca quando o nicho chegar.

## Decisão
- **Recuperação componível e ciente de escopo**: `KnowledgeRetriever` consulta uma
  **lista de fontes** (`KnowledgeSource.search(queryVector, topK, minScore)`) e
  **mescla por score**. No M5, só `TenantKnowledgeSource` é registrada. Base/nicho
  entram **adicionando fontes à lista**, sem mudar a assinatura nem o chamador
  (o M6 consome `retriever.search(query)` e não sabe quantas camadas existem).
- **Isolamento por storage, não por linha**: o conteúdo do tenant fica nas tabelas
  **tenant-scoped (RLS FORCE)**. A futura camada de nicho terá **storage próprio**
  (de plataforma/nicho) — é **proibido** injetar conteúdo compartilhado dentro da
  tabela tenant-scoped (vazaria entre tenants ou duplicaria por tenant).

## Consequências
Somar camadas é aditivo e local (registrar uma fonte), sem refatorar a borda que o
agente usa. O isolamento crítico (tenant não vê dado de outro) permanece garantido
por RLS na camada do tenant; a camada de nicho terá seu próprio controle de acesso
(read-only, por nicho) quando existir.
