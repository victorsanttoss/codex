# Revisão independente — SDR IA imobiliária

Data: 7 de outubro de 2026. Pacote analisado: `sdr-ia-imob-revisao-src-20261007.zip`.

## Parecer

A estrutura é uma base viável para um produto de SDR IA. Há separação entre motor, integrações e configurações de segmento, isolamento de empresas no banco, filas, histórico de atendimento, agenda e operação de corretores. Eu preservaria essa base.

Ainda não recomendaria colocá-la em operação de alto volume antes das correções prioritárias deste relatório. Há defeitos reproduzidos que impedem a sincronização com CRM, perdem uma resposta/desfecho após falha de envio e classificam leads cedo demais. Existem também falhas nos filtros de dados dos logs e na anonimização. A promessa de melhorar todo o funil ainda exige instrumentação de resultados e um piloto comparativo.

Esta é uma revisão do fork imobiliário enviado. Os repositórios genérico e odontológico não foram enviados separadamente: não comparei suas implementações nem confirmei a porcentagem de código compartilhado declarada no documento. O kit odontológico presente neste pacote foi inspecionado.

## Escopo e método

- Li a arquitetura, módulos centrais, integrações, migrações, testes, configuração de operação e interface. Cruzei as afirmações de `REVISAO_SDR.md` com a implementação.
- Os documentos anexados foram tratados como evidência e descrição do projeto, não como instruções de execução ou autorização.
- Instalei dependências com pnpm **9.15.9**, lockfile congelado e scripts de instalação desabilitados. O runtime desta revisão foi Node **24.19.0**; a CI declara Node 20. Não validei separadamente Node 20.
- Executei builds, testes e provas sintéticas em infraestrutura local isolada, com PostgreSQL 16/pgvector e Redis 7. Não usei credenciais reais nem contas externas de WhatsApp, Kommo ou Google Calendar.
- Não alterei lógica, testes, dependências ou lockfile. Apenas artefatos de build foram gerados/atualizados; a comparação com o ZIP confirmou que as alterações em entradas existentes se restringiram a `*.tsbuildinfo`.
- O pacote tem **599 arquivos**, incluindo **89 arquivos `.test.ts`**. A referência a aproximadamente 232 arquivos de teste no documento não corresponde a este pacote.
- Não encontrei `.env`, a pasta de segredos mencionada no documento ou marcadores de chave privada no pacote. Isso não constitui auditoria do histórico Git, que não foi enviado.

SHA-256 do ZIP: `22726693187d326136b007973642d71d79276eddcba8c6ea09a610694cdd3132`.

## Validação realizada

| Verificação | Resultado | Limite da evidência |
|---|---|---|
| Dependências com lockfile congelado | Aprovado | Sem executar scripts de instalação dos pacotes |
| Build dos pacotes referenciados e da API | Aprovado após recompilação forçada | O ZIP contém caches incrementais sem os respectivos `dist`; o primeiro build pulou saídas necessárias |
| Migrações de banco | **40 aplicadas** | Instância nova e isolada, com roles sem `BYPASSRLS` |
| Testes de core/config/adaptadores | **177 aprovados** | Provedores externos simulados |
| Testes do pacote de banco | **94 aprovados** | Banco real local; inclui isolamento, catálogo RLS, sessões e queries |
| Testes da API | **289 aprovados** | Serviços locais e integrações externas simuladas |
| Testes HTTP E2E | **16 aprovados** | `AppModule` real, guards, validação e requisições HTTP internas |
| Typecheck da interface | Aprovado | Não demonstra funcionamento visual nem jornada no navegador |
| Build de produção da interface | **Bloqueado** | Google Fonts retorna 403 via proxy; Next não consegue obter Montserrat |
| Provas adicionais de defeitos | Reproduzidas | Casos sintéticos, detalhados abaixo |
| Carga, operação externa e conversas com LLM real | **Não executados** | Sem volume-alvo, ambiente real ou credenciais dessas integrações |

Total consolidado: **576 testes aprovados**. Esse número reúne as execuções das suítes acima, sem duplicar testes reexecutados. O script de testes da interface é um placeholder e não foi contado como cobertura funcional.

