# ADR 0004 — Ports & adapters (núcleo agnóstico a fornecedor)

## Contexto
O canal (WhatsApp via Meta Cloud API oficial ou via não-oficial) e o modelo (LLM
aberto auto-hospedado ou provedor por token) variam por tenant e ao longo do tempo.
O núcleo não pode acoplar a um fornecedor.

## Decisão
- Duas **ports**:
  - `ChannelProvider`: `sendMessage`, `sendTemplate`, `normalizeInboundWebhook`
    (recebe `InboundWebhookRequest` com headers/query/rawBody para verificação de
    assinatura), ciclo de vida (`connect`/`disconnect`/`status`).
  - `LLMProvider`: `complete`/`stream` com tool-calling, retornando conteúdo **e
    uso (tokens in/out)** para alimentar o metering.
- `ProviderRegistry` seleciona o adaptador conforme a config do tenant.
- **Nenhum adaptador concreto no M1** — apenas as interfaces, exercitadas por
  **suítes de contrato reutilizáveis** com fakes em memória. Qualquer adaptador
  futuro (M2/M4) deve passar nessas suítes.

## Consequências
Trocar/adicionar fornecedor não toca o núcleo. Validação de config por-adapter
fica nos adaptadores concretos. As contract suites viram o critério de aceite de
todo adaptador novo.
