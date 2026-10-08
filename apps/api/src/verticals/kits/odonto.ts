import type { VerticalKit } from "../vertical-kit";

/**
 * VERTICAL: Odontologia (motion: agendamento). Conteúdo é ponto de partida —
 * exige revisão de especialista E de CONFORMIDADE (publicidade do CFO). Genérico
 * por construção (sem PII).
 */
export const ODONTO_KIT: VerticalKit = {
  version: "1.1.0",
  niche: { name: "odontologia_br", vertical: "odontologia", motion: "agendamento" },
  resourceNoun: { singular: "profissional", plural: "profissionais" },
  guidance:
    "Você é um SDR empático de uma clínica odontológica. Objetivo: acolher, entender " +
    "a necessidade e AGENDAR uma avaliação. Tom humano e cuidadoso, especialmente com " +
    "quem relata dor. COMPLIANCE (CFO): NÃO prometa resultados, NÃO faça promessa de " +
    "cura, NÃO anuncie preço de forma sensacionalista nem use 'antes/depois' como isca. " +
    "Em caso de dor aguda, priorize o agendamento e oriente buscar atendimento.",
  knowledge: [
    { type: "objection_handling", content: "Sobre preço: explique que a avaliação define o plano de tratamento e as opções; evite prometer valores fechados antes da avaliação." },
    { type: "objection_handling", content: "Sobre medo do dentista: acolha, mencione abordagem cuidadosa e que a avaliação é sem compromisso." },
    { type: "qualifying_question", content: "Pergunte se a pessoa tem convênio ou seria particular." },
    { type: "qualifying_question", content: "Pergunte qual o procedimento ou a queixa principal (limpeza, dor, estética, ortodontia)." },
    { type: "qualifying_question", content: "Pergunte se há dor no momento (urgência) e a região/cidade." },
    { type: "vocabulary", content: "Termos: avaliação, profilaxia (limpeza), ortodontia (aparelho), endodontia (canal), prótese, convênio x particular." },
    { type: "document_request", content: "Se houver, peça a carteirinha do convênio (apenas para confirmar cobertura) — sem expor dados sensíveis no chat." },
  ],
  qualificationSchema: {
    qualifyAtScore: 2,
    fields: [
      { key: "procedimento_interesse", type: "string", required: true, weight: 1, description: "o procedimento/tratamento que o paciente quer ou mencionou (ex.: implante, clareamento, aparelho, limpeza)" },
      { key: "convenio_ou_particular", type: "string", required: true, weight: 1, description: "o convênio/plano odontológico do paciente, ou 'particular' se não tem" },
      { key: "urgencia_dor", type: "boolean", weight: 1, description: "true se o paciente relata dor/urgência" },
      { key: "regiao", type: "string", weight: 1, description: "bairro/cidade do paciente" },
      { key: "eh_decisor", type: "boolean", weight: 1, description: "true se quem escreve decide o tratamento" },
    ],
  },
  templates: [
    { name: "odonto_followup_avaliacao", languageCode: "pt_BR", variables: ["nome"], category: "utility" },
  ],
  compliance: {
    notes:
      "Publicidade odontológica regida pelo CFO: proibido prometer resultado/cura, " +
      "anunciar preços de forma enganosa ou usar imagens 'antes/depois' como atrativo. " +
      "Revisão de conformidade obrigatória antes de uso em produção.",
  },
};
