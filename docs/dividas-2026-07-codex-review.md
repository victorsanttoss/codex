# Revisão Codex — fechamento das dívidas do motor (jul/2026)

Duas rodadas de revisão (Codex, `--sandbox read-only`) sobre os 4 fechamentos de
dívida: E.164 (M7), núcleo de entrega compartilhado (M8), busca híbrida (M5) e
gestão de staff pela UI (ADR 0044). **Nenhum CRÍTICO** em nenhuma rodada; todos os
ALTO/MÉDIO/BAIXO tratados.

## Rodada 1 — núcleo de entrega (outbox) — corrigidos em f4b7cbb

- **ALTO (corrida de status):** o receipt delivered/read/failed podia chegar ENTRE o
  envio e o insert do ledger reativo → o reconcile não achava a linha e ela ficava
  stale em 'sent'. → `recordSentOutbox` faz CATCH-UP do status já gravado em
  `messages` (reconcile é monotônico; corrida dupla não regride). Teste dedicado.
- **MÉDIO (contagens):** linhas reativas entravam no teto de frequência da cadência
  (`countOutboxSentSince`) e no alerta ops (`countOutboxFailed`) — respostas normais
  do agente bloqueariam follow-up e disparariam alerta de dispatcher. → coluna
  `origin` ('proactive'|'reactive', migration 0027); ambas as contagens filtram
  `origin='proactive'`.
- **BAIXO (namespace):** `idempotency_key` com prefixo `reactive:` reservado —
  `enqueueOutbox` lança se um enqueue proativo tentar usá-lo (colisão esconderia a
  perda do ledger via onConflictDoNothing).

## Rodada 2 — E.164 + híbrida + staff — corrigidos neste commit

- **ALTO (E.164):** o país default "55" corrompia `wa_id` internacional sem `+`
  (EUA `15551234567` → `+5515551234567`). → o CRM usa `toE164(raw)` SEM default
  (wa_id é sempre internacional); o parâmetro fica no core p/ telefone digitado
  local (uso futuro). Teste de regressão (EUA/UK).
- **MÉDIO (semântica skipped):** o fallback leniente (`phoneKey`) mandava dígitos
  inválidos ao CRM como chave, e "sem dígito" virava skip silencioso. → `toE164`
  estrito; sem dígito algum = 'skipped' (lead sem telefone); dígitos presentes
  porém E.164 inválido = **'failed' observável** + log de erro (bug de payload
  upstream não é mascarado). `phoneKey` removido (dead code + armadilha).
- **MÉDIO (híbrida, corte lexical):** a perna keyword cortava por `ts_rank` no
  mesmo topK — um hit lexical de cosseno alto podia ser descartado pelo rank. →
  OVERSAMPLING (topK*4) na perna keyword; ordenação final segue por cosseno.
- **MÉDIO (híbrida, dedup frágil):** `UNION` deduplicava pela linha inteira. →
  `UNION ALL` + `DISTINCT ON (id)` (dedup pela identidade do chunk).
- **BAIXO (staff):** email normalizado (trim+lowercase — unique de text é
  case-sensitive); 409 com mensagem genérica ("Email já cadastrado", detalhe só no
  log); detecção de unique pelo código Postgres 23505 (inclusive em `cause`) em vez
  de regex de mensagem.

## Confirmado limpo pelo Codex

- Sem injeção SQL (interpolações parametrizadas; `queryText` nunca vira SQL;
  vetor passa por `assertVectorDim` antes do literal).
- RLS: buscas sob `withTenant`/`withNiche`; `platform_staff` é caminho system
  atrás do `PlatformStaffGuard` (decisão explícita, ADR 0044).

## Estado

338 testes verdes (core 38, db 73, api 141 + demais). Typecheck 13 projetos + web
build 22 rotas.
