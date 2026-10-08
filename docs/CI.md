# CI e reprodução da validação

Runtime: **Node 24.19.0**, declarado em `.node-version`, CI e Dockerfiles. O
`packageManager` fixa **pnpm 9.15.9**. Os builds da API e web, o typecheck e os
testes devem ser executados nessa versão; uma imagem Docker alterada só é
considerada validada depois de ser construída e iniciada.

## Configuração de teste

O job usa Postgres 16 com pgvector e btree_gist, Redis 7 e banco descartável
`sdr_ci`. O init SQL cria duas roles distintas **sem BYPASSRLS**, sendo o migrator
dono do schema. Nunca use um banco de clientes para executar a suíte.

`scripts/ci/with-test-env.mjs` exige URLs locais explícitas e injeta valores
sintéticos para JWT, KEK, webhook, signup e provedores simulados. Não é necessário
configurar nenhuma conta real. O script recusa checkout com `.env`, para impedir
que as configurações Vitest importem segredos pessoais. Os destinos HTTP de
WhatsApp, embeddings e transcrição apontam para loopback sem serviço; os testes
que usam esses providers devem injetar simuladores. Anthropic usa chave fictícia
e as suítes injetam provider falso; isso não valida um modelo externo real.
O helper define `CRM_QUEUE_TEST_REDIS_URL` com a `REDIS_URL` local já validada,
ativando a regressão com Queue.add/Worker BullMQ reais e CRM simulado. A CI não
deixa essa suíte opcional de fora por falta da variável específica.

O comando de desenvolvimento `pnpm db:migrate` continua carregando `.env` e
`env.imob.sh`, que isolam o fork em `sdr_imob`/5433 e Redis/6380. A CI usa
`pnpm db:migrate:ci`, que chama `db:migrate:env` com URLs injetadas, sem esse wrapper.
Não altere `env.imob.sh` para adaptar um runner de CI.

## Reprodução em checkout limpo

Depois de instalar Node e pnpm fixados, iniciar serviços descartáveis e executar
`packages/db/sql/init/*.sql` como administrador **do banco de teste**, exporte as
URLs das roles que foram criadas:

```bash
export DATABASE_URL=postgres://sdr_app:ci_app_pw@127.0.0.1:5432/sdr_ci
export MIGRATION_DATABASE_URL=postgres://sdr_migrator:ci_migrator_pw@127.0.0.1:5432/sdr_ci
export REDIS_URL=redis://127.0.0.1:6379
export NEXT_TELEMETRY_DISABLED=1

pnpm install --frozen-lockfile
pnpm build:server
pnpm typecheck
pnpm db:migrate:ci
pnpm test:ci
pnpm test:http
pnpm build:web
```

As senhas acima são públicas e apenas ilustram infraestrutura local de teste.
Os nomes/portas do banco e Redis podem ser outros, desde que locais e
descartáveis; o helper não substitui essas URLs. `test:ci` exige configuração de
banco, impedindo que a falta de URLs produza uma execução verde com integrações
puladas. `test:http` usa a config SWC dedicada, com metadata de decorators exigida
pelo AppModule Nest real. Preserve saída e código de saída de cada comando; se
houver testes pulados, registre-os e sua razão.

Não distribua `node_modules`, `dist`, `.next` ou `*.tsbuildinfo` no pacote de fonte.
Um cache incremental sem os outputs pode fazer `tsc -b` deixar de gerar arquivos
necessários. `.gitignore` e `.dockerignore` excluem esses arquivos; um ZIP deve
aplicar as mesmas exclusões.

## Fonte da interface

Montserrat permanece a tipografia do design V4 (pesos 400–800, caracteres latinos).
`next/font/local` usa o WOFF2 de `@fontsource-variable/montserrat@5.3.0`, instalado
via npm/pnpm e verificado pelo hash de integridade do lockfile. O build não precisa
buscar CSS ou fontes em Google Fonts. A licença **SIL Open Font License 1.1** e os
créditos dos autores acompanham o pacote e `apps/web/public/fonts/Montserrat-OFL.txt`.
A fonte é servida pelo próprio Next, mantendo preload, `font-display: swap` e
`--font-montserrat`. Dois workers de prerender limitam o consumo no runner de CI.

## Limites da validação

Suítes com APIs simuladas comprovam contratos internos, não entrega no WhatsApp,
qualidade do LLM, integração em contas reais de CRM/Calendar nem capacidade sob
carga. O workflow só foi executado remotamente depois de haver uma execução do
GitHub Actions; reproduzir os comandos localmente não equivale a publicá-lo.
