# Monitor de uptime EXTERNO (a VPS não se monitora caída)

Se a VPS inteira morrer, **nenhum alerta interno dispara** — por isso o monitor de
uptime tem de ser **de fora**.

## O quê
Um serviço externo pinga, a cada ~1 min:
- **Liveness:** `GET https://SEU_DOMINIO/health` → `{"status":"ok"}` (200).
- **Readiness:** `GET https://SEU_DOMINIO/ready` → 200 quando Postgres+Redis OK;
  503 (`degraded`) se uma dependência cair.

Se parar de responder (ou status ≠ 200) por 2 checagens seguidas, **alerta o
operador** (Telegram/WhatsApp/e-mail/SMS).

## Opções (escolha uma)
- **Healthchecks.io / UptimeRobot / BetterStack** (SaaS, grátis no tier básico):
  cadastrar os dois URLs + canal de alerta. Zero infra.
- **Uptime Kuma** num *segundo* host barato (NUNCA na mesma VPS): monitora `/health`
  e `/ready`, alerta via Telegram/Slack.

## Não confundir com os alertas internos (M11)
- **Interno** (`AlertsService` no `scheduler`): disco, token expirando, outbox
  falho, conexão de tenant caída, fila travada. Roda DENTRO da VPS → só serve
  enquanto a VPS está viva.
- **Externo** (este monitor): a própria VPS está de pé e respondendo? É o único que
  pega "a box morreu".

Os dois são complementares e necessários.
