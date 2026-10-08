import type { RetrievedChunk } from "@sdr/db";
import type { AgentConfig } from "./agent-config";
import { sanitizeDescription } from "./field-extractor";
import type { QualificationSchema } from "./qualification";

/**
 * Camada do system prompt. Componível: a ordem é base → [nicho] → tenant →
 * conversa. `render` devolve null quando a camada não tem conteúdo (ex.: nicho
 * vazio no M6). Somar a camada de nicho depois NÃO muda esta assinatura (ADR 0022).
 */
export interface PromptLayer {
  name: string;
  render(): string | null;
}

export const baseLayer: PromptLayer = {
  name: "base",
  render: () =>
    "Você atende leads de WhatsApp como SDR de IA. Objetivo: entender a necessidade, " +
    "qualificar e, quando fizer sentido, encaminhar para um humano. Use as ferramentas " +
    "disponíveis quando precisar buscar conhecimento, registrar dados do lead, agendar " +
    "ou escalar para humano.\n\n" +
    // REGRAS DE RETORNO (pedido do cliente no walkthrough): parecer um atendente
    // humano no WhatsApp — curto, uma pergunta por vez, nome primeiro, sem cara
    // de robô. O picote físico em mensagens acontece no envio (reply-format).
    "Regras de estilo (WhatsApp, como um atendente humano):\n" +
    "- Mensagens CURTAS: 1 a 3 frases por mensagem e no máximo UMA pergunta por vez.\n" +
    "- Se ainda não souber o NOME do lead, sua primeira resposta deve se apresentar " +
    "brevemente e perguntar o nome de forma natural — use exatamente 'Como posso te chamar?' " +
    "ou 'Qual é o seu nome?'. NUNCA use construções estranhas como 'me chama pelo seu nome'. " +
    "Pergunte o nome antes de aprofundar qualquer assunto. " +
    "Registre via update_lead_fields o nome assim que ele disser, e também o " +
    "interesse que a primeira mensagem já revelar (ex.: lead vindo de anúncio).\n" +
    "- Responda o ESSENCIAL e conduza ao próximo passo (ex.: convidar para a " +
    "avaliação) — nunca despeje todos os detalhes de uma vez; o lead pergunta se quiser mais.\n" +
    "- Para mandar mais de uma mensagem, separe os blocos com uma linha em branco: " +
    "cada bloco vira uma mensagem separada no WhatsApp (máximo 3 blocos).\n" +
    "- Formatação: WhatsApp não entende markdown — nunca use **, ##, listas com '-' " +
    "ou títulos; no máximo *negrito* com asterisco único, com moderação.\n" +
    "- Nunca mostre marcadores de fonte, números de referência ou colchetes tipo [1].\n" +
    "- Leads FOGEM de pergunta: respondem outra coisa, emendam uma dúvida nova ou dão a " +
    "informação pela metade. SEMPRE interprete e responda PRIMEIRO o que o lead trouxe na " +
    "última mensagem (pergunta se responde; informação se reconhece de forma concreta) e SÓ " +
    "DEPOIS retome a condução de onde parou. Nunca repita a sua pergunta ignorando o que " +
    "ele acabou de dizer.\n" +
    "- Escreva SOMENTE a mensagem final ao lead, em português. NUNCA inclua seu raciocínio, " +
    "planejamento, notas internas, nomes de ferramentas ou qualquer texto em inglês. " +
    "NUNCA repita a mesma saudação, frase ou pergunta duas vezes na mesma resposta.",
};

/**
 * Camada de NICHO (M9). Injeta a orientação do nicho do tenant ENTRE base e
 * tenant, sem tocar `composeSystemPrompt` (ADR 0022). Sem nicho/orientação →
 * render null (omitida), como era no M6.
 */
export function nicheLayer(guidance: string | null): PromptLayer {
  return {
    name: "niche",
    render: () =>
      guidance && guidance.trim()
        ? `Diretrizes do segmento (nicho), use como contexto de abordagem:\n${guidance.trim()}`
        : null,
  };
}

/**
 * Camada do NEGÓCIO: o que o cliente ensinou no onboarding (produtos, tom,
 * regras do que pode/não pode falar). Entra entre nicho e persona — o nicho é
 * orientação genérica do segmento; isto são fatos e regras DESTE negócio.
 * Todos os campos vazios → render null (tenant que nunca preencheu não muda).
 */
