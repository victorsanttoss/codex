# Plano de melhorias — produto SDR IA

Base: revisão independente de 7 de outubro de 2026, do fork imobiliário. Os IDs F01–F26 remetem a `REVISAO_INDEPENDENTE_SDR_20261007.md`.

## Objetivo e ponto de partida

Transformar a base atual em um produto que atende leads com confiabilidade, conduz uma jornada comercial definida e demonstra resultado para o cliente. Preservar motor, isolamento e adaptadores existentes; evoluir os contratos que hoje permitem perda de trabalho e inconsistência.

Situação confirmada pelo responsável pelo produto: **em desenvolvimento, sem clientes reais**. A execução inicial será em ambiente local/de teste, fechando a primeira jornada completa antes do piloto. Não é preciso tratar esta rodada como um rollout sobre uma operação de clientes já ativa.

Proposta inicial: validar a jornada imobiliária, porque é a implementação enviada e revisada. O núcleo deve continuar reutilizável pelo odontológico. A prioridade comercial definitiva permanece uma decisão do responsável pelo produto.

Jornada proposta:

`Lead recebido → conversa efetiva → qualificação → transferência → contato do corretor → visita confirmada → visita realizada → oportunidade → contrato`.

A transferência para humano integra a jornada. Nem todo lead qualificado precisa agendar automaticamente; a configuração do cliente deve definir se o próximo passo é agendamento ou atendimento humano.

Resultado principal sugerido para o primeiro piloto: **visitas realizadas por lead admitido**, acompanhado de custo por visita e oportunidades aceitas. Usar o resultado que a empresa consegue confirmar com qualidade. Não prometer aumento de vendas a partir de melhora apenas no agendamento.

## Como executar

- Cada entrega abaixo é um item de trabalho. Subentregas da agenda, CRM e IA devem ser executadas separadamente.
- Claude Code implementa uma entrega; os testes verificam o cenário concreto; uma revisão independente confere o diff e as evidências.
- O responsável pelo produto decide regras de qualificação, política de acompanhamento e indicador do piloto. O cliente confirma critérios comerciais, fatos do negócio e resultados pós-atendimento.
- O plano não depende de datas inventadas. Avançar pelos critérios de aceite; estimar prazo após inspecionar o código atual e o tamanho das migrações.
- Estado atualizado em **8 de outubro de 2026**: D00, D01, D04 e D05 implementados; D06 tem implementação inicial com recuperação de planos persistidos. A primeira rodada passou em 688 testes, além de builds e typecheck. D02, D03 e D07–D18 continuam pendentes; D06 ainda exige tratamento operacional de entrega incerta e recuperação antes de persistir o plano. Consulte [a entrega e os limites da primeira rodada](IMPLEMENTACAO_RODADA_1.md).

## Ordem de execução

| Fase | Resultado | Entregas | Condição para avançar |
|---|---|---|---|
| 1. Correções imediatas | Validação reproduzível, logs protegidos, CRM enfileirando e qualificação correta | D00–D05 | Cenários reproduzidos viram testes de regressão; regras comerciais explícitas |
| 2. Recuperação e canais | Turnos, entrada, atendimento humano e acompanhamento recuperáveis | D06–D10 | Falha/reinício não vira sucesso silencioso; mensagens admitidas têm destino observável |
| 3. Consistência das integrações | CRM, agenda e operação por empresa convergem | D11, D12, D15 | IDs, transições, cancelamentos e configuração permanecem corretos em retries e concorrência |
| 4. Qualidade e governança | Contexto da IA, custos e ciclo dos dados verificáveis | D13, D14, D16 | Conversas de referência passam; custos conciliados; dados tratados por finalidade e retenção |
| 5. Medição | Histórico comercial e métricas por origem/coorte | D17 | Contagens reconciliadas e resultados pós-handoff disponíveis |
| 6. Piloto e expansão | Resultado demonstrado e capacidade medida | D18 | Integrações reais do piloto, comparação e carga representativa validadas |

A especificação de métricas D17 começa cedo; a implementação deve reutilizar as identidades estabilizadas em D06. D01, D02 e D03 podem avançar em paralelo com a validação. Uma correção pequena como D04 não precisa esperar a conclusão de toda a fase.

## Três contratos que orientam as mudanças

### 1. Identidade e ordem da mensagem

Definir uma identidade estável a partir de empresa, conexão/canal e identificador do evento do provider. Deduplicar reentregas dessa identidade, sem confundir duas mensagens novas com o mesmo texto. Preservar ordem de admissão por conversa durante retries. Registrar a origem e o instante informado pelo provider quando disponível; ordem de recebimento e ordem de ocorrência podem diferir.