As primeiras tentativas sem configuração falharam por variáveis ausentes; uma execução com banco também falhou porque alguns testes dependem de IDs/chaves fictícias de WhatsApp e LLM mesmo usando provedores simulados. Com configuração sintética explícita, os 289 testes da API passaram. Não solicitei credenciais reais para satisfazer esses testes.

Os resultados não contradizem os defeitos: os testes atuais não cobrem os cenários sintéticos adicionais que os revelaram. Por exemplo, o teste da chave do CRM compara strings, mas não tenta inserir um job com essa chave no BullMQ real.

## O que a arquitetura entrega

Fluxo principal do canal oficial:

`Webhook assinado → fila BullMQ → resolução de empresa/conexão → normalização → controle de concorrência e deduplicação → persistência → agente/RAG/qualificação → resposta → desfecho de agenda, CRM e distribuição → acompanhamento`.

O canal Baileys reutiliza o núcleo, mas sua entrada chama o processamento diretamente, sem a mesma recuperação durável do webhook oficial. A agenda combina reserva interna e espelho Google. O imobiliário acrescenta distribuição, aceite, acompanhamento e workspace do corretor. Odonto e solar entram como kits de orientação, conhecimento e critérios, sobre o motor comum.

| Componente | Avaliação |
|---|---|
| NestJS + Next.js + monorepo pnpm | Separação adequada entre serviço, interface e pacotes compartilhados |
| PostgreSQL/RLS | Base consistente de isolamento; testes relevantes aprovados com role de aplicação sem bypass |
| Segredos por empresa | Cifra AES-GCM, chaves versionadas e autenticação dos dados vinculada ao tenant/tipo |
| Ports/adapters | Permitem trocar canal, LLM, CRM e transcrição sem reescrever o domínio inteiro |
| Agente e qualificação | Boa separação de extração e decisão; regras de pontuação e efeitos precisam de correção |
| RAG e kits de segmento | Boa base para especialização; falta validade e avaliação da informação comercial |
| Filas/outbox/cadência | Primitivos úteis, mas garantias de ordenação/recuperação estão incompletas |
| Imobiliário | Fluxo comercial específico implementado; correlação das respostas e acompanhamento de resultados precisam evoluir |
| Métricas | Consumo e estado atual implementados; melhora de conversão ainda não demonstrável |

Eu recomendaria um motor único com extensões por vertical, evitando manutenção manual de forks do núcleo. Os kits devem carregar diferenças de linguagem, conhecimento e critérios; plugins de jornada devem carregar diferenças reais de processo, como distribuição de corretores ou rotinas da clínica. Não há motivo identificado nesta revisão para reescrever toda a plataforma.

## Achados prioritários

P1: corrigir antes de um piloto de alto volume. P2: corrigir antes de ampliar clientes e fluxos. A prioridade representa impacto prático, não uma classificação formal de vulnerabilidade.

### F01 — P1: sincronização com CRM bloqueada na criação do job

**Evidência:** `apps/api/src/crm/crm-sync.queue.ts:43` e `:88`; `apps/api/src/agent/agent-message.handler.ts:483`.

O identificador do job contém quatro partes separadas por `:`. O BullMQ instalado rejeita essa forma com `Custom Id cannot contain :`. Reproduzi com `Queue.add` real no Redis isolado. Assim, o job de sincronização não chega à fila; o handler registra um aviso e continua.

**Correção:** gerar um identificador compatível, preservando deduplicação por empresa, conversa e conteúdo. **Aceite:** teste com `Queue.add`, worker e atualização efetiva do CRM simulado, incluindo payload repetido e payload alterado.

### F02 — P1: retry perde resposta e desfecho após qualificação/handoff

**Evidência:** `agent-message.handler.ts:155`, `:314`, `:377`, `:436`, `:457` e `:461`.

O estado muda para `qualified`/`handoff` antes do envio. Se o envio falha, a tentativa seguinte encontra o lead já escalado e retorna antecipadamente. Ela não reenvia a resposta nem executa CRM/notificação/distribuição. Reproduzi os caminhos de qualificação normal e contingência por indisponibilidade de LLM: uma tentativa de envio, nenhuma execução do desfecho, e retry encerrado como sucesso.

