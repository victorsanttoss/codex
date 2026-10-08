# ADR 0035 — Deploy em VPS única com separação por role

## Contexto
O código atende 24/7 por construção, mas faltava a operação. Alvo escolhido: uma
**VPS Linux única com Docker Compose** (simples e barata para começar). Rodar HTTP,
workers de fila e cron no mesmo processo dificulta escalar/isolar falhas.

## Decisão
- **Mesma imagem, três roles** por `APP_ROLE` (`api`/`worker`/`scheduler`/`all`):
  - `api`: só HTTP (webhook + painel), 2 réplicas atrás do Caddy.
  - `worker`: consumidores BullMQ (pipeline inbound, crm-sync, knowledge).
  - `scheduler`: cron/scans (cadência, outbox, refresh de token, alertas).
  - `all`: tudo num processo (dev).
  Gating em `runtime/roles.ts`: cada serviço de fila cria o **producer** sempre e o
  **consumer/scan** só no seu role. `main.ts` faz `listen()` só no `api`; nos demais,
  `init()` (sobe os módulos sem HTTP).
- **Caddy** como único ponto público (TLS automático via ACME), LB round-robin entre
  as réplicas de `api` com health-check → deploy **uma réplica por vez** (quase sem
  downtime). Single-host **não** dá zero-downtime perfeito; a **reentrega de webhook
  da Meta** + `ensureProcessedOnce` cobrem o pequeno gap.
- **Postgres/Redis só na rede interna** do Docker (sem `ports:`); firewall libera só
  SSH+80+443. **Shutdown gracioso** (`enableShutdownHooks` + `stop_grace_period`)
  drena jobs em voo. `restart: always`, `mem_limit` por container, rotação de log.

## Consequências
Escala horizontal por role (mais `worker`/`api`) sem rearquitetar. Isolamento de
falha entre roles. **Trade-off assumido (ADR 0036):** VPS única é **ponto único de
falha** — documentado no runbook com o caminho de HA. Topologia já prevê
`session-worker` (Baileys) e `whisper` (áudio) comentados.