export function businessLayer(config: AgentConfig): PromptLayer {
  return {
    name: "business",
    render: () => {
      const b = config.business;
      const parts: string[] = [];
      if (b.products) parts.push(`O que o negócio vende (produtos/serviços):\n${b.products}`);
      if (b.tone) parts.push(`Tom de voz definido pelo cliente:\n${b.tone}`);
      if (b.canSay) parts.push(`Você PODE falar/prometer:\n${b.canSay}`);
      if (b.cannotSay) parts.push(`Você NUNCA deve falar/prometer:\n${b.cannotSay}`);
      return parts.length > 0
        ? `Sobre o negócio que você representa (informado pelo dono):\n\n${parts.join("\n\n")}`
        : null;
    },
  };
}

export function tenantLayer(config: AgentConfig): PromptLayer {
  return { name: "tenant", render: () => config.persona };
}

export function conversationLayer(input: {
  stage: string;
  summary: string | null;
  retrieved: RetrievedChunk[];
  qualification: QualificationSchema;
}): PromptLayer {
  return {
    name: "conversation",
    render: () => {
      const parts: string[] = [];
      parts.push(`Etapa atual do funil: ${input.stage}.`);
      if (input.summary) parts.push(`Resumo da conversa até aqui: ${input.summary}`);
      if (input.retrieved.length > 0) {
        const kb = input.retrieved
          .map((c, i) => `[${i + 1}] (${c.title}) ${c.content}`)
          .join("\n");
        parts.push(
          // A numeração é só para VOCÊ localizar o trecho — a instrução antiga de
          // "citar a fonte entre colchetes" vazava [1] na conversa com o lead.
          "Conhecimento recuperado (use SÓ isto para fatos do produto; NUNCA mencione " +
            "os números/colchetes na resposta):\n" +
            kb,
        );
      }
      // Qualificação DESLIGADA (ou sem campos): não instrui extração nenhuma —
      // a SDR só atende (promessa da etapa 4 do wizard).
      if (input.qualification.enabled !== false && input.qualification.fields.length > 0) {
        // Descrição junto da chave: modelos pequenos não conectam a chave nua ao
        // conteúdo da conversa (mesma razão do passe de extração fallback). A
        // description vem de config não-confiável → achatada em linha única.
        const fieldList = input.qualification.fields
          .map((f) => `${f.key}${f.required ? "*" : ""} (${f.type}${f.description ? `: ${sanitizeDescription(f.description)}` : ""})`)
          .join(", ");
        parts.push(
          "Campos de qualificação a preencher conforme a conversa revelar (use a tool " +
            `update_lead_fields; * = obrigatório): ${fieldList}. ` +
            "Você NÃO decide se o lead está qualificado — apenas preenche os campos.",
        );
      }
      return parts.join("\n\n");
    },
  };
}

export interface SchedulingPromptInput {
  /** "qui, 30/07/2026 14:05" no fuso do negócio — o LLM precisa saber "hoje". */
  nowLabel: string;
  /** Ex.: "Avaliação" — como chamar o compromisso na conversa. */
  appointmentLabel: string;
  suggestions: {
    manha: { label: string; startsAt: string } | null;
    tarde: { label: string; startsAt: string } | null;
    beyondWindow: boolean;
  } | null;
  /** Reserva já confirmada da conversa (status scheduled) — gerir, não reagendar à toa. */
  bookedLabel: string | null;
  /** Funcionamento legível (ex.: "ter, qua, qui, sex, sáb e dom, das 9h às 18h") —
   * usado para contornar pedidos fora da janela SEM escalar para humano. */
  windowLabel: string | null;
}

/**
 * Camada de AGENDAMENTO (0034): só entra quando o tenant habilitou agendamento
 * pela SDR e o lead está na fase de agendar (qualificado/agendado). Os horários
 * vêm da AGENDA REAL (código) — o LLM apenas conduz a escolha e chama as tools;
 * ele nunca inventa horário.
 */