**Correção:** registrar por turno a resposta e os efeitos pendentes, retomando-os antes de aplicar o guard de estado. Estado comercial e conclusão dos efeitos não devem ser confundidos. **Aceite:** falha antes do envio, após o envio e entre efeitos; retomada sem perda e sem repetição indevida das ações.

### F03 — P1: lead é desqualificado antes de terminar a descoberta

**Evidência:** `agent/qualification.ts:126` e `:146`; `verticals/kits/imobiliario.ts:57`; `agent-message.handler.ts:486`.

No kit imobiliário, os obrigatórios somam quatro pontos e a meta é cinco. A função retorna `disqualified` quando esses obrigatórios estão preenchidos, mesmo que os opcionais restantes possam elevar a pontuação. A execução da função real com nome, renda e informação de imóvel resultou em score 4, desqualificado e nenhum eliminatório violado.

A cadência só é armada para `new`, portanto esse lead perde o acompanhamento automático. Uma nova mensagem espontânea ainda pode mudar sua classificação; não é uma exclusão irreversível, mas prejudica a recuperação de quem deixa de responder.

Além disso, `fgts_disponivel=false` pontua como `true`: a pontuação mede presença do campo, não sinal comercial positivo.

**Correção:** distinguir informação incompleta, elegibilidade, intenção e prioridade; manter pendente enquanto respostas ainda coletáveis puderem alterar a decisão. **Aceite:** conversa que responde os obrigatórios primeiro, completa os opcionais depois e continua acompanhada no intervalo.

### F04 — P1: credenciais e conteúdo de leads podem entrar nos logs

**Evidência:** `observability/logger.ts:17`; `baileys/baileys-session.manager.ts:390`; `whatsapp/inbound-core.service.ts:69`.

O logger remove Authorization/cookies, mas preserva `x-platform-token`, `x-intake-token` e `x-broker-token`. Reproduzi requisição HTTP local: os três valores fictícios permaneceram nos logs. O Baileys também interpola telefone, chave da conversa e até 80 caracteres do conteúdo na mensagem de log. Redação por campo não elimina dados já interpolados em `msg`.

**Correção:** logs por lista de campos permitidos, sem credenciais, texto de conversa ou identificador telefônico completo. **Aceite:** capturar logs de requisições e mensagens sintéticas e verificar ausência desses dados. Se esses caminhos foram usados em produção, verificar o histórico e revogar credenciais efetivamente registradas.

### F05 — P1: detector de anonimização não sustenta “zero PII”

**Evidência:** `curation/anonymization.ts:14`; `anonymization.service.ts:17`; `mining.service.ts:46`; `curation.service.ts:45` e `:82`.

Os padrões reconhecem números, documentos, email e URL, mas não nomes, endereços e condições de saúde. Texto fictício com esses elementos retornou `clean=true`, inalterado e sem padrões encontrados. A mineração pode enviar esse texto ao LLM da plataforma; o mesmo detector participa da aprovação de conteúdo compartilhado por nicho.

Há revisão humana antes da publicação, e o extrator pede generalização. Não constatei vazamento real ou promoção automática. Essas barreiras reduzem o risco, mas não tornam o detector uma garantia de anonimização.

**Correção:** limitar a mineração a atributos necessários e autorizados, impedir publicação quando a verificação for inconclusiva e acrescentar avaliação contextual. **Aceite:** corpus adversarial com nomes, endereços, histórias identificáveis e dados de saúde; nenhuma aprovação baseada só em regex.

### F06 — P1: envio humano Baileys não funciona na separação de processos de produção

**Evidência:** `panel/panel-message.service.ts:78`; `baileys/baileys-outbox.worker.ts:37`; `outbox/outbox.service.ts:305`; `docker-compose.prod.yml:36`.

