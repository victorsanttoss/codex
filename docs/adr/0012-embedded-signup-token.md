# ADR 0012 — Embedded Signup e estratégia de token

## Contexto
Onboarding manual de número não escala. A Meta oferece o Embedded Signup (popup)
para o tenant conectar sua WABA; a plataforma (Tech Provider) recebe o `code`.

## Decisão
- `EmbeddedSignupService` orquestra via Graph (HttpClient injetável): `code → token`
  (`/oauth/access_token` com app id/secret da **plataforma**), validar o
  `phone_number_id` na Graph, **subscrever** o app à WABA (`/{waba}/subscribed_apps`),
  **registrar** o número (`/{phone}/register`, trata "já registrado").
- **Token**: guardado cifrado via `TenantSecretsStore` (kind `whatsapp_token`).
  `expires_in` (quando presente) vira `token_expires_at` em `channel_connections`.
  Tokens sem expiração ficam com `token_expires_at` nulo.
- **Refresh/rotação**: `TokenExpiryService` varre tokens perto de expirar e alerta;
  o gancho de refresh é provider-specific e fica documentado (a estratégia exata
  de token de longa duração depende da config da conta na Meta).
- Erros da Meta: transiente (429/5xx/rede) com retry/backoff; permanente tipado.

## Limitações conhecidas
- A troca `code → token` é um `GET /oauth/access_token` com `client_secret` e
  `code` na query (formato da Meta). Não logamos a URL e o pino redige campos
  nomeados, mas proxies/APM externos poderiam capturar query params — garantir
  redaction de `client_secret`/`code` em qualquer camada de observabilidade.
- `assertNumberInWaba` confirma que o número pertence à WABA informada antes de
  subscrever/registrar (evita um admin conectar número de outra WABA).

## Consequências
Onboarding self-service; o `POST /admin/whatsapp/connections` manual permanece
como fallback. A pipeline do M2 passa a rotear o tenant assim que a conexão fica
`active`, sem nenhuma mudança no M2.
