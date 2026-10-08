# Implementação da primeira rodada — 7 de outubro de 2026

Esta entrega corrige a base de validação, logs, enfileiramento de CRM,
descoberta comercial e recuperação de turnos. Abrange **D00, D01, D04, D05 e uma
implementação inicial de D06** do plano. O produto segue em desenvolvimento,
sem clientes reais. A rodada tem escopo menor que o roadmap completo e não
comprova prontidão para alto volume ou melhora das taxas comerciais.

## Mudanças concretas

| Entrega | Comportamento após a alteração | Arquivos principais |
|---|---|---|
| D00 — validação | Node 24.19.0 e pnpm 9.15.9 fixados; CI migra com URLs injetadas, testa banco/Redis e HTTP E2E, faz typecheck e build web. Montserrat é local, com licença OFL preservada. | `package.json`, `.node-version`, `.github/workflows/ci.yml`, `scripts/ci/with-test-env.mjs`, `apps/web/app/layout.tsx`, `docs/CI.md` |
| D01 — logs | Serializers HTTP registram campos permitidos; tokens de plataforma/intake/corretor são removidos. Logs inbound Baileys usam referência de correlação, sem telefone/texto integral. Erros usam campos operacionais filtrados. | `apps/api/src/observability/logger.ts`, `logger.test.ts`, `apps/api/src/baileys/baileys-session.manager.ts`, `apps/api/src/whatsapp/inbound-core.service.ts` |
| D04 — CRM na fila | jobId não contém `:` e é determinístico por tenant, conversa e conteúdo normalizado. Queue.add e Worker são exercitados com Redis real e CRM simulado. Falhas continuam observáveis. | `apps/api/src/crm/crm-sync.queue.ts`, `crm-sync-queue.integration.test.ts` |
| D05 — descoberta | Obrigatórios preenchidos deixam o lead em descoberta quando campos restantes podem alcançar a meta. Tool, extractor e decisão compartilham coerção de valor; campo inválido pode ser reparado. `false` e zero são respostas presentes. | `apps/api/src/agent/qualification.ts`, `field-extractor.ts`, `tools.ts`, `agent-message.handler.ts`, `qualification.integration.test.ts` |
| D06 — retomada | Plano de resposta, decisão e checkpoints dos efeitos são persistidos. Retry recupera pendências mesmo depois de o lead virar qualificado/handoff. Há posse com prazo/token, revalidação de envio e recuperação por canal. | `packages/db/src/agent-turns.ts`, `apps/api/src/agent/agent-turn.service.ts`, `apps/api/src/crm/lead-outcome.service.ts`, `apps/api/src/whatsapp/agent-turn-recovery.service.ts` |

Pesos, metas e eliminatórios de qualificação existentes foram preservados. Uma
correção explícita válida enviada pela tool substitui o fato anterior; o extractor
paralelo não sobrescreve um valor válido que a tool já preencheu. Isso não equivale
a validar a interpretação de um modelo real em todas as conversas.

A deduplicação BullMQ vale enquanto o job está retido. Após sua remoção, o mesmo
conteúdo pode executar novamente; o destino externo continua precisando de
idempotência. Identidade por conta/provider e política de etapas do Kommo são D11.

Correlação por hash nos logs é **pseudonimização**, não anonimização dos dados.
Esta rodada não garante que todo o tratamento de dados do produto esteja anônimo;
curadoria compartilhada e retenção permanecem no backlog.

## Migrações e compatibilidade

- `0041_agent_turns.sql` acrescenta `agent_turns`: identidade única por empresa,
  conversa e evento, plano, estado da entrega, efeitos concluídos, tentativas e
  posse temporária. A decisão e o plano são salvos na mesma transação. FK exige
  conversa da mesma empresa; RLS é habilitada e forçada.
- `0042_agent_turn_scan.sql` acrescenta a leitura de varredura com
  `app.system_scan` local à transação. O helper de varredura retorna IDs de
  tenants ativos; planos são consultados depois sob o contexto do tenant.

As migrações são aditivas. Não reclassificam leads existentes, não reconstroem
turnos históricos e não apagam tabelas ou dados. O runner normal aplica todos os
arquivos SQL pendentes em ordem, inclusive 0041 e 0042. Use backup apropriado e
valide primeiro em banco de desenvolvimento antes de aplicar a um ambiente com
dados que precisam ser preservados.

## Como instalar a fonte atualizada ou o patch

O pacote de fonte não inclui `.env` real, chaves, dependências instaladas nem
caches de build. Mantenha credenciais no seu ambiente/configuração local.