Separar limite de admissão de novas mensagens do controle de execução de mensagens já admitidas. Tentativa, espera por lock e retry não são mensagens novas.

### 2. Turno, resposta e efeitos duráveis

Separar estado comercial do lead e conclusão do processamento. Um lead `qualified` não significa que resposta, notificação, reserva e sincronização terminaram.

Persistir identidade do turno, resposta planejada e efeitos necessários. Cada efeito tem identidade, destino, estado e evidência de execução. Retomar pendências antes de concluir que o turno acabou; revalidar opt-out, takeover e autorização antes de enviar algo que ficou pendente.

Se um provider recebeu uma requisição mas a resposta se perdeu, tratar o envio como incerto e reconciliar conforme a capacidade do provider. Não prometer entrega externa exatamente uma vez. Falhas permanentes devem ficar visíveis para intervenção; não criar retry infinito.

### 3. Identidade do destino externo

Vincular IDs externos ao provider e à conta/destino efetivos. Um ID do CRM interno não é um ID Kommo. Rotacionar um token na mesma conta não cria um novo destino; trocar a conta cria.

Jobs pendentes precisam identificar o destino/revisão da configuração com que foram gerados. Uma alteração de configuração não pode redirecioná-los silenciosamente. Registros legados suspeitos precisam de diagnóstico e reconciliação, não exclusão geral seguida de recriação.

## Backlog com critérios de aceite

### D00 — Tornar validação e CI reproduzíveis

**Escopo:** comandos independentes do `.env` pessoal e das portas do fork; configuração sintética dos testes; HTTP E2E dedicado; build/typecheck da interface. Remover caches incrementais do pacote de fonte ou garantir recompilação em ambiente limpo. Resolver fonte externa no build com configuração suportada, preferindo fonte local.

**Aceite:** checkout limpo instala com lockfile, migra banco isolado e executa pacotes, API e HTTP E2E; web compila; resultados incluem contagem real de testes. Validar a versão de Node adotada no projeto/CI: os 576 testes anteriores foram executados em Node 24, enquanto a CI declarava Node 20.

**Dependências:** nenhuma. É a base das demais entregas.

### D01 — Proteger logs — F04

**Escopo:** serializers por campos permitidos; remoção dos tokens de plataforma/intake/corretor e de telefone/texto interpolados em logs.

**Aceite:** requisição e inbound fictícios capturados pelo logger não preservam credenciais, telefone integral ou texto. Erros ainda contêm informação operacional útil sem esses dados.

**Dependências:** nenhuma. Se houve uso real desses caminhos, o responsável pela operação verifica exposição histórica e define revogação das credenciais afetadas.

### D02 — Restringir curadoria compartilhada — F05

**Escopo:** impedir aprovação baseada apenas em regex; minimizar dados antes de extração; verificação contextual e revisão de publicação. Usar uma configuração suportada para controlar a mineração, sem alterar silenciosamente o funcionamento de clientes existentes.

**Aceite:** nomes, endereços, narrativas identificáveis e dados de saúde não recebem aprovação automática como anônimos; resultado inconclusivo impede publicação. Registrar finalidade e limitações do tratamento.

**Dependências:** nenhuma para contenção e testes; D16 para política completa do ciclo dos dados.

### D03 — Separar tokens de usuário e corretor — F23

**Escopo:** validar tipo, audiência, emissor e formato dos claims; definir migração/compatibilidade dos tokens existentes; garantir que revogação do corretor não tenha outro caminho de autenticação válido.

**Aceite:** token de corretor é rejeitado em autenticação de usuário, inclusive rotas sem exigência de papel; usuário não autentica como corretor; tokens legítimos continuam funcionando no fluxo correto.

**Dependências:** nenhuma. Não trocar segredos reais automaticamente.

### D04 — Desbloquear a fila de CRM — F01

**Escopo:** jobId aceito por BullMQ e deduplicação por empresa/conversa/conteúdo. Não depender do histórico de jobs já removidos para prometer deduplicação permanente.

**Aceite:** Redis, `Queue.add` e worker reais com CRM simulado; payload idêntico em voo não duplica, payload alterado sincroniza, erro fica observável.

**Dependências:** D00 para execução reproduzível. A consistência do destino será concluída em D11.

### D05 — Validar campos e corrigir descoberta comercial — F03, F20

**Escopo:** validador/coerção compartilhados entre tool, extractor e decisão. Manter pendente enquanto informação ainda coletável puder alterar a decisão; tratar eliminatórios preenchidos e inválidos de forma explícita. Separar presença de resposta de prioridade comercial.

