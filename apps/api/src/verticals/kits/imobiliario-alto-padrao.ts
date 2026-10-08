import type { VerticalKit } from "../vertical-kit";

/**
 * VERTICAL: Imobiliário — MÉDIO/ALTO PADRÃO (lançamento). Pesquisa ago/2026:
 * ~75% dos compradores atuais são MORADORES (upgrade de vida) e ~25%
 * investidores (Selic alta afastou o especulador); a visita ao DECORADO é o
 * conversor do funil; tom consultivo, zero pressão. Genérico (sem PII).
 */
export const IMOBILIARIO_ALTO_PADRAO_KIT: VerticalKit = {
  version: "1.0.0",
  niche: { name: "imobiliario_alto_padrao_br", vertical: "imobiliario", motion: "orcamento_cotacao" },
  resourceNoun: { singular: "corretor", plural: "corretores" },
  guidance:
    "Você é a SDR de um lançamento imobiliário de médio/alto padrão. Objetivo: entender a " +
    "motivação (morar × investir), qualificar com elegância e levar à VISITA AO DECORADO com " +
    "um corretor especialista. TÉCNICA: (1) tom de CONSULTOR, não vendedor — sofisticado, " +
    "discreto, zero pressão explícita; (2) UMA pergunta por mensagem, curta; (3) personalize " +
    "pelo contexto e termine todo turno com próximo passo; (4) a primeira bifurcação é SEMPRE " +
    "'para morar ou como investimento?' — o discurso muda inteiro; (5) demonstre domínio de " +
    "região e produto (consulte a base de conhecimento; detalhe técnico errado mata a " +
    "credibilidade — se não souber, o especialista confirma); (6) escassez SÓ real (espelho de " +
    "vendas, unidades por planta); (7) nunca desqualifique concorrente — compare R$/m², " +
    "memorial e histórico de entrega; (8) o decorado é o evento de conversão: conduza para lá. " +
    "Follow-up sempre com material NOVO (planta liberada, estudo de valorização, andamento de " +
    "vendas) — nunca 'e aí, pensou?'. Não prometa valorização garantida nem rentabilidade — " +
    "use dados históricos como referência, decisão é do cliente.",
  knowledge: [
    { type: "qualifying_question", content: "Bifurcação obrigatória: 'Esse imóvel seria para morar ou você está olhando mais como investimento?' — morador quer estilo de vida e upgrade; investidor quer números (valorização até as chaves, liquidez, renda)." },
    { type: "qualifying_question", content: "Motivação sem interrogatório: 'O que te chamou atenção nesse empreendimento — a região, a planta, os diferenciais?' e 'Hoje você mora onde? O que faria valer a pena uma mudança?'" },
    { type: "qualifying_question", content: "Perfil do imóvel: metragem/planta de referência (3 ou 4 suítes, vagas, depósito), conhecimento da região (trabalho, escola dos filhos)." },
    { type: "qualifying_question", content: "Forma de pagamento com elegância: 'Você pretende usar recursos próprios, financiar uma parte ou envolver um imóvel atual na negociação?' — abre permuta sem perguntar patrimônio." },
    { type: "qualifying_question", content: "Rumo à visita: 'Prefere conhecer primeiro o decorado ou quer que eu envie o book completo com plantas e tabela?' — sempre dar duas opções de avanço." },
    { type: "objection_handling", content: "'Com a Selic assim, deixo na renda fixa': faz sentido no curto prazo — quem compra agora é quem vai morar, ou quem pensa em ciclo: tabela de lançamento com menos concorrência + surfar a queda da Selic (que já começou) até as chaves, financiando só no final." },
    { type: "objection_handling", content: "'Não é o melhor momento': responder com dados, não opinião — o fluxo de pagamento é durante a obra e o financiamento só no fim (com juros projetados menores); condições de lançamento não se repetem na entrega." },
    { type: "objection_handling", content: "'Está caro / vi concorrente melhor': nunca atacar o concorrente. Comparar R$/m² da região, memorial descritivo, histórico de entrega da incorporadora e liquidez futura. Caro é relativo ao valor percebido — explorar diferenciais e intangíveis (segurança, status, conveniência)." },
    { type: "objection_handling", content: "'Na planta demora / medo do prazo': personalização de planta e acabamento só existe na planta; valorização típica de 15-40% durante a obra; garantias da Lei do Distrato protegem o comprador." },
    { type: "objection_handling", content: "'Preciso falar com meu cônjuge/sócio': 'Perfeito — agendo uma visita ao decorado para os dois? Fim de semana tenho horário reservado.' Nunca esperar passivamente." },
    { type: "objection_handling", content: "'Vou pensar': tratar como pedido de mais informação. Perguntar o que está pesando, combinar retorno com data e voltar com material NOVO (estudo de valorização, planta recém-liberada, andamento de vendas da torre)." },
    { type: "faq", content: "Argumentos que convertem no alto padrão: (1) visita ao decorado como EVENTO (tangibiliza o estilo de vida); (2) exclusividade/escassez real (poucas unidades por andar/planta); (3) assinatura (arquiteto, paisagista, marca da incorporadora); (4) preço de tabela de lançamento + valorização até as chaves; (5) personalização de planta e acabamentos." },
    { type: "faq", content: "Contexto de mercado (ago/2026, revisar): Selic ~14% em ciclo de queda gradual; financiamento de mercado ~11-12% a.a.; teto do SFH subiu para R$ 2,25 mi (permite FGTS em imóveis maiores). Investidor de revenda recuou — comprador atual é majoritariamente morador." },
    { type: "vocabulary", content: "Termos do lançamento: tabela de lançamento, espelho de vendas, VGV, book, memorial descritivo, planta tipo/garden/duplex/penthouse, decorado, torre única, assinatura, permuta, fluxo de pagamento, INCC (correção na obra), repasse, chaves, R$/m²." },
    { type: "document_request", content: "Para proposta/análise: documento com foto, comprovante de renda ou declaração IR, e — se houver permuta — matrícula do imóvel atual. Orientar a separar sem enviar documentos no chat." },
  ],
  qualificationSchema: {
    qualifyAtScore: 5,
    fields: [
      { key: "nome", type: "string", required: true, weight: 1, description: "nome da pessoa interessada" },
      { key: "finalidade", type: "string", required: true, weight: 2, description: "morar ou investir (a bifurcação principal do discurso)" },
      { key: "tipo_planta", type: "string", weight: 1, description: "planta/metragem de referência (ex.: 3 suítes, 140m², garden)" },
      { key: "regiao", type: "string", weight: 1, description: "bairro/região de interesse ou onde mora hoje" },
      { key: "forma_pagamento", type: "string", weight: 1, description: "recursos próprios, financiamento parcial ou permuta de imóvel atual" },
      { key: "prazo", type: "string", weight: 1, description: "horizonte de decisão/mudança (ex.: este ano, sem pressa)" },
    ],
  },
  templates: [
    { name: "imob_ap_material_novo", languageCode: "pt_BR", variables: ["nome"], category: "marketing" },
  ],
};
