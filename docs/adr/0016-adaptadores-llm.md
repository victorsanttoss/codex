# ADR 0016 — Adaptadores de LLM (Anthropic + OpenAI-compatible)

## Contexto
O núcleo é agnóstico a fornecedor (port `LLMProvider`). Precisamos de adaptadores
concretos para um provedor por token e para modelos abertos auto-hospedados, sem
deixar nada de fornecedor vazar para `packages/core`.

## Decisão
- **`@sdr/llm-anthropic`** (key `anthropic`): usa o SDK oficial `@anthropic-ai/sdk`,
  cliente **injetável** (testes sem rede real). Traduz o `CompletionRequest` neutro
  ↔ Messages API; fecha o ciclo de tool-calling (reenvia `tool_use` + `tool_result`);
  normaliza `toolCalls`/`usage`/`finishReason`. **Gating de sampling:** não envia
  `temperature`/`top_p` em Opus 4.7/4.8 e Fable (a API retorna 400 lá).
- **`@sdr/llm-openai-compat`** (key `openai_compat`): um adaptador com `baseURL`
  configurável cobre **modelo aberto auto-hospedado** (vLLM/Ollama) **e** provedores
  por token (DeepSeek/Together/Groq/OpenRouter). Function-calling + streaming SSE;
  HTTP injetável.
- Ambos passam `runLLMProviderContract`, são registrados no `ProviderRegistry` no
  composition root, e lançam `LlmError` agnóstico (transiente/permanente).
- **Agnosticismo garantido por teste estrutural**: nenhum import de fornecedor em
  `packages/core`.

## Consequências
Trocar/adicionar provedor não toca o núcleo nem a pipeline (M2). O M6 (agente)
consome `LlmProvider`/`LlmRouter`. Tokens cacheados/batch ficam como otimização
interna do adaptador (M5 explora prompt caching).