**Aceite:** obrigatórios respondidos primeiro não desqualificam prematuramente; opcionais podem completar decisão; `false`, número inválido e correção de renda têm tratamento coerente; acompanhamento continua enquanto apropriado.

**Dependências:** D00. Critérios comerciais e migração das configurações precisam de decisão explícita do produto; não reclassificar retroativamente toda a base sem essa regra.

### D06 — Tornar resposta e desfechos recuperáveis — F02

**Escopo:** implementar o contrato durável de turno, checkpoints por efeito e retomada. Considerar notificação, CRM, distribuição, resposta e reserva; reusar a infraestrutura existente quando possível.

**Aceite:** falha antes do envio, resposta de provider perdida, crash entre efeitos e expiração de posse têm recuperação/reconciliação definida. Qualificação normal e contingência de LLM não perdem handoff. Guard de lead escalado não encobre trabalho pendente. Opt-out/takeover posterior é revalidado.

**Dependências:** D00; D04 e D05 ajudam a validar os caminhos, mas não substituem o desenho do turno. Alterar somente a ordem do `applyLeadDecision` não resolve todas as janelas de falha.

### D07 — Unificar entrada durável, ordem e limites — F07, F08, F12

**Subentregas:** D07a, admissão/deduplicação por identidade; D07b, Baileys em fila durável; D07c, ordenação por conversa e retries.

**Aceite:** mensagens A,B,C admitidas nessa ordem não se ultrapassam por requeue; duas mensagens novas iguais continuam distintas; reentregas não consomem novamente a cota; banco/LLM lento e reinício não descartam eventos admitidos. Falhas permanentes são monitoradas e recuperáveis por intervenção.

**Dependências:** contrato D06. Um único desenho deve orientar as três subentregas.

### D08 — Encaminhar envio humano ao worker Baileys — F06

**Escopo:** comando autorizado da API para o proprietário do socket, usando a mesma infraestrutura de envio e seus estados. Atualizar contrato/interface para mostrar pendente, enviado e falha quando necessário.

**Aceite:** com `api` e `session-worker` separados, operador assume e envia; confirmação aparece no histórico; duplo clique/retry não cria novo comando; worker indisponível produz estado útil e recuperável.

**Dependências:** D06; admissão/identidade de D07 quando compartilhada. Não introduzir uma segunda outbox independente.

### D09 — Correlacionar corretor e permitir redistribuição — F09, F25

**Subentregas:** D09a, resposta com referência à atribuição; D09b, ciclo de distribuição e espera por disponibilidade.

**Aceite:** resposta tardia do lead A nunca aceita/recusa B; referência ausente/ambígua pede esclarecimento. Corretores disponíveis voltam a ser elegíveis em um novo ciclo autorizado; indisponibilidade temporária mantém o lead em espera observável, sem loops ilimitados ou atribuições simultâneas indevidas.

**Dependências:** D06 e configuração D15. Incluir compatibilidade dos mecanismos de resposta nos canais do piloto.

### D10 — Criar ciclos de cadência — F13

**Escopo:** identidade de ciclo de acompanhamento; parar/rearmar e distinguir jobs de ciclos anteriores. Definir quais estados incompletos/nutrição podem receber acompanhamento e quais exigem pausa.

**Aceite:** lead recebe passo inicial, responde, entra em novo ciclo e pode receber novo passo; job antigo não executa como parte do novo ciclo; opt-out, takeover e resolução prevalecem.

**Dependências:** D05, D06 e D07. Não reutilizar a chave vitalícia `conversa+passo` como identidade de um novo ciclo.

### D11 — Tornar CRM consistente — F10, F17

**Subentregas:** D11a, provider/conta efetivos e reconciliação legada; D11b, atualizar contatos; D11c, política de transição de etapa.

**Aceite:** falta de credencial aparece como configuração pendente, sem sucesso Kommo fictício. Troca de provider/conta não reutiliza IDs incompatíveis. Habilitar credencial depois não duplica silenciosamente negócios. Contato existente recebe informações permitidas; nova sync não regrede etapa do vendedor. Jobs antigos preservam ou reconciliam seu destino.

**Dependências:** D04 e D06. Concluir D11a antes de alterar a política de atualização do adaptador.

### D12 — Fechar o ciclo da agenda — F14, F15, F16, F21, F22

**Subentregas:** D12a, oferta/aceite verificáveis e seleção de horários; D12b, reserva/remarcação/cancelamento centralizados; D12c, espelho externo recuperável; D12d, interface do pool.