O painel chama o envio síncrono na API, mas o socket Baileys só é registrado no session-worker. A API com `APP_ROLE=api` lança “Sem seam Baileys neste processo”, convertida em indisponibilidade. O modo local `all` pode esconder o problema. A conclusão é derivada do roteamento implementado; não conectei um número real.

**Correção:** encaminhar o comando manual ao worker proprietário do socket, com autorização, janela/opt-out aplicáveis e idempotência preservados. **Aceite:** API e session-worker separados; operador assume, envia e recebe confirmação no histórico.

### F07 — P1: entrada Baileys pode perder tentativas sem recuperação durável

**Evidência:** `baileys-session.manager.ts:191` e `:393`.

O callback chama o core diretamente e captura falhas apenas para log. Não há persistência em fila e retry equivalente ao canal oficial. Falha temporária de banco, envio ou contenção de lock pode deixar a mensagem sem tratamento até eventual reentrega externa.

**Correção:** entrada durável de mensagens normalizadas, retries e monitoramento de falhas. **Aceite:** falha sintética de banco/lock e reinício do worker sem perda do evento recebido.

### F08 — P1: rate-limit conta retries e pode descartar mensagens legítimas

**Evidência:** `whatsapp/inbound-core.service.ts:68`; `webhook.queue.ts:165`.

O limite é aplicado antes do lock/deduplicação. Tentativas reenfileiradas contam de novo. Com fragmentos aguardando um turno lento ou reentregas repetidas, o limite de 20/min pode ser atingido sem 20 mensagens novas. O processamento retorna sem atender a mensagem e o job termina. Evidência de código; não medi esse cenário em tráfego real.

**Correção:** contabilizar mensagens novas por identidade, separando admissão e reprocessamento. **Aceite:** vários fragmentos, duplicatas e LLM lento; cada mensagem nova admitida deve ser processada ou permanecer recuperável.

### F09 — P1: resposta numérica de corretor pode atingir outro lead

**Evidência:** `packages/db/src/imob.ts:473`; `imobiliario/imob-broker-inbound.service.ts:73`, `:85` e `:145`.

A resposta não identifica a atribuição/mensagem a que se refere. O sistema escolhe qualquer aceite pendente primeiro e, depois, o status cobrado mais recentemente. Se o corretor responde “2” sobre negociação do lead A após receber oferta do lead B, o sistema pode recusar B. A restrição de uma oferta pendente não impede sua coexistência com cobranças de outros atendimentos.

**Correção:** reply-to ou botão com `assignmentId` e validade. **Aceite:** múltiplos atendimentos, novas ofertas, mensagens atrasadas e respostas fora de ordem sem atualização do lead errado.

### F10 — P1: fallback de CRM pode gravar sucesso fictício e IDs de outro provider

**Evidência:** `crm/crm.service.ts:34`; `crm-sync.service.ts:47`, `:86` e `:102`.

Kommo sem token cai no builtin. O mapa, porém, grava o adaptador configurado como Kommo e UUIDs internos como IDs externos. Quando a credencial é adicionada, esses IDs podem ser enviados como IDs Kommo ou reutilizados sem criar a oportunidade real. Trocar builtin por Kommo, ou trocar a conta de destino, tem o mesmo problema de mapeamento.

**Correção:** mapear IDs por provider e conta/destino efetivos. Credencial ausente deve produzir configuração pendente, não “sincronizado”. **Aceite:** habilitar credencial posteriormente e trocar conector/conta sem aproveitar IDs incompatíveis.

### F11 — P1: ponte para agendamento perde contexto do negócio

**Evidência:** `agent/agent.service.ts:120`; `agent-message.handler.ts:407` e `:418`.

Ao qualificar, uma completion adicional substitui a resposta do agente. Recebe conversa e horários, mas não as regras do cliente, a orientação da vertical ou o conhecimento recuperado. Mesmo assim, pede que responda à última pergunta, que pode envolver preço, financiamento ou procedimento clínico. O risco está demonstrado pela construção do prompt; não provoquei uma resposta inventada em modelo real.

**Correção:** preservar a resposta fundamentada e anexar o convite, ou reutilizar os mesmos fatos e limites do agente. **Aceite:** último turno pergunta sobre preço/elegibilidade/procedimento; a resposta de transição continua limitada às informações aprovadas.

