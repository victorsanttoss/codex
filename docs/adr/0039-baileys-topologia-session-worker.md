# ADR 0039 — Topologia session-worker (canal não-oficial Baileys)

## Contexto
O adaptador Cloud (oficial) é **stateless** (HTTP): qualquer worker envia/recebe.
O Baileys é **stateful** — mantém um **WebSocket vivo e uma sessão por número**.
Isso não escala como worker HTTP: o socket de um número vive num processo
específico, e só ele pode enviar por aquele número. O M2 adiou conscientemente
essa topologia; o M13 a entrega.

## Decisão
- **Pool de `session-worker`** (novo `APP_ROLE`, gate em `runtime/roles.ts`),
  separado dos workers stateless. Cada número é **atribuído de forma fixa
  (sticky)** a um worker: `hash(número) % total === index` (FNV-1a, determinístico,
  sem coordenação central). `SESSION_WORKER_INDEX`/`TOTAL` por processo.
- **Loop de reconcile (sem timers frágeis):** a cada intervalo o manager lista as
  conexões Baileys ativas que possui e (a) conecta números novos — onboarding gera
  QR; (b) reconecta os caídos respeitando **backoff exponencial com teto**. Não há
  `setTimeout` por reconexão: o estado (`closed` + `nextRetryAt`) dirige o reconcile.
- **Inbound por evento → MESMO núcleo.** Os eventos do socket viram um envelope
  canônico (`buildInboundEnvelope`) e entram no `InboundCoreService` extraído —
  dedup → FIFO (`SerializedRunner`) → persiste → mídia → agente. O **agente/RAG/
  CRM/cadência/guardrails não mudam**; só o *closure de resposta* difere (socket
  local em vez de HTTP).
- **Roteamento de ENVIO sticky.** Resposta reativa sai inline pelo socket do worker
  que recebeu o inbound (é o dono). Envio **proativo** (outbox/cadência): o
  `OutboxService` **particiona por provedor** — o scheduler processa só Cloud; o
  `session-worker` processa só os números Baileys que possui (socket aberto). Sem
  claim cruzado → sem dupla entrega. O seam é registrado via `setBaileysOutbound`
  só no session-worker (evita dependência circular de módulo).

## Consequências
Escala horizontal adicionando session-workers e **renumerando** (`total` maior →
hash redistribui; rebalanceamento documentado no runbook — exige reconexão dos
números que mudam de dono). Um número só envia do seu worker — coerente com o
modelo do WhatsApp Web. O `compose` já previa `session-worker` (ADR 0035). Mídia
inbound do Baileys (download via socket) fica como follow-up: hoje cai na política
não-texto do M6 (o caminho Graph do Cloud não se aplica).
