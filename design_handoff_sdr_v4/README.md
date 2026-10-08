# Handoff: Plataforma SDR de IA no WhatsApp — V4 Company

## Overview
Plataforma **multi-tenant** onde cada cliente conecta o WhatsApp do seu negócio e configura uma **SDR de IA** que atende leads 24/7: conversa, qualifica, agenda, faz handoff para humano e follow-up. Há duas áreas sobre o mesmo sistema visual:

1. **Área do Cliente (tenant)** — público não-técnico. Conecta o WhatsApp, ensina o negócio, acompanha leads/conversas e testa a SDR. Toda complexidade técnica fica escondida.
2. **Área da Plataforma (V4 / staff)** — público interno. Opera todos os tenants, cria nichos, **cura o conhecimento** que alimenta a IA, e vê a saúde do sistema. Mais densidade de informação.

Este handoff cobre o **sistema de design + as duas áreas completas**, com estados (vazio / carregando / erro) nas telas-chave.

## About the Design Files
Os arquivos deste pacote são **referências de design feitas em HTML** — protótipos que mostram a aparência e o comportamento pretendidos, **não código de produção para copiar diretamente**. A tarefa é **recriar estes designs no ambiente do codebase de destino** (React, Vue, etc.), usando os padrões e bibliotecas já estabelecidos ali. Se ainda não existe um ambiente, escolha o framework mais adequado (sugestão: **React + TypeScript**, dado o estilo dos protótipos) e implemente os designs nele.

Como abrir as referências:
- `standalone/*.html` — arquivos únicos, **offline**, abrem em qualquer navegador (recomendado para inspeção rápida).
- `designs/*.dc.html` — os arquivos-fonte originais. São "Design Components" e dependem de um runtime (`support.js`) servido junto; preferir os `standalone/` para visualização. Use os `.dc.html` para ler a marcação exata (estilos inline, medidas, cores).

> **Observação sobre os componentes de navegação:** nos `.dc.html`, a sidebar é um componente reutilizável (`Sidebar.dc.html` para o cliente, `PlatformSidebar.dc.html` para o staff) instanciado via `<dc-import name="Sidebar" active="leads" ...>`. Nos `standalone/`, essa sidebar já está "achatada" (inline) em cada tela. Na implementação real, faça **um** componente `Sidebar` com prop `active`.

## Fidelity
**Alta fidelidade (hifi).** Cores, tipografia, espaçamento e estados são finais. Recriar a UI fielmente usando as bibliotecas/padrões do codebase. Todos os valores estão na seção **Design Tokens**; medidas e cores também aparecem inline nos arquivos `.dc.html`.

---

## Identidade visual (V4 Company)
- **Canvas claro** para os dados (`#f5f5f6` / `#ffffff`), **navegação escura** (sidebar `#1a1a1a`; console do staff `#000`).
- **Vermelho da marca usado com intenção** — só em CTAs, item ativo e acentos. **Nunca** em corpo de texto.
- **Verde** = sucesso/qualificado; **amarelo** = atenção/handoff; **vermelho** = erro/queda.
- Tipografia **Montserrat** (Google Fonts) em toda a UI. Títulos em peso 800. (No brief original, títulos de destaque usariam *Proxima Nova*, licenciada — o fallback adotado é Montserrat 800.)

---

## Design Tokens

### Cores — marca
| Token | Hex | Uso |
|---|---|---|
| `red/600` | `#e50914` | CTA primário, item ativo, acentos |
| `red/700` | `#b20710` | hover / pressed do primário |
| `red/800` | `#80050b` | etapa intermediária de gráficos |
| `red/900` | `#400306` | vinho profundo (raro) |
| `red/tint-error-bg` | `#fef2f2` | fundo de alerta de erro |
| `red/tint-error-border` | `#f3b5b9` | borda de alerta de erro |
| `red/text-on-tint` | `#c30811` | texto vermelho sobre fundo claro |

### Cores — neutros
| Token | Hex | Uso |
|---|---|---|
| `ink/900` | `#1a1a1a` | sidebar, títulos, texto forte |
| `ink/800` | `#262626` | item ativo na sidebar, superfícies escuras |
| `ink/700` | `#333333` | divisores no escuro |
| `black` | `#000000` | topo/sidebar do console staff |
| `text/body` | `#333333` | corpo |
| `text/muted` | `#595959` | secundário |
| `text/subtle` | `#8a8a8a` | legendas, placeholders |
| `border/300` | `#cccccc` | bordas de input |
| `border/200` | `#e5e5e5` | bordas de card / divisores |
| `surface/canvas` | `#f5f5f6` | fundo do conteúdo |
| `surface/card` | `#ffffff` | cards |
| `surface/subtle` | `#fafafa` | cabeçalho de tabela, hover de linha |