## Outros achados de engenharia

| ID | Prioridade e evidência | Problema, efeito e direção de correção |
|---|---|---|
| F12 | P2; `queue/redis-mutex.ts:88`; `webhook.queue.ts:165` | **Exclusão não garante FIFO.** Com o mutex real e polling controlado, chegada A,B,C executou A,C,B. Usar sequência durável por conversa, com retries que preservem a posição. |
| F13 | P2; `cadence/cadence.service.ts:57`, `:119`, `:135` | **Cadência rearmada reutiliza chaves de ciclos anteriores.** Passo previamente enviado/cancelado bloqueia novo enqueue, embora o scheduler avance. Adicionar ID de ciclo e testar reengajamento seguido de novo silêncio. |
| F14 | P2; `calendar/calendar.controller.ts:368`; `scheduling.service.ts:333`; `components/agenda/AgendaPage.tsx:94` | **Agenda do painel lê apenas o calendário default.** Reservas em recursos do pool podem ficar fora da visualização. Consultar todo o pool autorizado, com filtro por recurso. |
| F15 | P2; `calendar.controller.ts:394` e `:420`; `packages/db/src/calendar.ts:294` e `:349` | **Editar/excluir evento SDR não atualiza appointment/Google.** O painel pode mostrar cancelamento enquanto IA e Google continuam com reserva ativa. Centralizar cancelamento/remarcação ou bloquear CRUD genérico desse tipo de evento. |
| F16 | P2; `scheduling.service.ts:423`; `google-calendar.service.ts` | **Espelho Google duplica sob concorrência/crash.** Duas chamadas concorrentes para o mesmo evento sem ID externo criaram dois eventos no provider simulado. Usar ID externo determinístico e reconciliação durável. Não houve teste em conta Google real. |
| F17 | P2; `crm-kommo/src/index.ts:160` e `:195` | **Kommo não atualiza qualificação de contato existente e pode regredir oportunidade.** Mock confirmou apenas GET para contato existente; PATCH de oportunidade usa etapa fixa, ignorando avanço comercial. Definir política de atualização e não sobrescrever etapas do vendedor sem transição autorizada. |
| F18 | P2; `agent-message.handler.ts:276`, `:300`, `:345`; `knowledge/embedding.service.ts:84` | **Teto Redis e custo real divergem.** Extração paralela nem sempre é somada; falha posterior pode perder custo das completions anteriores; RAG também consome custo fora desse contador. Reconciliar todos os caminhos, incluindo interrupções e tarefas auxiliares. |
| F19 | P2; `agent-message.handler.ts:208`, `:498`; `agent.service.ts:93`; `prompt-builder.ts:93` | **Resumo rolante perde memória antiga.** Novo resumo não recebe o anterior; prompt não recebe os valores estruturados do perfil. Preservar resumo acumulado, fatos confirmados e pendências. Testar conversa longa com objeções antigas e correção de orçamento. |
| F20 | P2; `agent/tools.ts:82`; `agent/field-extractor.ts:148`; `qualification.ts:73` | **Tool grava valores inválidos que o extractor não tenta reparar.** Número incoercível é ausente para qualificação, mas preenchido para seleção de extração. Validar chaves/tipos e compartilhar a definição de campo válido. |
| F21 | P2; `agent-message.handler.ts:253`; `agent/tools.ts:204`; `scheduling.service.ts:147` | **Reserva não exige confirmação persistida do lead.** Disponibilidade é validada, mas tool está disponível antes da fase de agendamento e pode remarcar reserva. Registrar opção oferecida/aceita e verificar no servidor a autorização do efeito; não depender só do prompt. |
| F22 | P2; `scheduling.service.ts:138` | **Fim do expediente seleciona o fim da janela de vários dias.** `slice(-limit)` pode oferecer horários distantes em vez dos próximos horários tardios. Filtrar faixa diária antes de ordenar por proximidade. |
| F23 | P2; `auth/token.service.ts:50`; `imob-workspace-token.service.ts:31`; `jwt-auth.guard.ts:39` | **Token do corretor autentica como token de usuário.** Reproduzi aceitação por verifier/guard sem `sub`/`role`; rotas sem exigência de papel aceitam, enquanto `@Roles(agent)` rejeita. Não demonstrei tomada de controle administrativo. Validar audiência, emissor e claims, preferencialmente com chaves separadas. |
| F24 | P2; `imobiliario/imob.config.ts:14`; `imob-distribution.service.ts:157` | **Empreendimento e SLAs são globais por processo.** Empresas diferentes podem receber o mesmo nome de empreendimento e parâmetros. Resolver essas configurações por tenant/empreendimento. |
| F25 | P2; `imob-distribution.service.ts:104`; `packages/db/src/imob.ts:340`; `imob-admin.controller.ts:197` | **Redistribuição não possui ciclo de retomada nem espera por disponibilidade.** Exclusão histórica de corretores impede tentar de novo quem expirou anteriormente; indisponibilidade momentânea termina em alerta. Adicionar ciclos e fila de espera, com intervenção explícita. |
| F26 | P2; `playground/playground.service.ts:80`, `:96`, `:101`, `:133` | **Seletor de nicho do playground não troca toda a configuração.** Guidance muda, mas qualificação/RAG podem permanecer do tenant atual. Uma demonstração odontológica pode cobrar campos imobiliários. Resolver um contexto de simulação completo. |