Se recebeu a fonte completa, extraia em outro diretório e revise as diferenças
antes de incorporá-las ao seu checkout. Preserve seu `.git`, alterações locais e
configuração de ambiente. Se recebeu um patch, confira sua base e execute no
checkout correspondente, com `CAMINHO_DO_PATCH` apontando para o arquivo recebido:

```bash
git status --short
git apply --check "$CAMINHO_DO_PATCH"
git apply "$CAMINHO_DO_PATCH"
```

Instale **Node 24.19.0** e **pnpm 9.15.9**. Em banco novo de desenvolvimento,
inicie Postgres 16 com pgvector e Redis 7. Configure os nomes/senhas das roles em
`APP_DB_USER`, `APP_DB_PASSWORD`, `MIGRATOR_DB_USER`, `MIGRATOR_DB_PASSWORD`.
Configure a conexão administrativa do **banco de desenvolvimento** por `PGHOST`,
`PGPORT`, `PGDATABASE`, `PGUSER` e autenticação segura do psql; execute o init:

```bash
psql -v ON_ERROR_STOP=1 -f packages/db/sql/init/01-roles-and-extensions.sql
```

Em banco já inicializado, não repita a criação das roles: confirme propriedade do
schema, privilégios, pgvector/btree_gist e ausência de BYPASSRLS na role app.
Forneça `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL` e as demais variáveis
obrigatórias da aplicação com **suas próprias credenciais**, usando o exemplo
somente como referência de nomes. Segredos JWT precisam ser distintos e ter ao
menos 32 caracteres; a KEK precisa ter 32 bytes em base64. Não use os valores
sintéticos da CI para executar o produto.

```bash
pnpm install --frozen-lockfile
pnpm build:server
pnpm typecheck
pnpm db:migrate:env
pnpm build:web
```

`db:migrate:env` usa as URLs fornecidas. O comando antigo `db:migrate` continua
usando `.env` e `env.imob.sh`, com as portas pessoais do fork. Para repetir a
validação com serviços descartáveis e valores sintéticos, siga `docs/CI.md`:
`db:migrate:ci`, `test:ci` e `test:http` não requerem contas reais. O helper recusa
checkout com `.env` pessoal e exige URLs locais explícitas. Ele também habilita
`CRM_QUEUE_TEST_REDIS_URL` a partir do Redis local validado, para executar o teste
BullMQ real. Os testes criam e removem fixtures próprias no banco de teste.

## Recuperação de turnos e operação

Os estados do turno são `planning` → `ready` → `complete`. O plano persistido
contém a resposta e os efeitos necessários. A entrega tem estados separados:
`pending`, `sending`, `sent`, `suppressed` ou `uncertain`. Checkpoints evitam
repetir efeitos internos já registrados; CRM, notificação, agendamento e
distribuição continuam sujeitos ao contrato de idempotência do destino.

- **Cloud API:** `AgentTurnRecoveryService` roda no scheduler, com varredura a
  cada 15 segundos. Retoma planos `ready`, sem chamar o LLM novamente, usando a
  conexão ativa e a conta original da conversa. Revalida opt-out, takeover,
  posse e janela de atendimento antes de cada bolha. Janela encerrada suprime a
  resposta e registra `suppressed.window_closed`; não inicia retries infinitos.
- **Baileys:** a recuperação acontece no session-worker proprietário, com socket
  ativo da conta original. Não usa um socket de outra conta como alternativa.
- **Ordem/fairness:** recupera o primeiro turno pendente de cada conversa;
  predecessor com posse ativa bloqueia sucessores. Conversas com falhas são
  rotacionadas para não monopolizar o lote de outras conversas.
- **`not_sent`:** o transporte sabe que o envio não ocorreu; volta a `pending`
  para retomada. **`uncertain`:** pedido pode ter sido aceito, envio pode ter sido
  parcial, ou confirmação/persistência se perdeu; não há reenvio automático.
- Um crash em `sending` deixa a entrega `uncertain` ao recuperar a posse. Os
  efeitos internos pendentes podem continuar. Não se arma cadência a partir de
  uma resposta incerta.

**`complete` indica conclusão do processamento registrado, não comprova entrega
externa quando `replyStatus` é `uncertain`. Não há garantia de entrega externa
exatamente uma vez.** Entrega incerta exige conferência manual no canal/destino;
ainda não existe uma tela nem fluxo de resolução dessa ocorrência. Não altere o
estado para `pending` sem evidência e uma decisão operacional apropriada.

Operadores autorizados podem consultar a empresa correta pelas funções:

