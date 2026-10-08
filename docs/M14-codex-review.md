# Revisão de arquitetura M14 (Codex, read-only)

Módulo 14 — Interface da Plataforma (painel cliente + área de plataforma). Revisão
focada no **backend novo**. **Nenhum achado CRÍTICO.** Tratamento:

## ALTO — corrigido
- **`agent-message.handler.ts`: opt-out depois do `human_takeover`.** Se o lead
  mandasse "pare" enquanto um humano tinha assumido, a IA pausava e o **opt-out
  (LGPD) não era registrado**. **Correção:** o opt-out passou a ser processado
  **antes** do guardrail de takeover — compliance é sempre honrado, mesmo com a
  conversa sob atendimento humano.

## MÉDIO — corrigidos
- **`settings.controller.ts`: `PUT /admin/settings/agent` persistia o patch cru**
  (validação/clamp só na leitura). **Correção:** a escrita agora mescla com os
  defaults via `mergeConfig` (clampa guardrails/qualificação) e **limita o tamanho
  das strings** (anti-inflar prompt/custo) antes do `putAgentConfig`.
- **`panel.controller.ts`: detalhe de lead/conversa não excluía sandbox.** As listas
  já filtravam `sandbox=false`, mas `/admin/{leads,conversations}/:id` podiam expor a
  conversa do Playground por UUID conhecido. **Correção:** `isPanelConversation`
  (tenant dono + não-sandbox) → **404** nos detalhes para sandbox/UUID alheio.

## BAIXO — corrigidos
- **`playground.ts`: `ensureSandboxConversation` não exigia `sandbox=true`** no reuso.
  **Correção:** o fallback só reaproveita conversa marcada `sandbox=true` (o namespace
  `sandbox:` não colide com `cloud_api:`/`baileys:`; se colidir, **falha** em vez de
  escrever em conversa real).
- **`playground.controller.ts`: `niche` sem `MaxLength`.** **Correção:** `@MaxLength(60)`
  em `SimulateDto`/`ResetDto`.

## Verificações positivas (Codex)
**Isolamento cross-tenant OK** em todas as leituras novas (`listLeads`/
`listConversations`/`leadFunnel`/`account`/`onboarding`): `requireTenantContext()` +
`withTenant()` + filtro por tenant/RLS — sem vazamento. O **Playground não chama
WhatsApp/outbox/CRM/cadência** (tools só RAG + campos do lead sandbox + flags de
turno); listas/funil excluem `sandbox`. `/platform/*` coberto por `@Public()` +
`PlatformGuard` (token em tempo constante). **SQL raw** usa `sql` template/Drizzle —
sem concatenação injetável.
