# Continuação no Codex pelo terminal — 8 de outubro de 2026

Este pacote contém a fonte corrigida da primeira rodada e o contexto para
continuar em outra sessão do Codex. O Codex local não recebe automaticamente a
conversa anterior: os documentos abaixo registram o ponto de partida.

## Abrir o projeto

1. Extraia o ZIP em uma pasta nova. Preserve a pasta original, o histórico Git,
   as alterações locais e a configuração de ambiente.
2. No Terminal, digite `cd ` com um espaço no final, arraste a pasta extraída
   para a janela e pressione Enter. A pasta correta contém `package.json`,
   `pnpm-lock.yaml`, `apps`, `packages` e `docs`.
3. Execute `codex`, entre com sua conta e cole o pedido abaixo.

Se já incorporou a primeira rodada ao seu checkout, use esse checkout e copie
os três documentos de continuidade. Confira o diff antes de incorporar arquivos;
não substitua seu projeto inteiro ou seu `.env` para acompanhar esta entrega.

## Pedido para colar no Codex

```text
Quero continuar as melhorias deste produto SDR IA. Implemente a entrega D02
(curadoria compartilhada e privacidade) nesta execução.

Leia docs/CONTINUAR_NO_CODEX.md e siga seu escopo e critérios. Consulte também
docs/IMPLEMENTACAO_RODADA_1.md, docs/PLANO_MELHORIAS_SDR.md,
docs/REVISAO_INDEPENDENTE_SDR_20261007.md e docs/CI.md.

Inspecione o código e as mudanças locais, confirme o que já foi implementado e
avance para implementação e testes. Não encerre apenas com análise ou um plano.
Preserve a primeira rodada e o núcleo reutilizável para imobiliário/odontologia.
Ao final, entregue resumo, arquivos alterados, diff, verificações executadas e
limitações. Deixe D03 e D07 para as execuções seguintes.
```

## Estado que deve orientar a execução

- Produto em desenvolvimento, sem clientes reais. A fonte enviada é o fork
  imobiliário; o núcleo e os demais kits devem continuar reutilizáveis.
- D00, D01, D04 e D05 foram implementados. D06 tem uma implementação inicial.
  Consulte a documentação de implementação e confirme o estado no código antes
  de alterar qualquer caminho já corrigido.
- A primeira rodada passou em 688 testes, builds da API e web e typecheck.
  Esse resultado pertence à fonte anterior: registre os resultados da sua nova
  execução, inclusive testes pulados ou bloqueados, sem reutilizar a contagem
  como evidência do novo código.
- A revisão independente descreve a base de 7 de outubro, antes das correções.
  Seus achados orientam a investigação; não são prova de que o código corrigido
  ainda tem todos os problemas antigos. Os comandos e sugestões ali registrados
  também devem ser avaliados contra a tarefa e o ambiente atual.
- O turno salva plano e decisão comercial juntos, possui lease com fencing,
  checkpoints e retomada de planos `ready`. Não volte ao claim antigo como único
  mecanismo de recuperação. `uncertain` não é confirmação de entrega e não deve
  provocar reenvio automático. Falhas anteriores à persistência do plano ainda
  dependem da reentrega do evento original; D07 continua pendente.

## D02: implementação solicitada

O problema é a mineração/publicação de conhecimento compartilhado confiar em
regex e em um marcador de anonimização insuficiente. Conversas podem conter
nomes, endereços, relatos identificáveis e informações de saúde que esse filtro
não reconhece. Corrija o comportamento e os comentários que prometem “zero PII”.

Comece inspecionando:

- `apps/api/src/curation/mining.service.ts`
- `apps/api/src/curation/anonymization.service.ts`
- `apps/api/src/curation/curation.service.ts`
- `packages/db/src/niche.ts`
- a configuração em `packages/config`, os providers usados pelo extrator e os
  caminhos de aprovação, embedding e publicação.

Requisitos:

1. Permita controlar a mineração por configuração suportada, documentando
   padrão, habilitação e compatibilidade. O modo seguro do desenvolvimento
   deve permitir mantê-la desligada. Mineração desligada não consulta/converte
   conversas para envio ao extrator.
2. Minimize os dados antes de extração e acrescente avaliação contextual.
   Regex isolada não aprova anonimização. Resultado inconclusivo, indisponível
   ou sem suporte bloqueia a extração/publicação que dependeria dessa aprovação
   e informa o motivo ao operador. Não envie uma conversa sensível integral a
   um LLM externo apenas para decidir se ela é sensível.
