# ADR 0043 — Playground sandbox (testar a SDR sem WhatsApp)

## Contexto
Testar a SDR exigia um número de WhatsApp real conectado — barreira grande para o
cliente "sentir" o produto. O M14 entrega um Playground que roda o **agente real**
e mostra a IA qualificando ao vivo, **sem enviar a leads** e sem poluir os dados.

## Decisão
- **Conversa de sandbox** (`conversations.sandbox = true`, migration 0023): o agente
  roda contra ela como contra qualquer conversa, mas ela é **excluída** de
  `listLeads`/`listConversations`/`leadFunnel` (todas filtram `cv.sandbox = false`).
  Os campos qualificados/summary vivem no `lead_profiles` dessa conversa (zerável
  pelo botão **Reiniciar** → `resetSandbox`).
- **Reuso, não duplicação.** O `PlaygroundService` compõe os MESMOS blocos do
  `AgentMessageHandler`: RAG (`KnowledgeRetriever`), prompt em camadas
  (`base/niche/tenant/conversation`), `AgentService.run` (loop de tool-calling com os
  guardrails do tenant) e a **qualificação determinística** (`decideQualification`).
  Por isso o teste reflete a produção.
- **NÃO passa pelo handler nem pelo outbox** → não envia WhatsApp, não dispara CRM
  nem cadência. O Playground **captura** a resposta + o conhecimento recuperado (com
  score de match) + os campos qualificados + o **custo da simulação** (`costMicros`
  do `AgentService`) + o score/rota. `@Roles('admin')`, contexto do tenant (RLS).
- **Seletor de nicho:** sobrepõe a *guidance* (via `getNicheByName`) para simular
  outro vertical sem mexer na config do tenant.

## Consequências
O cliente testa a SDR no onboarding (etapa 7) e no painel, sem número de WhatsApp.
Como reusa o agente real, o que ele vê é o que o lead receberia. **Pipeline e agente
permanecem intocados** (o Playground é um novo *composer*, não um novo caminho no
handler). O `AgentModule` passou a exportar `AgentService`/`AgentConfigService` para
o reuso. Trade-off: a sandbox grava mensagens/lead na sua própria conversa (para
multi-turno) — isolada e fora do painel; o "Reiniciar" limpa.
