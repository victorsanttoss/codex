# ADR 0017 — Catálogo de preços (plataforma) e custo por chamada

## Contexto
O roteamento por custo e o metering precisam do preço por modelo. Preço é dado
de PLATAFORMA, não de tenant — não pode virar tabela tenant-scoped por engano.

## Decisão
- Catálogo em **código/config** (`@sdr/llm-router` `DEFAULT_PRICING`), atualizável,
  com seed conferido na doc oficial (skill `claude-api`): Opus 4.8 $5/$25, Sonnet
  4.6 $3/$15, Haiku 4.5 $1/$5, Fable 5 $10/$50 (input/output por 1M tokens).
- **Não é tenant-scoped**: nenhuma RLS de tenant; sem risco de vazamento. Se um dia
  virar tabela, é tabela de plataforma com acesso system-only.
- `costMicros(model, usage)` = `tokensIn*inputPerM + tokensOut*outputPerM` (micros
  de USD). Modelo sem preço cadastrado → custo 0 e ordenado por último (o chamador
  fornece override de preço para modelos abertos).
- O custo é gravado via `recordUsage({type:'llm_call', costMicros, ...})` no contexto
  do tenant, para o provedor/modelo que **de fato respondeu**.

## Consequências
Custo por tenant rastreável e auditável. Preços mudam — revisar o seed
periodicamente (ou puxar da Models API). Input cacheado/batch (descontos) podem
ser modelados depois como flags no cálculo.
