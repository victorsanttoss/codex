import type { VerticalKit } from "../vertical-kit";

/**
 * VERTICAL: Energia Solar (motion: orcamento_cotacao). Kit de REFERÊNCIA.
 * Conteúdo é ponto de partida — exige revisão de especialista de domínio; o loop
 * de curadoria do M9 refina com dados reais. Genérico por construção (sem PII).
 */
export const SOLAR_KIT: VerticalKit = {
  version: "1.1.0",
  niche: { name: "energia_solar_br", vertical: "energia_solar", motion: "orcamento_cotacao" },
  resourceNoun: { singular: "consultor", plural: "consultores" },
  guidance:
    "Você é um SDR consultivo de energia solar. Objetivo: entender o perfil de " +
    "consumo, qualificar e encaminhar para uma proposta/visita técnica. Explique " +
    "economia e payback de forma simples, SEM fechar preço (a proposta é do time). " +
    "Lide com desconfiança ('é furada?', 'não funciona em dia nublado') com fatos e " +
    "tom tranquilo. Peça a conta de luz para dimensionar. Nunca prometa retorno exato.",
  knowledge: [
    { type: "objection_handling", content: "Quando dizem que é caro: o sistema costuma se pagar (payback) em poucos anos e existem opções de financiamento com parcela menor que a conta de luz atual." },
    { type: "objection_handling", content: "Sobre mudar de imóvel: o sistema valoriza o imóvel e, em muitos casos, pode ser transferido; vale avaliar caso a caso." },
    { type: "objection_handling", content: "Sobre nublado/chuva: a geração cai mas não zera; o dimensionamento considera a média anual da região e o saldo de energia compensa." },
    { type: "qualifying_question", content: "Pergunte o valor médio da conta de luz por mês para dimensionar o sistema." },
    { type: "qualifying_question", content: "Pergunte se o imóvel é próprio ou alugado e se é casa, apartamento ou empresa." },
    { type: "qualifying_question", content: "Pergunte se a pessoa é quem decide sobre a instalação (decisor)." },
    { type: "vocabulary", content: "Termos: kWp (potência do sistema), payback (tempo de retorno), geração distribuída, fio B (custo de uso da rede), inversor (converte a energia), saldo de energia (créditos)." },
    { type: "document_request", content: "Peça uma foto da conta de luz recente (mostra consumo em kWh) e o CEP para verificar a área de atendimento." },
    { type: "faq", content: "A energia gerada a mais vira crédito na distribuidora e abate contas futuras dentro do prazo de validade dos créditos." },
  ],
  qualificationSchema: {
    qualifyAtScore: 3,
    fields: [
      { key: "valor_conta_luz", type: "number", required: true, weight: 2, eliminatory: { min: 150 }, description: "valor mensal da conta de luz em reais (apenas o número)" },
      { key: "tipo_imovel", type: "string", required: true, weight: 1, description: "tipo do imóvel (casa, apartamento, comércio, galpão...)" },
      { key: "concessionaria_regiao", type: "string", weight: 1, description: "concessionária de energia ou cidade/região" },
      { key: "eh_decisor", type: "boolean", weight: 1, description: "true se quem escreve decide a compra" },
      { key: "consumo_kwh", type: "number", weight: 1, description: "consumo mensal em kWh (apenas o número)" },
    ],
  },
  templates: [
    { name: "solar_followup_economia", languageCode: "pt_BR", variables: ["nome"], category: "marketing" },
    { name: "solar_followup_conta", languageCode: "pt_BR", variables: ["nome"], category: "utility" },
  ],
};
