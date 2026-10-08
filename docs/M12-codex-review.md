# Revisão de arquitetura M12 (Codex, read-only)

Módulo 12 — Áudio / Transcrição (speech-to-text). Revisão `codex exec --sandbox
read-only`. **Nenhum achado CRÍTICO.** Abaixo, os achados e o tratamento.

## ALTO — corrigidos

1. **Cobrança antes do cache durável** (`transcription.service.ts` /
   `audio-enrichment.service.ts`). O metering era gravado dentro do
   `TranscriptionService`, antes de o enriquecimento persistir o cache; um crash
   entre transcrever e cachear faria o retry recobrar.
   **Correção:** o `TranscriptionService` passou a só **calcular** o custo
   (retorna `costMicros`); o `AudioEnrichmentService` persiste o cache
   (`saveTranscription`) **e só então** grava o metering (`recordUsage`). No pior
   caso, uma **subcobrança única** (preferível a cobrar duas vezes). Teste cobre a
   ordem `save → meter`.

2. **`duration` fracionário em coluna `integer`** (`0019` /
   `transcription-adapter.ts`). Risco de falha de insert/arredondamento silencioso
   **após** a cobrança, quebrando o cache.
   **Correção:** segundos são **arredondados** (`Math.round`) no
   `TranscriptionService` antes de persistir/comparar — valor inteiro consistente
   em todo o caminho.

3. **Duração ausente cobrava 0 em modelo pago** (não fail-closed).
   **Correção:** se o provedor não reporta duração e o modelo tem `perMinute > 0`,
   cobra-se pelo **teto** (`maxDurationSeconds`) — nunca 0 silencioso. Self-hosted
   (`{ perMinute: 0 }`) cobra 0; modelo sem preço cadastrado continua **lançando**
   (`transcriptionCostMicros` fail-closed).

## MÉDIO

4. **Download do binário antes do limite de tamanho** (`media.service.ts`).
   **Correção:** guard **pré-download** lendo `file_size` da Media API — rejeita
   antes de materializar o Buffer. O teto pós-download (16MB) permanece como rede de
   segurança.

5. **Cache não-atômico / índice não-único → possível dupla transcrição concorrente.**
   **Tratado como trade-off aceito** (ADR 0038): o `SerializedRunner` serializa por
   conversa (cobre retries da mesma conversa); a mesma mídia em **conversas distintas
   em paralelo** pode, na 1ª vez, transcrever duas vezes — evento raro, custo de 1
   transcrição extra, preferível a um lock distribuído por mídia no dia 1.

## BAIXO — corrigido

6. **`baseURL` não validado no construtor do adapter.**
   **Correção:** `OpenAiCompatTranscriptionProvider` agora exige `baseURL` (além de
   `model`) no construtor.

## Verificações positivas (Codex)
Núcleo permanece **agnóstico**; RLS de `media_objects` herda `ENABLE/FORCE ROW LEVEL
SECURITY`; logs **não** expõem token/bytes; testes do adapter usam **HTTP injetável**
(sem rede real); o **loop do M6** recebe o áudio enriquecido como texto sem alterar o
handler.
