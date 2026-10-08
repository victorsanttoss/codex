# ADR 0022 — Composição do agente em camadas (seam das niche packs)

## Contexto
O conhecimento e o comportamento do agente serão em **camadas**: base (SDR) +
**nicho** (compartilhado entre tenants do mesmo nicho, após curadoria) + tenant +
conversa. As niche packs entram em módulo posterior. No M6 só existem base, tenant
e conversa. Não queremos reescrever o agente quando o nicho chegar.

## Decisão
- **System prompt componível**: `composeSystemPrompt(layers)` recebe uma lista de
  `PromptLayer` (`render(): string | null`) na ordem base → **[nicho]** → tenant →
  conversa. No M6 `nicheLayer` é no-op (`render → null`). Somar a camada de nicho
  é **adicionar uma camada à lista** — não muda assinatura nem chamador.
- **Config/qualificação/tools também resolvidas por camada**: `AgentConfigService`
  faz default de plataforma + override do tenant; a camada de nicho entra **entre**
  os dois depois. O **registry de tools** permite somar ferramentas por nicho/
  vertical sem tocar o loop.
- **Isolamento por storage**: conteúdo do tenant em tabelas tenant-scoped (RLS
  FORCE); a futura camada de nicho terá storage próprio (ADR 0021) — não se mistura
  conteúdo compartilhado na tabela do tenant.

## Consequências
A evolução para nicho/vertical é **aditiva e local** (uma camada, uma entrada no
registry), sem refatorar o handler nem o loop. O agente do M6 já roda ponta a ponta
só com base+tenant+conversa.
