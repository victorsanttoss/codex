# ADR 0008 — Plataforma × tenant nos segredos do WhatsApp

## Contexto
Como Tech Provider, há UM app da Meta para todos os tenants, mas CADA tenant tem
seu próprio número e token de envio. Misturar esses segredos é erro de isolamento.

## Decisão
- **Segredos da PLATAFORMA** (app secret p/ assinatura, verify token p/ challenge):
  vêm de `packages/config` (env), únicos para a app inteira.
- **Token de ENVIO** (por tenant): cifrado no `tenant_secrets` (kind
  `whatsapp_token`), lido via `TenantSecretsStore` DENTRO do contexto do tenant.
- `channel_connections` mapeia `phone_number_id` → tenant; a resolução no webhook
  é feita no caminho system (sem expor a tabela inteira — policy de lookup por
  `app.resolve_phone`).

## Consequências
O webhook valida assinatura com o segredo da plataforma e só então resolve o
tenant e usa o token DELE para responder. Um tenant nunca alcança o token de outro.
