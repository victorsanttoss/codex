# ADR 0036 — Ponto único de falha, backup externo e monitor externo

## Contexto
VPS única é barata e simples, mas é um **single point of failure**: se a máquina
morrer, todos os tenants ficam mudos ao mesmo tempo e não há failover. Dois riscos
operacionais decorrem disso: perda de dados (disco) e cegueira (a VPS não se
monitora caída).

## Decisão
- **Risco de ponto único é ACEITO conscientemente** nesta fase (não construímos HA).
  O runbook documenta o risco e o **caminho futuro**: Postgres gerenciado + 2ª VPS
  atrás de LB + Redis gerenciado, quando o faturamento justificar.
- **Backup PARA FORA da VPS, cifrado** (`deploy/backup.sh`): `pg_dump | gzip | gpg |
  s3`. Backup no mesmo disco não protege contra disco corrompido. Retenção + **restore
  testado** e documentado (backup que nunca foi restaurado não é backup).
- **Monitor de uptime EXTERNO** (`deploy/uptime-monitor.md`): um serviço de fora
  pinga `/health` e `/ready` e alerta o operador. Se a VPS inteira morre, nenhum
  alerta INTERNO dispara — só o externo pega "a box caiu".
- **Alertas internos** (M11, no `scheduler`): disco, token expirando, outbox falho,
  conexão de tenant caída, fila travada. Complementam o monitor externo (rodam
  enquanto a VPS está viva). Mantidos simples — sem stack pesada de observabilidade
  no dia 1.
- **Refresh de token proativo** (resolve a dívida do M3): renova antes de expirar;
  sem estratégia automática → **alerta para reconectar** ANTES de o token silenciar o
  cliente de madrugada.

## Consequências
Sobrevive a perda de disco (restore externo) e a queda total (monitor externo
alerta). O custo é a janela de indisponibilidade durante um incidente grave (sem
failover automático) — aceitável no início, com caminho de evolução claro.
