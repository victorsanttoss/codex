# ADR 0032 — Versionamento do nicho, ToS/LGPD e metering de curadoria

## Contexto
A promoção ao nicho precisa ser reversível, juridicamente sustentável e não pode
ser cobrada do tenant.

## Decisão
- **Versionamento + rollback**: cada promoção insere uma linha em `niche_knowledge`
  com `version` incremental e `status='active'`. **Rollback = `retire`** (status
  `retired`) — a busca só considera `active`. Histórico preservado.
- **ToS/LGPD (constraint de produto, não código)**: o contrato do tenant deve
  consentir que **insights ANONIMIZADOS e CURADOS** derivados do uso melhorem o
  conhecimento do nicho. Sem PII, sem identidade, com curadoria humana (ADR 0031).
  Registrado aqui para não ser esquecido na operação/comercial.
- **Metering de plataforma**: o custo de LLM/embeddings da curadoria (mineração,
  promoção) é **investimento da plataforma** — gravado em `platform_usage`
  (`type: curation_*`), **nunca** em `usage_events` do tenant, **mesmo** quando a
  mineração lê dados do tenant sob `withTenant`. Teste garante que a curadoria não
  fatura o tenant.

## Consequências
Promoções são reversíveis e auditáveis; a base legal do compartilhamento fica
explícita; e a economia do produto fica correta (o tenant paga o próprio uso de
agente/RAG, não a curadoria coletiva da plataforma).