### Cores — status
| Token | Hex | Uso |
|---|---|---|
| `success` | `#52cc5a` | qualificado / conectado / sucesso |
| `success/text` | `#2f8f38` | texto verde sobre claro |
| `success/tint` | `rgba(82,204,90,0.14)` | fundo de badge |
| `warning` | `#ffc02a` | atenção / handoff / em aprovação |
| `warning/text` | `#9a6b00` | texto âmbar sobre claro |
| `warning/tint` | `rgba(255,192,42,0.18)` | fundo de badge |
| `neutral-dot` | `#b3b3b3` | lead novo |
| `neutral-dark-dot` | `#595959` | desqualificado |

### Mapa de status do lead
`novo` = cinza `#b3b3b3` · `qualificado` = verde `#52cc5a` · `handoff/atendimento humano` = amarelo `#ffc02a` · `desqualificado` = cinza-escuro `#595959` · `erro/queda` = vermelho `#e50914`.

### Tipografia (Montserrat)
| Papel | Tamanho / peso | Obs |
|---|---|---|
| H1 página | 22–24px / 800 | `letter-spacing:-0.02em` |
| H1 hero | 28–30px / 800 | telas de destaque/login |
| H2 seção | 20px / 700 | |
| H3 card | 14–16px / 700–800 | |
| Body | 13–14px / 400–500 | `color:#333` |
| Label/eyebrow | 10–11px / 700–800 | `text-transform:uppercase; letter-spacing:0.1–0.14em; color:#8a8a8a` |
| Número KPI | 24–34px / 800 | `line-height:1` |
| Caption | 10.5–12px / 500–600 | `color:#8a8a8a` |

### Espaçamento
Base **4px**. Escala usada: 4, 8, 12, 16, 24, 32. Padding de card: 18–22px. Gap de grid: 12–18px.

### Raios
- Input / botão pequeno: **8px**
- Botão / chip: **9px**
- Card: **12–14px**
- Frame de tela (mock): **16px**
- Pill / avatar: **999px / 50%**

### Sombras / elevação
- Card padrão: borda `1px #e5e5e5` (sem sombra).
- Card flutuante: `0 1px 2px rgba(0,0,0,0.04), 0 4px 14px rgba(0,0,0,0.07)`.
- Modal: `0 20px 60px rgba(0,0,0,0.35)`.
- Frame de tela: `0 1px 2px rgba(0,0,0,0.04), 0 18px 50px rgba(0,0,0,0.1)`.

---

## App Shell

### Sidebar (cliente) — `Sidebar.dc.html`
- Largura **228px**, fundo `#1a1a1a`, padding `18px 13px`.
- Logo "V4" (quadrado vermelho 32px) + "SDR de IA".
- Itens: Início, Conversas (badge contador), Leads, Playground · grupo "Ajustes": Configuração, Conta & uso.
- **Item ativo:** fundo `#262626`, texto `#fff`, barra vermelha `#e50914` de 3px na borda esquerda (top/bottom 8px). Item inativo: texto `#b3b3b3`.
- Rodapé fixo: cartão `#262626` com toggle verde "SDR ativa · atendendo 24/7".
- **Prop:** `active` ∈ {inicio, conversas, leads, playground, config, conta}.

### Sidebar (staff) — `PlatformSidebar.dc.html`
- Largura **236px**, fundo `#000`. Item ativo fundo `#1a1a1a` + barra vermelha. Pílula "Sistema operacional" (ponto verde) no topo.
- Itens: Visão global, Tenants (badge 214), Nichos · grupo "Conhecimento": Curadoria (badge vermelho 18), Templates HSM · grupo "Operação": Operação & alertas (badge âmbar 3), Staff & permissões.
- Rodapé: usuário staff.
- **Prop:** `active` ∈ {visao, tenants, nichos, curadoria, hsm, ops, staff}.

### Topbar (cliente)
Altura **62px**, fundo branco, borda inferior `#e5e5e5`. Esquerda: **seletor de tenant** (avatar + nome + cidade + chevron). Direita: **indicador de estado da SDR** (ver abaixo), busca, sino com badge, avatar do usuário.

