# M6 — Revisão do Codex (Agente SDR) + triagem

Revisor: OpenAI Codex (`gpt-5.5`, read-only) sobre a união discriminada de
`LLMMessage`, as tabelas/repos do agente (lead/idempotência/config), e todo o
módulo `agent` (qualificação, prompt em camadas, tools, loop, handler) + wiring.
Sem achados CRÍTICOS.

Confirmou: RLS M6 correto (ENABLE+FORCE+policy `app.tenant_id`) e repos usam
`requireTenantContext`+`withTenant`; core segue agnóstico no `LLMMessage`; nenhum
log de conteúdo da conversa ou segredo; `pnpm -r typecheck` passa com `strict`,
`exactOptionalPropertyTypes` e `noUncheckedIndexedAccess`.

## Aplicado

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 1 | ALTO | `agent_configs` (jsonb) sem validação: tenant podia salvar `maxToolIterations` gigante ou `qualification: {}` e quebrar guardrails | `mergeConfig` agora **valida e faz clamp**: guardrails/knowledge em faixas seguras; qualification só é aceita se tiver `fields[]` válido (senão usa o default) |
| 2 | ALTO | Lead `qualified` (route `handoff`) só era escalado se a IA chamasse a tool — escalonamento dependia do LLM | Handler escala **deterministicamente**: `qual.route === "handoff"` (qualificado) OU tool de handoff → estado + mensagem de handoff, independente de tool call |
| 3 | MÉDIO | `QualificationField.type` não era usado: `"5000"` (string) violava `min`; tipo errado pontuava | `coerceField` por tipo antes de decidir (number aceita string numérica; tipo incoercível → tratado como ausente, não pontua nem elimina). Testes adicionados |
| 6 | MÉDIO | Teto de custo não era hard cap (1ª chamada sempre, cap só após tools, close gastava extra) | Cap checado **antes de cada chamada**; estourou → retorna sem nova chamada (fallback local). `tool_cap` ainda faz um close só se abaixo do cap |
| 7 | BAIXO | `tc.arguments` não-objeto dependia da robustez de cada tool | loop normaliza args não-objeto para `{}` antes de executar |
| 8 | BAIXO | Resumo rolante não incluía a resposta recém-enviada do turno | `summarize` recebe a conversa + a mensagem final do assistant |

## Documentado (dívida consciente)

- **#4 (MÉDIO) — at-most-once no envio**: `claimAgentResponse` antes do `reply`
  garante "no máximo um envio" (ADR 0024), mas se cair logo após o claim o lead
  fica sem resposta naquele passo. É o trade-off escolhido (duplicar é pior).
  Evolução: claim com status `pending/sent` + outbox/reparo → M7+.
- **#5 (MÉDIO) — at-most-once no inbound**: mesmo padrão em `ensureProcessedOnce`
  (M2). Virar "inbox com status" (claimed/recorded/handled) é refator da pipeline
  do M2 — fora do escopo do M6; registrado.
