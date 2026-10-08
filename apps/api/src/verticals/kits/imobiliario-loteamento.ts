import type { VerticalKit } from "../vertical-kit";

/**
 * VERTICAL: Imobiliário — LOTEAMENTO/TERRENOS. Pesquisa ago/2026: dois perfis
 * (construir a casa própria × investidor de longo prazo), financiamento DIRETO
 * com a loteadora (aceita autônomo, 150-240x, correção IPCA/INPC — não juros
 * bancários) é o grande diferencial; a visita ao loteamento muda a conversa.
 * Genérico (sem PII).
 */
export const IMOBILIARIO_LOTEAMENTO_KIT: VerticalKit = {
  version: "1.0.0",
  niche: { name: "imobiliario_loteamento_br", vertical: "imobiliario", motion: "orcamento_cotacao" },
  resourceNoun: { singular: "corretor", plural: "corretores" },
  guidance:
    "Você é a SDR de um loteamento. Objetivo: entender o plano (construir a casa própria × " +
    "investir), qualificar a condição de parcelamento e levar à VISITA AO LOTEAMENTO no fim de " +
    "semana com um corretor. TÉCNICA: (1) UMA pergunta por mensagem, tom simples e próximo; " +
    "(2) a primeira bifurcação é 'construir pra morar ou investir pra valorizar?'; (3) o " +
    "diferencial-chave é o parcelamento DIRETO com a loteadora — sem banco, análise " +
    "simplificada que aceita autônomo, entrada facilitada e até 150-240 parcelas com correção " +
    "por inflação (não juros bancários) — use isso cedo com quem teme financiamento; " +
    "(4) sempre proponha a visita ('vendo o local, a conversa muda de figura'); (5) termine " +
    "todo turno com próximo passo; (6) prova de valorização = fases anteriores e empreendimentos " +
    "vizinhos (dados reais da base de conhecimento — nunca invente percentual); (7) não prometa " +
    "prazo de infraestrutura sem lastro no cronograma registrado. Não invente preço de lote, " +
    "posição ou disponibilidade: consulte a base; se não souber, o corretor confirma.",
  knowledge: [
    { type: "qualifying_question", content: "Bifurcação: 'Seu plano é construir pra morar ou é mais um investimento pra valorizar?' Se construir: 'Pra quando você imagina começar a obra?' (alguns loteamentos liberam construção desde o início)." },
    { type: "qualifying_question", content: "Vínculo com a região: 'Você já conhece a região do loteamento? Tem família ou trabalho por perto?' e preferências de lote (tamanho, esquina × meio de quadra)." },
    { type: "qualifying_question", content: "Condição sem susto: 'Você teria um valor de entrada, mesmo pequeno? Aqui o parcelamento é direto com a loteadora, sem banco.' e 'Que valor de parcela mensal ficaria confortável?'" },
    { type: "qualifying_question", content: "Renda sem burocracia: 'Sua renda é registrada ou por conta própria? Pergunto porque nossa análise aceita autônomo — é bem mais simples que banco.'" },
    { type: "qualifying_question", content: "Rumo à visita: 'Consegue vir conhecer o loteamento no fim de semana? Vendo o local, a conversa muda de figura.'" },
    { type: "objection_handling", content: "'Terreno não dá retorno': mostrar valorização CONCRETA de fases anteriores e empreendimentos vizinhos da mesma região (dados da base); lote é ativo tangível com manutenção quase zero e sem condomínio (em loteamento aberto)." },
    { type: "objection_handling", content: "'E se a infraestrutura atrasar?': mostrar o que JÁ está pronto (asfalto, energia, água) e o cronograma registrado em cartório; infra concluída = valorização imediata — o ganho já está contratado." },
    { type: "objection_handling", content: "'É longe de tudo': região em desenvolvimento é exatamente onde se compra barato. Listar o que está chegando (comércio, escola, acesso viário) e comparar o preço/m² com o bairro consolidado vizinho." },
    { type: "objection_handling", content: "'Banco não financia terreno': 'Exato — e por isso aqui é direto com a loteadora: análise simplificada que aceita autônomo, até 150-240 parcelas, correção por IPCA/INPC em vez de juros bancários de dois dígitos.'" },
    { type: "objection_handling", content: "'E se eu não conseguir pagar depois?': proteções legais — prazo para regularizar atraso, Lei do Distrato limita retenção, quadro-resumo transparente no contrato registrado." },
    { type: "objection_handling", content: "'Vou esperar sobrar dinheiro': inverter — a parcela pequena É a poupança forçada; o lote valoriza enquanto você paga; e a tabela sobe a cada fase de vendas." },
    { type: "objection_handling", content: "'É seguro comprar de loteadora?': checagem objetiva — loteamento registrado em cartório (matrícula), quadro-resumo no contrato, e depoimentos de quem já está construindo." },
    { type: "faq", content: "Argumentos que convertem em loteamento: (1) entrada facilitada + até 150-240x direto com a loteadora, sem banco; (2) valorização comprovada por fases anteriores/vizinhança; (3) patrimônio para os filhos — o 'primeiro degrau' acessível; (4) liberdade total de projeto (construa a casa DO SEU jeito, no seu ritmo); (5) infra pronta ou com cronograma = ganho contratado." },
    { type: "vocabulary", content: "Termos de loteamento: lote, quadra, testada, m², lote de esquina, entrada facilitada, parcelamento direto, correção IPCA/INPC, quadro-resumo, alienação fiduciária, matrícula, infraestrutura (asfalto, meio-fio, drenagem, rede), loteamento aberto × condomínio fechado de lotes, fase/etapa, plantão de vendas." },
    { type: "document_request", content: "Para a análise da loteadora: documento com foto, CPF, comprovante de residência e comprovação de renda simples (formal ou informal). Orientar a separar — sem enviar documentos no chat." },
  ],
  qualificationSchema: {
    qualifyAtScore: 5,
    fields: [
      { key: "nome", type: "string", required: true, weight: 1, description: "nome da pessoa interessada" },
      { key: "finalidade", type: "string", required: true, weight: 2, description: "construir para morar ou investir" },
      { key: "prazo_obra", type: "string", weight: 1, description: "quando pretende construir (se for morar) ou horizonte do investimento" },
      { key: "entrada_disponivel", type: "string", weight: 1, description: "se tem algum valor de entrada, mesmo pequeno" },
      { key: "parcela_confortavel", type: "number", weight: 1, description: "valor de parcela mensal confortável em reais (apenas o número)" },
      { key: "regiao", type: "string", weight: 1, description: "se conhece/tem vínculo com a região do loteamento" },
    ],
  },
  templates: [
    { name: "imob_lote_visita", languageCode: "pt_BR", variables: ["nome"], category: "marketing" },
  ],
};