### Indicador de estado da SDR (persistente) — 3 estados
Pílula (`border-radius:999px`, padding `6px 13px`) sempre visível na topbar:
1. **Conectada** — fundo `rgba(82,204,90,0.12)`, borda `rgba(82,204,90,0.35)`, ponto verde estático, texto `#2f8f38` "SDR conectada".
2. **Respondendo agora** — mesmo verde, ponto com animação `pulse` (anel verde expandindo, 1.6s) + 3 pontinhos "digitando".
3. **Caída** — fundo `rgba(229,9,20,0.14)`, borda vermelha, ponto vermelho com `pulse` vermelho, texto `#ff6b73`; CTA "Reconectar" em destaque.

Keyframes usados (definir globalmente):
- `pulse`: box-shadow de `0 0 0 0 rgba(82,204,90,.55)` → `0 0 0 7px transparent`.
- `typing`: translateY/opacity dos 3 pontinhos, com delays 0/.15/.3s.
- `shimmer`: background-position -480px → 480px (skeleton).
- `dotsoft`: opacity .35 ↔ 1 (aguardando).

---

## Componentes (biblioteca)
Documentados visualmente em `Plataforma SDR V4 - standalone.html` (seção "02 · Componentes"):
- **Botões:** primário (`#e50914`, texto branco, sombra vermelha; hover `#b20710`), secundário (branco, borda `#cccccc`), fantasma (transparente), destrutivo (branco, borda/texto vermelho claro), com ícone, desabilitado (`#cccccc`).
- **Campos:** input/select/textarea — borda `#cccccc`, raio 8px, foco borda `#e50914`; estado de erro com borda `1.5px #e50914` e fundo `#fef2f2`.
- **Toggle** (trilho verde quando on), **checkbox** (quadrado vermelho com check), **tabs** (segmented em `#f0f0f0`, aba ativa branca com sombra).
- **Badges/pills de status:** pílula com ponto + texto na cor do status; tags retangulares (NOVO/QUENTE/SCORE 92).
- **KPI card:** label uppercase + número 800 + delta (verde ↑) ou mini-barra de progresso.
- **Tabela:** cabeçalho `#fafafa` uppercase, linhas com borda superior `#f0f0f0`, hover `#fafafa`, **linha clicável**, paginação (página ativa = quadrado vermelho).
- **Bolhas de chat (WhatsApp):** inbound branca (raio `10px 10px 10px 2px`), outbound `#dcf8c6` (raio `…2px 10px`), fundo da conversa `#ece5dd`. Status de entrega = check duplo `#34b7f1`. **Áudio:** ícone play vermelho + waveform + duração + bloco de **transcrição** com borda-esquerda vermelha.
- **Gráficos:** funil (barras horizontais `#1a1a1a`→`#80050b`→`#e50914`→`#52cc5a`), linha com área (stroke `#e50914`, gradiente), barras, donut, sparklines. *(SVG/CSS — recriar com a lib de charts do codebase.)*
- **Estado vazio:** ícone em `#f5f5f6`, título, texto que **ensina o próximo passo**, CTA. **Skeleton:** blocos com `shimmer`. **Erro:** card `#fef2f2` com ícone + título + texto + ação. **Tooltip** escuro. **Stepper**. **Toasts** escuros. **Modal** centralizado.

---

## Screens / Views

### ÁREA DO CLIENTE

**1. Login** — painel de marca escuro à esquerda (badge "Atende 24/7", headline, copy) + formulário à direita (e-mail, senha com olho, "Esqueci minha senha", botão primário "Entrar", divisor "ou", "Entrar com Google"). Frame branco, 2 colunas (~46% / 54%).

**2. Onboarding (wizard de 8 etapas)** — topbar com "Salvo automaticamente"; trilho lateral esquerdo (262px, `#fafafa`) com barra de progresso e os 8 passos (concluído = check verde; atual = número vermelho em card branco; futuro = número cinza); rodapé com Voltar / Continuar.
- **1 Conectar WhatsApp:** 2 cards — "WhatsApp Oficial" (recomendado, conecta em poucos cliques pela API oficial, selo verificado) e "Ler QR Code" (QR + "Aguardando leitura…"). Abaixo, **3 estados de conexão**: Conectando (âmbar pulsando) / Conectado (verde + número) / Caiu (vermelho).
- **2 Escolher nicho:** grid de cards (Energia solar selecionado com borda vermelha; Clínica; Imobiliária; Educação).
- **3 Ensinar o negócio:** chips de produtos, tom de voz (segmented), toggle de horário comercial, e dois blocos lado a lado — **PODE prometer** (borda verde) / **NÃO pode prometer** (borda vermelha).
- **4 Qualificação:** lista de campos com peso (Conta de luz = PESO ALTO, etc.).
- **5 Cadência & follow-up:** timeline D0/D1/D3 + **aviso âmbar**: "Templates precisam de aprovação da Meta".
- **6 Base de conhecimento (opcional):** dropzone + arquivo processado.
- **7 Testar no Playground:** mini-chat.
- **8 Ativar / sucesso:** card escuro com check verde, badge "SDR ao vivo", "Tudo pronto!", CTA "Ir para o painel".

