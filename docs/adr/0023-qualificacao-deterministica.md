# ADR 0023 — Qualificação determinística (IA extrai, código decide)

## Contexto
Deixar o LLM "decidir" se um lead está qualificado é imprevisível, não-auditável e
varia entre execuções. Mas a extração de informação da conversa é exatamente onde o
LLM brilha.

## Decisão
- **Separação dura**: a IA apenas **PREENCHE** um schema de qualificação (tool
  `update_lead_fields`, persistido em `lead_profiles.fields`). A **DECISÃO**
  (`qualified`/`disqualified`/`pending`, score, rota) é uma **função PURA**
  (`decideQualification(schema, fields)`) — sem LLM, mesma entrada → mesma saída.
- **Schema data-driven** por tenant (campos, tipos, obrigatórios, eliminatórios,
  pesos, `qualifyAtScore`) — não hardcoded; resolvido por tenant agora, por nicho
  depois (ADR 0022).
- **Ordem de avaliação**: eliminatórios primeiro (violou → `disqualified`) →
  obrigatório faltando (`pending`) → score ≥ limite (`qualified`) senão
  `disqualified`. A transição de etapa que **destrava roteamento** (ex.: handoff)
  é governada por **código** (`decisionToLeadState`), nunca pela IA.
- O `request_human_handoff` é um **sinal** da IA (marca o turno); aplicar o estado
  de handoff é decisão do código no handler.

## Consequências
Qualificação auditável, testável (testes puros) e estável. Mudar critérios = mudar
dados (schema), não código. A IA não "alucina" um lead qualificado: no máximo
preenche campos que o código avalia.