**Aceite:** reserva/remarcação exige escolha válida do lead e recurso autorizado; opção expirada é rejeitada; preferência por fim do dia oferece o próximo dia adequado. Operador vê os recursos do pool. Cancelar/mover atualiza appointment, disponibilidade, contexto da IA e espelho. Concorrência e timeout não deixam eventos Google órfãos; usar ID compatível com o provider e reconciliação.

**Dependências:** D05 e D06. Definir uma fonte de verdade coerente com a arquitetura existente; não manter operações concorrentes independentes no CRUD genérico e na SDR.

### D13 — Preservar contexto e avaliar a IA — F11, F19, F26

**Subentregas:** D13a, ponte de agendamento com os mesmos fatos/limites; D13b, resumo anterior e perfil estruturado no contexto; D13c, playground com nicho/qualificação/RAG coerentes.

**Aceite:** pergunta sobre preço/financiamento/procedimento na transição continua fundamentada; conversa longa preserva informações e suas correções; simulação de outro segmento não combina campos e conhecimento incompatíveis. Suite de referência avalia valores extraídos, ações e desfechos, não apenas presença de campos.

**Dependências:** D05/D06; D15 para contexto por empresa. D13a é prioritária e pode preceder o restante da fase 4, após estabilizar o handler.

### D14 — Conciliar custo e limites — F18

**Escopo:** registrar uso de extração paralela, RAG, resumos, pontes, transcrição e chamadas concluídas antes de falha. Separar contador de proteção e livro de custos, explicitando seu comportamento em indisponibilidade.

**Aceite:** caminhos com tool bem-sucedida, handoff e falha no meio do loop contabilizam consumo; reserva e reconciliação do limite não ocultam custo. Custos dos canais/serviços usados entram na análise econômica.

**Dependências:** D06 e contexto final D13. Não definir preço de venda com base em custos incompletos.

### D15 — Resolver configuração por empresa — F24

**Escopo:** empreendimento, SLAs e políticas imobiliárias por tenant. Definir comportamento para empresas existentes sem configuração; considerar empreendimento explícito se um cliente operar vários. Intake destinado a clientes requer credencial com escopo por empresa.

**Aceite:** duas empresas simultâneas recebem nomes/regras corretos; caches e workers respeitam o contexto; uma empresa não escolhe outra pelo payload. Não preencher todos os tenants com o mesmo empreendimento padrão durante a migração.

**Dependências:** D03 para limites de identidade; pode avançar antes de D09, D13 e D17.

### D16 — Implementar o ciclo dos dados

**Escopo:** política de retenção por finalidade/categoria, pedido individual de exclusão/anonimização, tratamento de filas, CRM, curadoria, logs e backups. Exportação e acesso devem respeitar a empresa solicitante.

**Aceite:** solicitação fictícia é rastreada da origem até as cópias aplicáveis; limites de eliminação em backups e sistemas externos são explícitos. Opt-out de mensagens permanece separado de exclusão dos dados. Não apagar registros reais como parte de testes.

**Dependências:** D02/D03, identidades D06/D11 e decisão de política pelo responsável pelo produto/cliente.

### D17 — Medir o funil por eventos

**Escopo:** identidade do lead, origem/campanha, eventos de transição e resultados depois do handoff. Registrar fonte, tempos, versão de regras/agente e deduplicação. Interface deve distinguir estado atual, histórico e conversão da coorte.

**Aceite:** mover qualificado para agendado não reduz o número histórico de qualificados. Remarcação não conta dois leads convertidos. Aceite do corretor não conta como contato nem comparecimento. Contratos encerrados aparecem nos resultados. Testes reconciliam eventos e dashboard.

**Dependências:** desenho iniciado com D00; implementação usa identidades D06/D11/D12/D15. Confirmar qual informação vem de CRM e qual depende de registro humano.

### D18 — Validar piloto e capacidade

**Subentregas:** D18a, operação integrada de uma jornada; D18b, avaliação de conversas reais autorizadas; D18c, carga e falhas; D18d, comparação de resultados.

**Aceite:** todos os caminhos utilizados no piloto validados em ambiente apropriado, incluindo templates/janela do canal oficial quando aplicáveis. Capacidade medida com volume diário, pico, mensagens por lead, áudio e latência representativos. Resultado comparado com grupo de referência e janela de observação suficiente.

**Dependências:** entregas relevantes ao canal/fluxo escolhido e D17. Se o piloto não usa um componente, registrar a exclusão de escopo e a condição para ativá-lo depois; não dizer que foi validado.

## Medição mínima do piloto

Eventos mínimos: `lead_received`, `conversation_engaged`, `qualification_completed`, `handoff_requested`, `broker_assigned`, `broker_accepted`, `broker_first_contact`, `appointment_confirmed`, `appointment_rescheduled`, `appointment_cancelled`, `appointment_attended`, `appointment_no_show`, `opportunity_accepted`, `contract_confirmed`, `lead_lost`.