**3. Dashboard (variação A — escolhida)** — saudação + período + "Testar SDR"; faixa de **4 KPIs** (Leads recebidos, Qualificados, Agendamentos, Uso no mês); 2 colunas: **Funil** (barras por etapa + tempo médio de 1ª resposta 8s + conversas ativas) e **Atividade recente** (lista de leads com status colorido). Abaixo do funil, **banner ao vivo compacto** (fundo `#1a1a1a`, "Sua SDR está atendendo 3 conversas agora", números 26px). *(Variação B, alternativa não escolhida, existe no arquivo do Passo 1 como `#dash-1b`.)*

**4. Leads / Pipeline** — título + Exportar; **barra de filtros** (busca, Etapa, Status, Score ≥); **tabela** (Lead com avatar+cidade, Status pill, Conta de luz, Score tag, Origem, Atualizado), linha clicável, paginação. **3 estados** mostrados: vazio (ensina próximo passo), skeleton, erro acionável.

**5. Detalhe do lead** — breadcrumb; 2 colunas. Esquerda: identidade + pills + "Abrir conversa", **Dados qualificados** (conta de luz, imóvel, economia, telhado, origem), **Agendamento** (card verde). Direita: **"Por que score 92?"** (3 barras de contribuição), **Linha do tempo**, **Status no CRM** (RD Station · Negociação + "Abrir no CRM").

**6. Playground** — topbar com badge "Modo teste · não envia ao lead" + **seletor de nicho** + Reiniciar. Esquerda: chat de teste (composer próprio). Direita: **painel de debug** (330px) — Conhecimento recuperado (trechos com score de match), Campos qualificados (✓/aguardando), **Custo da simulação** (msgs/tokens/R$ + score).

**7. Configuração** — banner de status do WhatsApp; **hub** de 6 cards (Conexão WhatsApp, Base de conhecimento, Persona & guardrails, Qualificação, Cadência & templates [badge "1 em aprovação"], Integrações). Prévias de subtelas: Persona/guardrails (tom + regras pode/não-pode) e Cadência/templates (lista com status Aprovado / Em aprovação / Rascunho).

**8. Conta** — tabs (Custos & uso / Compliance / Equipe). **Custos:** barra de uso do plano (R$412/R$600), breakdown por categoria (Conversas de IA, Mensagens WhatsApp, Transcrição), gráfico de uso diário. **Compliance:** opt-outs, templates aprovados, LGPD. **Equipe:** tabela de membros com papel (Admin/Vendedor) + "Convidar".

### ÁREA DA PLATAFORMA (staff)

**9. Visão global** — header escuro `#000`. Faixa de **5 KPIs densos** (Tenants ativos, Leads hoje, Custo agregado, Uptime, **Conexões caídas** em card escuro com alerta). 2 colunas: gráfico "Volume de mensagens · 14 dias" (2 linhas: Inbound `#e50914`, IA `#1a1a1a`) e **Conexões caídas** (lista de tenants com "Avisar").

**10. Tenants** — lista (420px) com busca + tenants (status colorido) | detalhe: header com **"Impersonar"**, alerta de conexão caída, 4 KPIs, Configuração do tenant e Atividade.

**11. Nichos** — lista de nichos (Energia solar selecionado) | **editor**: Vertical, **Motion** (segmented: Agendar visita / Orçamento), **Guidance da IA** (textarea), **Kit de vertical** (schema, templates HSM, FAQ base), botões "Salvar & publicar" / "Aplicar a 42 tenants".

**12. Curadoria de conhecimento (TELA-CHAVE / diferencial)** — **fila** (360px) de candidatos por nicho, cada um com badge **"Zero PII"** ou **"Revisar PII"** + nº de tenants | **revisão**: banner verde **"Zero PII detectado · VERIFICADO"**, pergunta capturada (bolha de chat), **resposta proposta pela IA** (editável), métricas de ocorrência; coluna direita com **Versões** (v3 atual / v2 / v1 com **Rollback**) e **Promover para** (Nicho / Base global); barra de ações: **Rejeitar** · Editar resposta · **Aprovar & promover**.