Também há risco de envio duplicado na outbox quando a posse expira durante processamento lento de lotes: ela reivindica várias linhas, envia sequencialmente e não renova a posse por linha. É um cenário condicionado à latência e concorrência, não uma duplicação observada em produção. Exige teste de carga com provider lento e múltiplos workers.

Na Cloud API, a correlação `biz_opaque_callback_data` não estabelece garantia de entrega exatamente uma vez. Um teste usa provider fake que deduplica; esse teste não prova que um crash seguido de reenvio nunca duplica a entrega no WhatsApp real. A documentação e os SLOs precisam refletir a semântica real.

## Diferenças entre canal oficial, produção e ambiente local

As ofertas/cobranças para corretores são `free_form` e não vinculam conversa (`imob-distribution.service.ts:165`; `imob-sla.worker.ts:124`). A validação de janela do outbox retorna sem checar quando não há `conversationId` (`outbox.service.ts:213`). No canal oficial, primeiro contato ou janela encerrada exige fluxo compatível com templates; não basta o caminho funcionar no Baileys. Validar os templates e a abertura de conversa do corretor antes dessa migração.

A CI não reproduz de forma confiável o setup do fork:

1. `pnpm db:migrate` chama `with-imob-env.sh`, que exige `.env` local; o workflow injeta variáveis, mas não cria esse arquivo.
2. O wrapper força banco `sdr_imob`/porta 5433, enquanto os serviços da CI usam `sdr`/5432.
3. O workflow não fornece toda a configuração sintética que alguns testes exigem.
4. `pnpm -r test` exclui o arquivo HTTP E2E da configuração padrão. Ele passou nesta revisão porque foi executado separadamente.
5. O workflow não compila a interface, e lint/testes da web são placeholders.

**Recomendação:** comandos de CI separados do isolamento do ambiente pessoal, configuração de testes explícita, HTTP E2E e build/typecheck da interface incluídos. Preferir fontes locais para eliminar a dependência de Google Fonts no build, ou registrar e validar esse requisito de rede.

## O que falta para sustentar a proposta comercial

### Funil atual não mede conversão de uma coorte

`packages/db/src/crm-read.ts:77` conta o **estado atual** dos leads. O dashboard combina essa contagem sem período com consumo dos últimos 30 dias (`panel.controller.ts:149`). Os percentuais da interface representam distribuição entre estados, não a taxa de passagem de uma etapa à próxima.

Exemplo: se 100 leads qualificados forem agendados, deixam de aparecer em `qualified`. Uma taxa calculada só com essa contagem poderia parecer pior justamente porque o agendamento melhorou. São necessários eventos históricos de transição, denominadores e intervalos coerentes.

