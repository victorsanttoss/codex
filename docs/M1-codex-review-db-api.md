# M1 — Revisão do Codex (db + api) + triagem

Revisor: OpenAI Codex (`codex exec`, read-only) sobre `packages/db` e `apps/api`.
Executor: Claude Code. (Fundação revisada antes em `M1-codex-review.md`.)

## Aplicado

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 1 | ALTO | `logout` não limpava `refresh_token` (path `/auth` ≠ `/`) | clearCookie com path/domain corretos |
| 2 | ALTO | Dedup global `(provider, msg_id)` — colisão cross-tenant dropa mensagem | unique e onConflict agora `(tenant_id, provider, external_message_id)`; +teste cross-tenant |
| 4 | MÉDIO | Auth não bloqueava tenant `suspended/deleted` | join `tenants` + `status='active'` em login/refresh/switch |
| 5 | MÉDIO | Enumeração por timing no login (short-circuit sem user) | verify de hash dummy quando e-mail inexiste |
| 6 | MÉDIO | Redaction do pino rasa | lista ampliada (access/refresh token, api_key, client_secret, headers aninhados) |

## Documentado (dívida consciente)

- **#3 (ALTO)** `RedisMutex` não renova lock: exclusividade vale enquanto `fn` <
  `ttlMs`. Heartbeat/fencing fica para o M2 (consumidor real). Comentário e ADR
  0003 ajustados para não prometer serialização forte além do TTL.
- **#7 (BAIXO)** CSRF: sem token; `SameSite=Lax` + web usando Bearer mitigam.
  Documentado no ADR 0006.
- **#8 (BAIXO)** `getDb/withSystem` exportados amplamente: em M2+ preferir expor
  repositórios/casos de uso e restringir o acesso cru ao banco.

## Desvio consciente do spec do M1

O spec pedia `unique(provider, external_message_id)`. Mudado para incluir
`tenant_id` (achado #2) — alinhado ao princípio nº1 (isolamento rígido): a
constraint global vê linhas invisíveis por RLS e causaria perda de mensagem
cross-tenant. Reversível se o WhatsApp oficial (IDs globalmente únicos) for o
único canal.

## Confirmado pelo Codex (sem ação)

`withTenant` não vaza GUC no pool (`set_config` local em transação); `withUser`
não vaza memberships de outros usuários; AAD `tenantId:kind` coerente; padrão de
contexto (`runWithRequestContext` + `assignTenant`) correto para handlers async.