**13. Templates HSM** — 3 KPIs (Aprovados/Em aprovação/Rejeitados) + tabela (Template, Nicho, Categoria, **Status Meta** colorido, Uso).

**14. Operação & alertas** — alertas (crítico/atenção), 4 cards de fila (Fila inbound, **Outbox** com atraso, Workers IA, Latência), gráfico de throughput. *(Aqui os termos técnicos APARECEM — público interno.)*

**15. Staff & permissões** — tabela de membros (papel Admin/Curador/Suporte + acesso) + **matriz de permissões por papel**.

---

## Interactions & Behavior
- **Indicador da SDR** atualiza em tempo real (idealmente via websocket/polling); estados conectada → respondendo → caída conforme a conexão e a atividade.
- **Conversas:** mensagens chegam em tempo real; status de entrega (enviado/entregue/lido = checks). Áudios mostram waveform + transcrição. **"Assumir conversa"** pausa a IA e passa o controle ao humano (banner muda; composer habilita).
- **Onboarding:** salvar-e-continuar (autosave por etapa); navegação livre entre etapas concluídas; conexão WhatsApp com polling de status (conectando → conectado/caiu).
- **Tabelas:** filtros combináveis, busca, paginação; clique na linha → detalhe.
- **Playground:** envio de mensagem de teste → resposta simulada + atualização do painel de debug (não envia ao lead real).
- **Curadoria:** aprovar/rejeitar/editar/promover move o candidato na fila; rollback restaura versão anterior; verificação de PII antes de promover.
- **Impersonar (staff):** entra na conta do tenant para suporte (registrar auditoria).
- **Animações:** `pulse` (estado ao vivo), `typing` (3 pontinhos), `shimmer` (skeleton), `dotsoft` (aguardando). Transições sutis ≤ 200ms.

## State Management
- **Sessão/tenant atual** (seletor de tenant), papel/permissões do usuário.
- **Conexão WhatsApp:** `connecting | connected | down` + número + tipo (oficial/QR).
- **SDR:** `active/paused`, `responding` (há conversa sendo respondida agora).
- **Leads:** lista paginada + filtros (etapa, status, score, busca); lead selecionado e sua timeline.
- **Conversas:** lista + conversa ativa + `aiControlled vs humanTakeover`.
- **Onboarding:** passo atual (1–8), payload por etapa, flags de conclusão.
- **Playground:** transcript de teste + debug (retrieval, campos, custo) + nicho selecionado.
- **Staff:** tenants, nichos, fila de curadoria (+ versões), templates HSM, filas/alertas de operação.
- Data fetching: dashboards/KPIs, listas paginadas, stream de conversas, fila de curadoria.

## Responsividade
Desktop é primário. **Dashboard, Conversas e Leads também no mobile** — ver os 2 frames de celular no arquivo do Passo 1 (`#mobile`): topbar com indicador da SDR, conteúdo em coluna única, **tab bar inferior** (Início / Conversas / Leads / Testar). Conversa no mobile: header escuro, banner de handoff compacto, bolhas, composer.

## Assets
- **Fonte:** Montserrat via Google Fonts (`https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800`).
- **Ícones:** todos inline em SVG stroke (estilo "Lucide/Feather", `stroke-width` ~2). Substituir pela biblioteca de ícones do codebase (ex.: lucide-react).
- **Logo:** placeholder "V4" (quadrado vermelho com texto). **Substituir pelo logotipo oficial da V4** quando disponível.
- **Gráficos:** desenhados em SVG/CSS; recriar com a lib de charts do projeto (ex.: Recharts/visx).
- Sem imagens raster externas — o pacote é autocontido.

## Files
- `designs/Plataforma SDR V4.dc.html` — **sistema de design** (tokens + componentes) + app shell + 3 telas-âncora (Dashboard 1a/1b, Onboarding, Conversa) + frames mobile.
- `designs/Área do Cliente.dc.html` — Login, Onboarding (etapas 3–8), Leads, Detalhe do lead, Playground, Configuração, Conta.
- `designs/Área da Plataforma.dc.html` — Visão global, Tenants, Nichos, Curadoria, Templates HSM, Operação, Staff.
- `designs/Sidebar.dc.html`, `designs/PlatformSidebar.dc.html` — componentes de navegação (prop `active`).
- `standalone/*.html` — versões offline de cada área para inspeção rápida no navegador.
