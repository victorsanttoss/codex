# ADR 0037 — Port de transcrição (STT) openai-compatible

## Contexto
Quando o lead manda áudio, o agente (M6) responde com a política não-texto
("me manda por texto"). Faltava entender voz. STT tem dois mundos de custo: rodar
Whisper auto-hospedado (faster-whisper/whisper.cpp atrás de uma API
OpenAI-compatible) ou pagar um provedor por minuto. Não queremos acoplar o núcleo
a nenhum dos dois.

## Decisão
- **Port agnóstica `TranscriptionProvider`** no core: `transcribe({ data, mimeType,
  languageHint? }) -> { text, usage }`. `usage.seconds` alimenta o metering. Erros
  viram `TranscriptionError` (categoria pública segura; detalhe cru não-enumerável,
  nunca cruza a borda) — mesmo padrão de `EmbeddingError`/`LlmError`. Contrato
  reutilizável + `FakeTranscriptionProvider`; teste estrutural passa a banir
  `@sdr/transcription-*` no core.
- **Adaptador único openai-compatible** (`packages/transcription-openai-compat`):
  POST multipart em `/audio/transcriptions`, `baseURL` configurável cobre **Whisper
  self-hosted E provedor por token** — mesma decisão "um adaptador, dois mundos" do
  M4/M5. Trata OGG/Opus do WhatsApp (extensão derivada do MIME), manda dica de
  idioma (**PT default**), pede `verbose_json` para ler a **duração** (metering),
  retry/backoff em transiente, HTTP injetável (sem rede nos testes).
- **Preço fail-closed** no `@sdr/llm-router` (`DEFAULT_TRANSCRIPTION_PRICING`, USD por
  minuto): modelo sem preço **lança**; self-hosted entra com `{ perMinute: 0 }`
  explícito (grátis intencional — custa infra, não por-minuto).
- **Chave por tenant** (`TranscriptionService`): `transcription_api_key` →
  `llm_api_key` → plataforma; self-hosted pode não ter chave (Bearer omitido).
  Segredo nunca em log; metering com `type: 'transcription'`.

## Consequências
Trocar Whisper self-hosted por um provedor por token (ou vice-versa) é mudar
`baseURL`/modelo/segredo — sem tocar no núcleo nem no agente. **Visão fica de fora
de propósito** (não é uma nova port; será follow-up de LLM multimodal). A duração
vem da resposta do provedor; se ausente, o custo registra 0 com `secondsMissing`
no metadata (honesto, sem inventar).
