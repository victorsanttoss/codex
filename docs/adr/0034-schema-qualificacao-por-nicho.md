# ADR 0034 — Schema de qualificação em camadas (default → nicho → tenant)

## Contexto
A qualificação é data-driven (ADR 0023): a IA preenche campos, o código decide.
Cada vertical tem campos próprios (solar → conta de luz/telhado/decisor; odonto →
convênio/procedimento). Até o M9 o schema resolvia só por **tenant**; faltava a
camada de **nicho**.

## Decisão
- O schema de qualificação resolve em **camadas**, espelhando a composição do
  prompt (ADR 0022): **tenant > nicho > default**.
  - `default` = `DEFAULT_AGENT_CONFIG.qualification` (genérico).
  - `nicho` = `niche_configs.qualification` (do kit da vertical, ADR 0033).
  - `tenant` = `agent_configs.qualification` (override do tenant).
- `AgentConfigService.forTenant()` resolve: se o tenant tem schema válido, usa-o;
  senão, se o nicho do tenant tem schema válido, usa o do nicho; senão, default.
  A resolução do nicho é **server-side** (`getTenantNicheId` + `getNicheConfig` sob
  RLS de nicho) — o tenant não escolhe/forja.
- A **função determinística** de decisão (M6) NÃO muda — passa a receber o schema
  já **resolvido**. Só a resolução é nova.

## Consequências
Um tenant "vira" SDR da sua vertical sem configurar nada: herda o schema do nicho.
Tenants avançados ainda podem sobrescrever campos. O isolamento por nicho garante
que um tenant não herde o schema de outra vertical. Validação/clamp da config do
tenant (M6) continua valendo; o schema do nicho também é validado antes de usar.