```ts
await runWithTenant({ tenantId }, () => listUncertainAgentTurns(50));
await runWithTenant({ tenantId }, () =>
  getAgentTurn(conversationId, externalMessageId),
);
```

Não imprima planos completos: eles podem conter conteúdo de resposta e dados do
contato. A varredura global de IDs de tenants não deve ser usada para expor planos.
Para diagnóstico por psql, conecte com a **role app**, configure `TENANT_ID` para
a empresa autorizada e use somente consulta dentro do contexto local:

```bash
psql -v ON_ERROR_STOP=1 -v tenant_id="$TENANT_ID" <<'SQL'
BEGIN;
SELECT set_config('app.tenant_id', :'tenant_id', true);
SELECT id, conversation_id, status, reply_status, attempts, last_error
FROM agent_turns
WHERE tenant_id = :'tenant_id'::uuid AND reply_status = 'uncertain'
ORDER BY created_at, id
LIMIT 50;
COMMIT;
SQL
```

Um turno que caiu **antes de salvar o plano** permanece `planning` e depende de
retry/reentrega do evento original. A varredura recupera apenas planos `ready`;
ela não recria uma resposta pela informação parcial de um turno sem plano.
Tools de reserva, atualização de campos, RAG e geração do LLM ainda podem ocorrer
antes de o plano ser salvo. Um crash nesse trecho pode exigir nova geração e
repetir trabalho/custos; a recuperação completa desse trecho e o ciclo completo
da agenda não estão concluídos nesta rodada.

## Evidências e limites

Validação D00 já executada: instalação com lockfile congelado em Node 24.19.0;
build web real (26 páginas), inicialização Next e HTTP 200 para login, WOFF2
Montserrat local e licença. O helper teve cenário positivo, rejeição de URLs
ausentes/remotas, role app superuser e bancos divergentes, além da propagação de
exit status verificada. A execução conjunta final usou banco de teste novo e
configuração sintética explícita, sem integrações puladas:

| Verificação | Resultado |
|---|---|
| Migrações em banco novo | Todos os 42 arquivos aplicados, incluindo 0041/0042 |
| Reexecução das migrações | Sucesso; arquivos já aplicados não foram repetidos |
| `pnpm build:server` após limpar caches incrementais | Sucesso |
| `pnpm typecheck` em todo o workspace | Sucesso |
| `pnpm test:ci` | 672 testes passaram: 177 em outros pacotes, 110 no DB, 385 na API; 102 arquivos de testes |
| `pnpm test:http` | 16 testes HTTP E2E passaram; AppModule real |
| Total automatizado | **688 testes passaram**, zero pulados |
| `pnpm build:web` e smoke Next | Sucesso; 26 páginas; login, WOFF2 e licença HTTP 200 |

O painel ainda não tem uma suíte automatizada própria de navegação: build,
typecheck e smoke não substituem testes dos fluxos completos da interface.

As suítes acrescentadas cobrem logger real, Queue.add/Worker BullMQ, descoberta
com campos inválidos, persistência de turnos, concorrência, fencing, restart,
opt-out, janela encerrada e entrega incerta. A existência do teste não substitui
seu resultado. As contagens acima correspondem à execução completa desta fonte,
com PostgreSQL e Redis reais e destinos externos simulados.

Não foram usadas contas reais de WhatsApp, CRM, Calendar nem modelos de IA reais.
Dockerfiles estão alinhados à runtime, mas construir/iniciar essas imagens e
executar o workflow no GitHub Actions são validações adicionais. Não houve
publicação, deploy em clientes, teste de carga representativo ou comparação
comercial de um piloto.

## Próximas entregas

As prioridades continuam sendo D02 (conter curadoria compartilhada e suas
garantias de anonimização), D03 (separar tokens de usuário/corretor) e D07 (entrada
durável, ordem e limites). Depois seguem D08–D10 (envio humano Baileys, correlação
de corretor/redistribuição e ciclos de cadência), D11–D12 (CRM e agenda), D13–D16
(contexto/avaliação da IA, custos, configuração por empresa e ciclo dos dados),
D17 (funil por eventos) e D18 (piloto e capacidade).

Antes do piloto, acrescente tratamento operacional para entrega incerta e falhas
permanentes. Falhas de retomada seguem consultáveis/logadas e podem ser tentadas
novamente; ainda falta um fluxo de intervenção com política explícita de
tentativas e resolução. O indicador imobiliário proposto permanece visitas
realizadas por lead recebido, acompanhado de custo por visita; esta rodada não
mede nem demonstra ganho nesse indicador.
