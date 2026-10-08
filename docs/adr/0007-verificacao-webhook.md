# ADR 0007 — Verificação do webhook (assinatura HMAC + rawBody)

## Contexto
O webhook é a porta de entrada do produto. Precisa rejeitar payloads não
autênticos antes de qualquer processamento.

## Decisão
- Validar `X-Hub-Signature-256` = HMAC-SHA256 do **corpo BRUTO** com o app secret
  da plataforma, em comparação de tempo constante.
- A app sobe com `rawBody: true` (NestJS) para preservar os bytes originais — a
  assinatura é sobre os bytes exatos, não sobre o JSON re-serializado.
- A verificação acontece DENTRO de `normalizeInboundWebhook`/`normalizeStatusEvents`
  do adaptador (a port recebe headers+rawBody). Assinatura inválida ⇒ retorna
  vazio ⇒ nada é processado.
- `GET` de verificação responde ao `hub.challenge` comparando o verify token da
  plataforma.

## Consequências
Nenhum payload forjado entra na pipeline. O controller responde 200 rápido;
mensagens forjadas simplesmente não geram efeito.
