# ADR 0031 — Curadoria humana + anonimização (zero PII no nicho)

## Contexto
Promover automaticamente o que "funcionou" num tenant para o nicho compartilhado é
perigoso: vazaria PII/identidade (LGPD + concorrentes no mesmo nicho) e poderia
poluir o nicho com ruído.

## Decisão
- **Curadoria humana é portão obrigatório**: nada vira `niche_knowledge` sem passar
  por `pending → approved` por um curador. `promote()` **lança** se o candidato não
  está `approved`. Sem auto-promoção (testado).
- **Anonimização em camadas**: 1ª camada **determinística** (regex de e-mail,
  telefone/E.164, CPF, CNPJ, valores monetários) que **redige** antes de gravar o
  candidato; 2ª camada (verificação por LLM) é hook documentado. `createCandidate`
  **recusa** se sobrar PII; `promote` **re-checa** PII antes de gravar no nicho.
  Conservador: na dúvida, redige.
- **Padrão generalizável, não verbatim**: a mineração extrai um PADRÃO reutilizável
  (tratamento de objeção, pergunta de qualificação, vocabulário, FAQ), nunca a
  transcrição crua. O LLM é instruído a responder `NONE` quando não há padrão seguro.
- **Auditoria sem exposição**: `source_tenant_id`/`source_refs` ficam no candidato
  **só para accountability** — nunca chegam ao `niche_knowledge` nem a outro tenant.

## Consequências
O nicho contém apenas insight anonimizado e curado. O risco de vazamento de PII/
identidade é barrado por construção (redação + recusa + re-checagem + gate humano) e
provado por teste de ausência de PII no que é promovido. O custo de curadoria é da
**plataforma** (ADR 0032), nunca do tenant.
