# M4 — Revisão do Codex (LLM real: adaptadores + roteamento) + triagem

Revisor: OpenAI Codex (`gpt-5.5`, read-only) sobre os adaptadores `llm-anthropic`
e `llm-openai-compat`, o `llm-router` (pricing + router), o `LlmService`/registro
da api, a port `LLMProvider`/`LlmError` no core, a seção `llm` do config e a
migration 0004. Sem achados CRÍTICOS. Confirmou: precedência `tenantKey ??
platformKey` correta; AAD/cifragem do `TenantSecretsStore` (`tenantId:kind` sob
RLS via `withTenant`) bem direcionados; nenhum vazamento real de fornecedor em
`packages/core`.

## Aplicado

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 2 | ALTO | Modelo sem preço no catálogo → `costMicros = 0` silencioso (subcobrança), agravado por `LLM_DEFAULT_MODELS` configurável | **Fail-closed**: `costMicros` lança; `LlmRouter` valida no construtor que todo candidato tem preço; modelo aberto/self-hosted exige entrada `{input:0,output:0}` explícita (`pricing.ts`, `router.ts`) |
| 3 | ALTO | Args de tool com JSON inválido viravam `{}` silencioso (stream linha 84 e non-stream 146) → tool executada com parâmetros errados | `parseToolArgs` lança `LlmError` **permanente** em JSON inválido; vazio/ausente continua `{}` (tool sem params) (`openai-adapter.ts`) |
| 4·5 | MÉDIO | Mensagem crua do SDK/proxy copiada para `LlmError` e agregada pelo router → risco de vazar payload/segredo na borda agnóstica | `LlmError.fromStatus` + `llmErrorCategory` (core): `message` é categoria segura por status; texto cru fica em `detail` **não-enumerável** (só log redigido). Ambos adaptadores e o erro final do router usam categoria (`llm-provider.ts`, ambos adapters, `router.ts`) |
| 6 | MÉDIO | Fallback permanente entre modelos do mesmo provider/chave: um 401 tentava todos os modelos com a MESMA credencial | Router marca `providerId` com credencial morta (401/403 via `isCredentialStatus`) e pula os demais modelos dele; fallback só p/ outro provedor/credencial (`router.ts`) |
| 9 | MÉDIO | Parser SSE frágil: só linha terminada em `\n`, descartava buffer final sem newline → podia perder `usage`/`finish_reason`/args | Processa até o último `\n`, guarda o parcial, e dá **flush do buffer final** sem newline; `trim()` cobre CRLF (`http.ts`) |
| 10 | BAIXO | Teste estrutural de agnosticismo cobria só alguns imports literais | Regex agora pega `import`/`import()`/`require` de fornecedor + 2º teste que falha se o `package.json` do core declarar dep de fornecedor (`agnostic.test.ts`) |
| 11 | BAIXO | Backoff com jitter fixo de 50ms, sem teto nem validação de `maxAttempts` | `normalizeRetry` (clampa `maxAttempts≥1`, `baseDelayMs≥0`); backoff com **teto** `maxDelayMs` (default 5s) + full jitter proporcional (`router.ts`) |

Testes adicionados: fail-closed de preço (constrói/rejeita), short-circuit de
credencial 401 (1 chamada, cai p/ outro provider), args de tool inválidos → erro
permanente. **107 testes** (era 103).

## Documentado (dívida consciente)

- **#1 (ALTO) — config multi-provedor**: hoje o `LlmService` monta a cadeia só com
  o adaptador `anthropic` (modelos da plataforma). O `openai_compat` está
  registrado e o router já faz fallback **cross-provider**, mas falta o schema de
  config `llm.providers[]` `{adapter, baseURL?, platformApiKey?, models[]}` para
  ativá-lo de fato. Entra junto da fiação do agente (M6).
- **#7 (MÉDIO) — `LLMMessage` união discriminada**: `toolCallId` é opcional mesmo
  para `role:"tool"` (adaptadores enviam `""` quando ausente). Trocar por união
  discriminada (mensagem `tool` exige `toolCallId`) é mudança de port que ramifica
  contratos + ambos adaptadores; adiada p/ não desestabilizar a port no M4.
- **#8 (MÉDIO) — timeout/abort no streaming**: `OpenAiHttp` não aceita
  `AbortSignal`/timeout; conexão pendurada prende a request (retry só após erro).
  Precisa de plumbing de `AbortSignal` pela port; fazer ao ligar o agente (M6),
  classificando timeout como transiente.
- **#12 (BAIXO) — migration 0004**: `ALTER TYPE ADD VALUE` em transação no PG16 é
  ok porque o valor não é usado na mesma transação. Manter 0004 isolada (não
  agrupar com migration futura que use `llm_api_key` no mesmo batch).