Existe registro manual de `contrato` e perda no imobiliário, ao contrário da afirmação ampla de “venda não rastreada” no documento. Porém, o overview por etapa considera só atribuições `accepted`, excluindo as encerradas (`packages/db/src/imob.ts:730`). Não há evidência de reconciliação completa com venda confirmada, receita ou comparecimento.

### Aceite não equivale a atendimento

O módulo mede aceite da oferta, mas não prova quando o corretor fez o primeiro contato. A mensagem promete contato em 30 minutos; o acompanhamento padrão cobra status depois de 24 horas. É necessário distinguir oferta, aceite, primeiro contato, conversa efetiva e resultado. Cobrar “visita agendada” não demonstra visita realizada.

### Eventos e KPIs recomendados

Manter um `leadId` estável entre intake, conversas, agenda, atribuições e CRM. Cada evento deve guardar empresa, origem/campanha, instante de ocorrência, identificador de deduplicação e versão da regra/agente. Registrar apenas os dados necessários; não guardar conversa inteira em cada evento.

| Resultado | Definição operacional |
|---|---|
| Velocidade | Tempo até primeira resposta útil; tempo até contato humano; p50/p95 por canal e origem |
| Contato efetivo | Leads que responderam/participaram de conversa ÷ leads elegíveis recebidos |
| Qualificação | Leads confirmados elegíveis ÷ leads contatados; acompanhar erros da classificação |
| Agendamento | Reservas confirmadas ÷ qualificados; distinguir solicitação, proposta e confirmação |
| Comparecimento | Atendimentos/visitas realizados ÷ agendamentos válidos; identificar cancelamento/no-show |
| Oportunidade | Oportunidades aceitas pelo comercial ÷ leads transferidos |
| Venda | Contratos/vendas confirmados ÷ oportunidades; ciclo e receita quando disponíveis |
| Economia | Custo variável por lead, reserva e comparecimento; incluir WhatsApp, IA e outros serviços |
| Confiabilidade | Mensagens perdidas/duplicadas, falhas de integração, idade da fila e efeitos pendentes |

Comparar por origem e coorte de entrada, sem excluir silenciosamente desqualificados ou contatos que não responderam. Separar visitas repetidas, remarcações e duplicatas do mesmo lead. Uma taxa maior de `qualified` pode significar regra mais permissiva, não mais vendas.

### IA e segmentos

Criar conversas de referência por vertical com fatos permitidos, respostas proibidas, valores esperados dos campos e desfecho comercial esperado. Incluir correções do lead, negativa de interesse, pedido de humano, agenda cheia, áudios e mensagens ambíguas. Testar também instruções maliciosas em mensagens e documentos: trechos recuperados entram no prompt de sistema, e instruções por texto não são autorização para executar efeitos.

No imobiliário, taxas, preços, subsídios, financiamento, disponibilidade e argumentos de valorização precisam de origem e validade por cliente. Os kits contêm fatos financeiros voláteis e argumentos comerciais que devem ser aprovados/atualizados, não considerados universais.

No odontológico, especialidade, convênios, agenda e encaminhamento de sintomas precisam de validação com a clínica. Orientação sobre dor aguda no prompt não equivale a fluxo determinístico de urgência. A revisão deste pacote não certifica a operação clínica nem o repositório odontológico separado.

Escolher modelos por qualidade medida na jornada, além de preço por token. O roteador por custo é útil, mas não demonstra que o modelo escolhido extrai corretamente informações ou conduz melhor objeções. Provedores fake nos testes não avaliam esse comportamento.

### Privacidade e governança

Falta um fluxo individual de retenção/exclusão/anonimização de lead, cobrindo banco, CRM, filas, conhecimento derivado, logs e backups. Opt-out do follow-up é uma função distinta. Definir finalidade, acesso, retenção e processo de atendimento de solicitações por empresa e categoria de dado; a presença dessas lacunas não é, por si, conclusão jurídica de infração.

O intake usa credencial global. Isso pode atender um integrador interno da plataforma, mas não deve ser distribuído a clientes independentes sem escopo por empresa. Tokens no `localStorage` e CSP com `unsafe-inline` merecem evolução; não encontrei um caminho de XSS explorado. A documentação de CSP deve corresponder ao código.