Esquema proposto: `eventId`, `tenantId`, `leadId`, tipo, `occurredAt`, `recordedAt`, origem, ID do evento na origem, referências a conversa/agendamento/atribuição, campanha, grupo do piloto, versão de regra/agente e propriedades mínimas. Não replicar a conversa integral em cada evento.

| Indicador | Cálculo e cuidados |
|---|---|
| Contato efetivo | Leads únicos com conversa ÷ leads admitidos |
| Qualificação | Leads confirmados elegíveis ÷ leads com conversa; acompanhar erro de classificação |
| Agendamento | Leads com reserva confirmada ÷ qualificados; separar agendamento de solicitação |
| Comparecimento | Agendamentos realizados ÷ população definida de agendamentos já vencidos; cancelamento/no-show visíveis e regra de remarcação definida previamente |
| Resultado principal | Leads com visita realizada ÷ todos os leads admitidos no grupo; evita melhora artificial por exclusão de desqualificados |
| Venda | Contratos confirmados ÷ oportunidades, dentro de janela adequada ao ciclo |
| Economia | Custo variável da coorte ÷ visitas realizadas/oportunidades da mesma coorte |
| Confiabilidade | Idade da fila, pendências, falhas, duplicações e p50/p95 de resposta/contato humano |

Agrupar pelo ingresso do lead e pela origem/campanha. Mostrar leads ainda em acompanhamento. Regras de duplicidade, admissão e janela precisam ser fixadas antes da análise; leads que não responderam ou foram desqualificados pela IA não somem do indicador principal.

Preferir controle contemporâneo, com alocação aleatória persistida e equilíbrio por campanha/horário/empreendimento. Analisar o grupo originalmente atribuído, inclusive transferências para humano. Se usar comparação observacional, declarar diferenças e limites. Estimar duração/amostra a partir do baseline e efeito mínimo útil; não inventar prazo ou ganho percentual.

## Controle das entregas

Estados sugeridos: **a fazer → em execução → em revisão → validado em ambiente de teste → liberado no ambiente apropriado → resultado observado**.

Um item validado em teste não significa publicado nem comprovado com clientes. Cada entrega deve informar: problema, mudança, migração/configuração, evidência, limitações e retomada/rollback aplicável. Corrigir um defeito não autoriza afirmar que todo o produto está pronto.

Evitar alterações simultâneas no mesmo contrato:

- `agent-message.handler.ts`: D06 primeiro; depois contexto D13 e custo D14.
- Entrada/filas: D07a–c orientadas pelo mesmo desenho.
- CRM: D11a define identidade antes de D11b–c.
- Agenda: D12a–d orientadas pelo mesmo ciclo de reserva.
- Configuração imobiliária: D15 precede consumo dessas regras por D09.

## Primeira rodada sugerida

1. D00: obter uma base reproduzível de validação.
2. D01: corrigir vazamento de dados em logs.
3. D04: provar enqueue e consumo real do CRM.
4. D05: corrigir campos inválidos e descoberta interrompida.
5. D06: implementar retomada de resposta/desfechos, com provas de falha.

D02 e D03 são frentes independentes prioritárias. Depois da primeira rodada, validar o código atualizado e planejar a execução dos demais contratos; não enviar todas as entregas como um único pedido de implementação.

## Execução no estágio atual

**Agora, em desenvolvimento:** executar correções, migrações e cenários de falha em banco local/de teste. Fechar uma jornada imobiliária completa com providers simulados; validar depois as integrações reais usadas pelo primeiro piloto. Dados/configurações de desenvolvimento que precisem ser preservados continuam sendo considerados nas migrações.

**Ao entrar em piloto:** manter configuração de referência e registrar versões de regra/modelo para não misturar resultados. Baseline, amostra e capacidade devem vir do primeiro cliente/jornada escolhidos.

**Na futura operação:** ampliar de forma controlada, preservar trabalho pendente e monitorar após liberação. Operações sobre credenciais, dados e contas reais permanecem separadas dos testes.

## Decisões do produto que alimentam o plano

Antes do piloto, definir: segmento/cliente inicial; canal; etapa que a SDR deve entregar; critérios de elegibilidade e prioridade; quem confirma o resultado; fonte oficial de fatos do negócio; CRM/agenda utilizados; volume/pico estimados; baseline comercial e custo operacional.

Essas decisões não impedem começar as correções comprovadas. Elas definem os parâmetros e o alcance da validação comercial.