export function schedulingLayer(input: SchedulingPromptInput | null): PromptLayer {
  return {
    name: "scheduling",
    render: () => {
      if (!input) return null;
      const parts: string[] = [];
      parts.push(
        `AGENDAMENTO: seu objetivo agora é marcar a ${input.appointmentLabel} do lead. ` +
          `Agora é ${input.nowLabel} (fuso do negócio).` +
          (input.windowLabel
            ? ` Funcionamento dos atendimentos: ${input.windowLabel} — nada pode ser marcado fora disso.`
            : ""),
      );
      if (input.bookedLabel) {
        parts.push(
          `O lead JÁ TEM horário confirmado: ${input.bookedLabel}. Não ofereça novos horários ` +
            "sem ele pedir. Se pedir para REMARCAR, ofereça opções (get_available_slots) e " +
            "reserve o novo horário com book_appointment — a reserva anterior é cancelada sozinha.",
        );
      } else {
        const s = input.suggestions;
        const opts: string[] = [];
        if (s?.manha) opts.push(`manhã: ${s.manha.label} (starts_at=${s.manha.startsAt})`);
        if (s?.tarde) opts.push(`tarde: ${s.tarde.label} (starts_at=${s.tarde.startsAt})`);
        if (opts.length > 0) {
          parts.push(
            `Opções LIVRES agora — ${opts.join(" | ")}.` +
              (s?.beyondWindow
                ? " (não há vaga nas próximas 48h; avise que estes são os próximos horários livres)"
                : ""),
          );
          parts.push(
            "Pergunte se fica melhor de manhã ou à tarde já oferecendo essas duas opções. " +
              "Quando o lead escolher, chame book_appointment com o starts_at EXATO da opção. " +
              "Se ele pedir outro dia/período, use get_available_slots.",
          );
          parts.push(
            "Pedido FORA do funcionamento (ex.: à NOITE, após o horário de fechamento, ou num dia " +
              "fechado): NUNCA diga que vai 'ver horários à noite' nem prometa um período que não " +
              "existe na agenda. Deixe claro, sem rodeio, até que horas vai o atendimento e ofereça " +
              "os horários MAIS TARDE disponíveis (os mais próximos do fechamento). Se o lead insistir " +
              "em 'só à noite', seja honesto de que o mais tarde possível é perto do fechamento e " +
              "pergunte se o horário mais tarde que você tem encaixa. NUNCA escale para humano só por " +
              "causa do horário.",
          );
          parts.push(
            "HONRE a preferência de horário do lead ao oferecer: se ele quer o fim do dia / mais tarde / " +
              "'à noite', chame get_available_slots com prefer_end_of_day=true (traz os horários mais " +
              "próximos do fechamento) e ofereça ESSES; se quer de manhã, use period=manha. NUNCA " +
              "ofereça um horário que contraria o que o lead acabou de pedir sem reconhecer o descompasso " +
              "e explicar o porquê (ex.: 'depois das 18h não tenho, o mais tarde que consigo é ...').",
          );
          parts.push(
            "Se em vez de escolher horário o lead trouxer uma dúvida, objeção ou receio: " +
              "responda primeiro, com calma, e DEPOIS retome a escolha do horário. Escalar para " +
              "o time (request_human_handoff) só se o lead disser que NENHUM horário do funcionamento " +
              "serve ou pedir explicitamente para falar com uma pessoa.",
          );
        } else {
          parts.push(
            "Não consegui ver horários livres agora: use get_available_slots quando o lead " +
              "topar agendar; se a agenda seguir indisponível, ofereça encaminhar para o time.",
          );
        }
      }
      parts.push(
        "Regras do agendamento: NUNCA invente nem prometa horário fora dos retornados pelas " +
          "ferramentas; nunca mostre o starts_at ao lead (é uso interno); confirme a reserva " +
          "em mensagem curta com dia e horário.",
      );
      return parts.join("\n\n");
    },
  };
}

const DAY_NAMES_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;

/**
 * Funcionamento legível a partir das horas do tenant (ex.: "dom, ter, qua, qui,
 * sex e sáb, das 9h às 18h" — domingo=0 sai primeiro na ordenação). Vai para o
 * prompt de agendamento para o LLM contornar pedido fora da janela (ex.: "à
 * noite") sem escalar para humano.
 */
export function describeBusinessWindow(hours: {
  startHour: number;
  endHour: number;
  days: number[];
}): string {
  const days = [...new Set(hours.days)]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b)
    .map((d) => DAY_NAMES_PT[d]);
  const dayLabel =
    days.length >= 7
      ? "todos os dias"
      : days.length > 1
        ? `${days.slice(0, -1).join(", ")} e ${days[days.length - 1]}`
        : (days[0] ?? "");
  const hourLabel = `das ${hours.startHour}h às ${hours.endHour}h`;
  return dayLabel ? `${dayLabel}, ${hourLabel}` : hourLabel;
}

/** Compõe as camadas não-vazias num único system prompt. */
export function composeSystemPrompt(layers: PromptLayer[]): string {
  return layers
    .map((l) => l.render())
    .filter((s): s is string => s !== null && s.trim().length > 0)
    .join("\n\n---\n\n");
}
