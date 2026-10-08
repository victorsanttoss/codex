# ADR 0009 — Janela de atendimento de 24h

## Contexto
O WhatsApp só permite mensagens free-form dentro de 24h após a última mensagem do
usuário. Fora disso, só templates (pagos e pré-aprovados). Violar isso bloqueia o
número e gera custo inesperado.

## Decisão
- A cada inbound, `window_expires_at` da conversa é resetado para `now + 24h`.
- `isWithinServiceWindow(window_expires_at)` decide o caminho de envio.
- Outbound free-form (`sendMessage`) é permitido só DENTRO da janela; FORA, a
  pipeline recusa com erro tipado e exige `sendTemplate`.
- O metering distingue **conversa de serviço** (dentro, gratuita) de **template**
  (fora, paga) — alimenta a tese de custo do produto.

## Consequências
Proteção contra bloqueio da Meta e custo surpresa. O handler do agente (M6) deve
tratar o erro "fora da janela" escolhendo um template.
