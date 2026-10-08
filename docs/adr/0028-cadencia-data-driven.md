# ADR 0028 — Motor de cadência data-driven + guardrails no envio

## Contexto
Reengajar leads frios aumenta conversão, mas disparo proativo mal feito **bane o
número** e viola LGPD. As regras (passos, atrasos, horário) variam por tenant.

## Decisão
- **Data-driven por tenant** (`CadenceConfigService`, sub-objeto `cadence` da config
  do agente): passos (atraso + template), horário comercial + fuso, teto de
  frequência, máximo de passos — tudo **validado e clampado** (config é dado
  não-confiável). **Opt-in**: cadência vem **desabilitada** por default.
- **Guardrails re-checados NO MOMENTO DO ENVIO** (não só ao armar): o worker varre
  cadências vencidas e, para cada uma, re-verifica lead resolvido (qualified/
  handoff/disqualified), opt-out, horário comercial, teto de frequência e template
  aprovado. Falha de regra → **para** (resolvido/opt-out/template) ou **adia**
  (fora do horário / frequência). Cancelamento é trivial — a condição é checada na
  hora, não pré-computada.
- **Armar é barato, disparar é caro**: ao fim de um turno sem resolução, agenda o
  próximo passo (`cadence_state`); qualquer inbound **para** (stop-on-engagement).
- **Fora da janela de 24h, só template** (HSM aprovado, ADR 0028 + catálogo).
  Disparo enfileira no **outbox** (ADR 0027), idempotente por passo
  (`cadence:{conversa}:{passo}`).

## Consequências
A política de reengajamento é configuração, não código. Os guardrails ficam à prova
de corrida (checados no envio). O número fica protegido: nada é enviado fora do
horário, acima da frequência, para opt-out, ou para lead já resolvido.
