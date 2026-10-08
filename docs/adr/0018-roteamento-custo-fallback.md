# ADR 0018 — Roteamento por custo + fallback (LlmRouter)

## Contexto
Tenants têm sensibilidades de custo diferentes; provedores falham/ficam
indisponíveis. Precisamos escolher o modelo mais barato adequado e cair para
alternativas em erro, sem retry-storm.

## Decisão
- `LlmRouter` recebe **candidatos já adequados ao tier** (a seleção de adequação —
  ex.: precisa de tool-calling — é do chamador) e os **ordena por custo** (mais
  barato primeiro, via `priceScore`).
- **Transiente** (rede/429/5xx → `LlmError.transient`): retry com backoff+jitter no
  **mesmo** provedor (limite configurável); esgotado → próximo da cadeia.
- **Permanente** (auth/quota/400): **sem retry** — vai direto ao próximo (evita
  retry-storm). Erro desconhecido é tratado como transiente (tenta fallback).
- A cadeia de fallback é a lista ordenada — o próximo pode ser **cross-provider**.
- **Metering correto**: grava `recordUsage` para o provedor/modelo que respondeu,
  via callback `onUsage` (mantém o router desacoplado de `@sdr/db`).

## Consequências
Custo minimizado por chamada com resiliência a falhas. O chamador controla quais
modelos entram na cadeia por tier. Tokens reais (não estimados) definem o custo
gravado; a ordenação usa preço por token como proxy de "mais barato".