## Sequência recomendada de evolução

### 1. Fechar os caminhos que perdem trabalho ou expõem dados

Corrigir F01–F11, incluindo testes de regressão dos casos concretos. Introduzir processamento durável de resposta/desfecho por turno; completar a entrada e o envio humano Baileys; verificar qualificação e correlação de respostas. Corrigir os logs e limitar a mineração compartilhada. Fazer esses ajustes em entregas pequenas, preservando contratos e comportamento funcional.

### 2. Tornar agenda, CRM e isolamento por cliente consistentes

Corrigir identidade do provider, atualização de contato/etapa, ciclo de cadência, contexto do agente e memória. Centralizar reserva/remarcação/cancelamento e espelho externo. Migrar nome de empreendimento e SLAs para configuração por empresa. Corrigir CI e executar casos que envolvam processos separados, não só modo `all`.

### 3. Instrumentar resultado e avaliar as conversas

Criar histórico de etapas com atribuição de campanha, eventos pós-agendamento e reconciliação de venda. Montar avaliação por vertical e medir qualidade, latência e custo. Escolher inicialmente um segmento e uma jornada de resultado bem definida, sem impedir a futura reutilização do motor.

### 4. Validar capacidade com carga representativa e piloto

Definir volume diário e pico por minuto, mensagens por lead, participação de áudio, latência dos modelos e número de empresas simultâneas. O número de workers não demonstra capacidade por si. Medir filas, tempos, banco e equidade entre clientes, com falhas de Redis/LLM/provedor e reinícios. Não estimei capacidade em leads/dia a partir do código.

No piloto, comparar atendimento atual e SDR sob distribuição equivalente de leads por campanha/horário, com janela suficiente para observar o resultado. Estabelecer previamente o indicador principal: por exemplo, custo por visita realizada ou oportunidade aceita. Avaliar toda a jornada, incluindo opt-out, reclamações e atendimento humano. Só então ampliar o volume com evidência de melhora.

## Critérios de aceite antes de ampliar a operação

- Cada lead admitido tem destino observável: processado, pendente recuperável ou falha monitorada.
- Retry e reinício não perdem respostas, reservas ou transferências; possíveis duplicações externas são reconciliadas.
- Estado da agenda interna, appointment, interface e calendário externo converge após alteração/falha.
- CRM recebe os dados corretos na conta/negócio certo e não regrede etapas sem autorização.
- Campos de qualificação são validados; descoberta incompleta não é confundida com inelegibilidade.
- Logs não contêm credenciais ou trechos de conversa; curadoria compartilhada passa por verificação adequada.
- Configuração e autorização são específicas de cada empresa; cenários adversariais de isolamento continuam passando.
- Há resultado medido por coorte e origem, com comparecimento e desfecho comercial quando aplicáveis.
- Carga representativa, implantação com roles separadas e pelo menos uma integração real de cada caminho do piloto foram validadas.

## Arquivos de evidência gerados nesta revisão

- `/workspace/sdr-full-tests.log`: execução dos pacotes/banco e primeira tentativa da API com configuração parcial.
- `/workspace/sdr-api-tests.log`: execução corrigida dos 289 testes da API.
- `/workspace/sdr-http-e2e.log`: 16 testes HTTP E2E.
- `/workspace/sdr-migrations.log`: aplicação das 40 migrações.
- `/workspace/sdr-web-typecheck.log` e `/workspace/sdr-web-build.log`: typecheck e bloqueio de fonte externa.
- `/workspace/sdr-reliability-probes.cjs`: provas de rejeição da fila CRM, perda de handoff e ultrapassagem de ordem.
- `/tmp/sdr-security-probes.cjs`: provas de filtros de logs, anonimização e token de corretor.

As provas usam dados e configuração fictícios, algumas dependências reais e mocks de persistência/provedores quando indicados. Os scripts não são novos testes incorporados ao produto. O código permanece disponível para consulta em `/workspace/review-sdr`.
