# M7 — Revisão do Codex (CRM + agendamento + handoff) + triagem

Revisor: OpenAI Codex (`gpt-5.5`, read-only) sobre os ports CRM/agendamento/
notificação, o adaptador `crm-http`, as tabelas/repos internos, e os serviços do
módulo `crm` + o wiring no handler. Sem achados CRÍTICOS; 3 ALTOS.

Confirmou: RLS+FORCE+catálogo nas 6 tabelas; repos sob `requireTenantContext`+
`withTenant`; worker reentra com `runWithTenant`; o handler protege o turno contra
falha do CRM após responder ao lead.

## Aplicado

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 3 | ALTO | **SSRF**: `httpBaseURL` (config tenant não-confiável) ia direto ao `fetch` com `Authorization: Bearer <crm_api_key>` → acesso a localhost/metadata/rede interna | `mergeCrmSettings` valida a URL: exige **https** e bloqueia loopback/IP privado/link-local/`.internal`; inválida → cai para **builtin** (fail-safe) |
| 1 | ALTO | `opportunities`/`appointments`/`crm_external_sync` referenciavam `conversations(id)` sem tenant → job com `(tenantA, convB)` criaria referência cross-tenant | migration 0010: `UNIQUE (tenant_id, id)` em conversations + **FK composta** `(tenant_id, conversation_id)` nas 3 tabelas |
| 2 | ALTO | `upsertCrmSync` zerava `contact/opportunity_external_id` numa falha sem IDs (perdia o que já sincronizou) | update agora **COALESCE** preserva os IDs externos já gravados; só atualiza com novos |
| 4 | MÉDIO | Sync sem `jobId` (re-handoff enfileira duplicado) e `addActivity` não idempotente | `enqueueSync` usa `jobId = tenant:conversa:crm-sync` (dedup na fila); atividade de sync só é gravada na 1ª vez (consulta `crm_external_sync`) |
| 5 | MÉDIO | Idempotência só por `phone`; mapa de sync não era consultado antes das chamadas externas; telefone sem normalização | `sync` lê `getCrmSync` e **curto-circuita se já `synced`**; telefone normalizado (sem espaços) |
| 6 | MÉDIO | Oportunidade não propagava `conversationId` (sem rastreabilidade) | `CrmOpportunity.conversationId` adicionado ao port; built-in propaga; gravado no insert |
| 7 | BAIXO | `CrmError.detail` podia reter `error.message` do CRM externo | `detail` truncado (≤200 chars) e segue não-enumerável |
| 8 | BAIXO | `rls-catalog` não verificava a EXPRESSÃO da policy (uma policy permissiva passaria) | catálogo agora exige `NULLIF(current_setting('app.tenant_id'...))` no `qual`/`with_check` de toda tabela tenant-scoped |

## Documentado (consciente)
- A dedup de contato por **telefone** é a chave natural do WhatsApp; normalização
  fina (E.164) e fallback por contato interno quando o telefone for não-confiável
  ficam para quando houver canais além do WhatsApp.
- Sincronização **bidirecional** (webhooks do CRM de volta) é futura — o M7 é só de
  saída (lead → CRM).
