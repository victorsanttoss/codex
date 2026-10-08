import type { VerticalKit } from "../vertical-kit";

/**
 * VERTICAL: Imobiliário — ECONÔMICO/MCMV (lançamento de construtora). Padrão
 * DEFAULT da vertical. 3.0.0 = inteligência nativa vinda de pesquisa profunda
 * de mercado (ago/2026): técnica de abordagem dos melhores atendimentos BR
 * (Facilita, CV CRM, Imobilead, benchmark MRV/Sofia), objeções com scripts
 * validados (Tenda/MRV/Serasa) e dados MCMV 2026 verificados em 3 fontes.
 * Genérico (sem PII). Números voláteis (faixas/juros) — revisar a cada mudança
 * do programa habitacional.
 */
export const IMOBILIARIO_KIT: VerticalKit = {
  version: "3.0.0",
  niche: { name: "imobiliario_br", vertical: "imobiliario", motion: "orcamento_cotacao" },
  resourceNoun: { singular: "corretor", plural: "corretores" },
  guidance:
    "Você é a SDR de um empreendimento imobiliário econômico (programa habitacional) de uma " +
    "construtora. Objetivo: acolher quem chegou pela campanha, qualificar capacidade e momento " +
    "(renda, FGTS, se já tem imóvel) e ENCAMINHAR ao corretor parceiro com visita sugerida. " +
    "TÉCNICA DE ABORDAGEM (siga sempre): (1) UMA pergunta por mensagem — nunca interrogatório " +
    "nem formulário; (2) mensagens CURTAS, tom leve e próximo, sem formalidade de e-mail e sem " +
    "parede de texto; (3) use o nome da pessoa e o contexto de onde ela veio; (4) TERMINE todo " +
    "turno com um próximo passo concreto; (5) pergunte dinheiro pelo CONFORTO, não pela renda " +
    "seca ('que valor de parcela caberia no seu orçamento?') e justifique o porquê da pergunta; " +
    "(6) venda a TRANSFORMAÇÃO (sair do aluguel, casa própria pra família), não o imóvel; " +
    "(7) escassez/urgência SÓ com fato real (fase de tabela, unidades) — nunca inventada. " +
    "Muitas famílias estão comprando o primeiro imóvel: acolha medo de análise de crédito e " +
    "nome negativado SEM julgamento (é comum e tem caminho). NUNCA prometa aprovação, valor " +
    "exato de subsídio ou parcela: a análise é do banco — diga que a simulação confirma. " +
    "Não invente preço, planta ou prazo: consulte a base de conhecimento; se não souber, o " +
    "corretor confirma.",
  knowledge: [
    // ── Programa habitacional (dados 2026 VERIFICADOS — atualizar quando mudar) ──
    { type: "faq", content: "Faixas do Minha Casa Minha Vida (regras de abril/2026): Faixa 1 até R$ 3.200/mês de renda familiar; Faixa 2 até R$ 5.000; Faixa 3 até R$ 9.600; Faixa 4 até R$ 13.000. Subsídio de até R$ 55 mil nas Faixas 1-2 (quanto menor a renda, maior o subsídio). Juros de ~4% a.a. (Faixa 1) a ~10,5% (Faixa 4) — bem abaixo do mercado (~11-12%)." },
    { type: "faq", content: "Teto de valor do imóvel no programa: Faixas 1-2 entre R$ 210 e 275 mil (varia por cidade — confirme o município antes de citar o teto), Faixa 3 até R$ 400 mil, Faixa 4 até R$ 600 mil. Prestação máxima: 30% da renda bruta familiar. Prazo de até 35 anos." },
    { type: "faq", content: "FGTS pode ser usado como entrada e amortização. Quem tem 3+ anos de carteira assinada (cotista FGTS) consegue taxa de juros melhor. Renda informal conta na análise, e dá para somar renda de quem mora junto (composição de renda)." },
    // ── Perguntas de qualificação (fraseado testado) ──
    { type: "qualifying_question", content: "Âncora do aluguel: 'Hoje você paga aluguel ou mora com a família? Quanto sai por mês?' — o valor do aluguel vira a comparação com a futura parcela." },
    { type: "qualifying_question", content: "Renda pela faixa, sem constranger: 'Somando todo mundo da casa que trabalha, a renda fica em torno de quanto? Pode ser por cima — é só pra eu ver em qual faixa do programa você entra (quanto menor a renda, maior o subsídio).'" },
    { type: "qualifying_question", content: "Pergunte se tem FGTS ('mesmo pouco, ele pode virar sua entrada') e se trabalha registrado há 3+ anos (dá desconto na taxa)." },
    { type: "qualifying_question", content: "Nome/CPF sem tabu: 'Seu nome está ok ou tem alguma restrição no CPF? Pergunto porque é super comum e tem caminho — não te elimina.'" },
    { type: "qualifying_question", content: "Pergunte se seria o primeiro imóvel (condição para o subsídio), quem vai morar (dependentes influenciam) e o prazo desejado para mudar." },
    { type: "qualifying_question", content: "Fechamento de turno rumo à visita: 'Se a simulação aprovar uma parcela parecida com seu aluguel, você toparia visitar o decorado essa semana?'" },
    // ── Objeções (scripts validados no segmento) ──
    { type: "objection_handling", content: "'Não tenho entrada': hoje quase ninguém paga entrada à vista — o FGTS entra, o subsídio de até R$ 55 mil entra, e o restante a construtora costuma parcelar direto durante a obra (pró-soluto). Ofereça simular sem compromisso." },
    { type: "objection_handling", content: "'Meu nome está sujo': acolher sem julgamento — 4 em cada 10 brasileiros estão negativados. Caminho: levantar as pendências (muitas se resolvem com acordo pequeno), compor renda com cônjuge de nome limpo, e na Faixa 1 a restrição pesa menos. Nunca descartar o lead: mantém no acompanhamento. Alertar que 'aprovação garantida sem consulta' é golpe." },
    { type: "objection_handling", content: "'Tenho medo de não conseguir pagar': a regra do programa protege — a parcela não pode passar de 30% da renda, e é previsível; o aluguel sobe todo ano e nunca vira patrimônio." },
    { type: "objection_handling", content: "'Minha renda é pouca / sou autônomo': renda informal conta na análise, dá para somar a renda de quem mora junto, e quanto menor a renda MAIOR o subsídio (até R$ 55 mil). O que importa é capacidade de pagamento, não holerite." },
    { type: "objection_handling", content: "'Vou pensar / depois eu vejo': validar e dar um motivo real de agora — o subsídio e a taxa seguem as regras vigentes do programa e a tabela muda por fase da obra. A simulação é grátis e trava a condição de hoje. Propor dia/horário concreto de retorno." },
    { type: "objection_handling", content: "'Financiar é furada, prefiro alugar': comparar na ponta do lápis — parcela costuma ficar próxima do aluguel atual, com juros de 4-8% (metade do mercado), e no fim o imóvel é seu. Oferecer a comparação personalizada aluguel × parcela." },
    { type: "objection_handling", content: "'Tenho medo de ser enganado': transparência total — quem aprova é o banco (Caixa), contrato registrado, e o passo a passo vai por escrito na conversa." },
    // ── Argumentos/gatilhos ──
    { type: "faq", content: "Argumentos que mais convertem no econômico: (1) parcela ≈ aluguel que a pessoa JÁ paga (ancorar número a número); (2) subsídio = 'desconto do governo que você não devolve'; (3) FGTS = 'dinheiro seu parado que vira entrada'; (4) juros do programa (4-8%) vs mercado (~11-12%); (5) escassez REAL de unidades por faixa de preço/fase de tabela." },
    { type: "vocabulary", content: "Termos do segmento econômico: Faixa 1/2/3/4, subsídio, FGTS, cotista, composição de renda, pró-soluto (entrada parcelada com a construtora), análise de crédito, prestação de 30%, sair do aluguel, feirão, decorado, fase de tabela." },
    { type: "document_request", content: "Para a análise de crédito o banco costuma pedir: documento com foto, comprovante de renda (holerite ou extrato), comprovante de residência e extrato do FGTS — oriente a família a ir separando (sem enviar documentos no chat)." },
  ],
  // qualifyAtScore 5 = obrigatórios (nome+renda+possui_imovel, 4 pts) + ao
  // menos mais um sinal — evita handoff cedo demais (revisão Codex).
  // `possui_imovel` é TRIAGEM, não eliminatória: quem já tem imóvel pode
  // comprar fora do programa — o corretor avalia.
  qualificationSchema: {
    qualifyAtScore: 5,
    fields: [
      { key: "nome", type: "string", required: true, weight: 1, description: "nome da pessoa interessada" },
      { key: "renda_familiar", type: "number", required: true, weight: 2, description: "renda bruta familiar mensal em reais (apenas o número; somar quem compõe renda)" },
      { key: "possui_imovel", type: "boolean", required: true, weight: 1, description: "true se alguém da família já possui imóvel no nome" },
      { key: "fgts_disponivel", type: "boolean", weight: 1, description: "true se tem saldo de FGTS disponível para usar na compra" },
      { key: "composicao_familiar", type: "string", weight: 1, description: "quem vai morar (ex.: casal e 2 filhos)" },
      { key: "prazo", type: "string", weight: 1, description: "prazo/urgência para comprar ou mudar (ex.: 3 meses, este ano)" },
      { key: "regiao", type: "string", weight: 1, description: "bairro/cidade onde a pessoa mora ou quer morar" },
    ],
  },
  templates: [
    { name: "imob_followup_condicoes", languageCode: "pt_BR", variables: ["nome"], category: "marketing" },
  ],
};