3. Preserve revisão humana, autorização e isolamento por tenant/nicho. Não
   bloqueie indiscriminadamente conteúdo público e genérico que passou pelos
   critérios e pela revisão; documente os limites da avaliação de privacidade.
4. A aprovação deve corresponder ao conteúdo efetivamente publicado. Edição
   posterior invalida a revisão. Trate a corrida entre validar uma versão e a
   função de publicação reler outra. Não confie em `redactionChecked=true`
   legado como evidência suficiente.
5. Faça migrações aditivas quando necessárias. Não edite migrações já aplicadas
   nem remova conhecimento/dados legados em massa para contornar o problema.

Critérios de aceite:

- Corpus sintético com nomes, endereços, relatos identificáveis e dados de saúde
  demonstra que esses conteúdos não recebem aprovação automática de anonimização.
- Spies/providers simulados demonstram que caminhos bloqueados não enviam a
  conversa integral ao extrator e não chamam embedding/publicação indevidamente.
- Desabilitação, avaliação inconclusiva e falha do avaliador não resultam em
  publicação silenciosa. Conteúdo genérico validado tem um caso positivo.
- Aprovar sem editar, aprovar conteúdo editado, editar após aprovação e publicar
  uma versão concorrente recebem tratamento coerente. Autorização e isolamento
  entre empresas continuam corretos.
- Testes de regressão relevantes passam; os resultados e as limitações ficam
  registrados em documentação de implementação da D02.

## Ambiente e verificações

O computador informado é MacBook Pro 2017 Intel i7, macOS Ventura 13.7.8.
Inspecione as ferramentas instaladas antes de escolher a preparação do ambiente.
Não presuma compatibilidade com o Docker Desktop mais recente; use infraestrutura
local de teste compatível e documente a alternativa escolhida quando necessário.

O projeto fixa Node 24.19.0 e pnpm 9.15.9. Siga `docs/CI.md` para infraestrutura
e comandos. Banco e Redis dos testes devem ser descartáveis, com Postgres 16,
pgvector/btree_gist e roles app/migrator distintas, sem BYPASSRLS na aplicação.
Preserve o `.env` pessoal: o helper de CI exige checkout limpo, então execute a
suíte em uma cópia limpa/worktree se a pasta de desenvolvimento contém `.env`.
Não exclua o arquivo para fazer o teste passar e não use o banco habitual da SDR
como banco descartável.

Com a configuração de teste pronta, execute os comandos aplicáveis:

```bash
pnpm install --frozen-lockfile
pnpm build:server
pnpm typecheck
pnpm db:migrate:ci
pnpm test:ci
pnpm test:http
```

Execute `pnpm build:web` se alterar a interface ou contratos que afetem esse
build. Acrescente testes direcionados às mudanças da D02. Se alguma verificação
ficar bloqueada, avance nas correções e verificações independentes e registre a
causa exata; não declare a suíte aprovada sem executá-la.

Não exponha credenciais em comandos de diagnóstico, logs ou relatório. Não
troque segredos reais, publique conhecimento, faça push/deploy ou envie mensagens
a leads/corretores durante a implementação de teste. Providers externos devem
ser simulados nos testes.

Se houver Git, preserve alterações preexistentes e separe o trabalho da D02 em
uma branch ou conjunto de mudanças identificável. Se estiver na fonte extraída
sem histórico Git, registre a base e um diff verificável; não invente commits.

## Entrega esperada

Conclua código e regressões da D02. Informe o problema resolvido, comportamento
final, configuração, migrações, arquivos alterados e resultados dos comandos.
Distinga verificações executadas de testes apenas escritos, mocks de integrações
reais e resultado novo dos 688 testes da rodada anterior. Entregue diff e pontos
que ainda exigem decisão do produto ou operação.

Após revisar essa entrega, o próximo pedido será D03: separar tipo, audiência,
emissor e claims de tokens de usuário/corretor, com compatibilidade explícita e
testes dos fluxos legítimos e das rejeições cruzadas. Depois virá D07, dividida
em admissão/deduplicação, fila durável Baileys e ordem/retries por conversa. Não
inicie essas entregas nesta execução nem reescreva todo o produto de uma vez.
