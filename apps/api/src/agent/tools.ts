import type { ToolDefinition } from "@sdr/core";
import { mergeLeadFields, type RetrievedChunk } from "@sdr/db";
import type { KnowledgeRetriever } from "../knowledge/knowledge-retriever.service";
import type { SchedulingService } from "../calendar/scheduling.service";
import { normalizeLeadFields, qualificationActive, type QualificationSchema } from "./qualification";

/** Estado MUTÁVEL do turno — tools sinalizam desfechos que o código decide. */
export interface TurnState {
  handoffRequested: boolean;
  handoffReason?: string;
  schedulingIntent?: Record<string, unknown>;
  fieldsUpdated: Record<string, unknown>;
  /** Reserva CONFIRMADA neste turno via book_appointment (0034). */
  bookedAppointment?: {
    appointmentId: string;
    label: string;
    googleMirrored: boolean | null;
    rebooked: boolean;
  };
}

/** Contexto das tools de agenda (presente só com agendamento habilitado). */
export interface SchedulingToolContext {
  svc: SchedulingService;
  conversationId: string;
  contactName?: string;
  /** Playground: valida tudo mas NÃO persiste a reserva. */
  dryRun?: boolean;
}

export interface AgentToolContext {
  conversationId: string;
  retriever: KnowledgeRetriever;
  knowledge: { topK: number; minScore: number };
  qualification: QualificationSchema;
  turn: TurnState;
  scheduling?: SchedulingToolContext;
}

export interface AgentTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: AgentToolContext): Promise<string>;
}

function formatChunks(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "Nenhum trecho relevante encontrado.";
  return chunks.map((c, i) => `[${i + 1}] (${c.title}) ${c.content}`).join("\n");
}

/** RAG de acompanhamento — busca conhecimento do tenant (isolado por RLS). */
const searchKnowledge: AgentTool = {
  definition: {
    name: "search_knowledge",
    description: "Busca trechos relevantes na base de conhecimento do negócio para responder com fatos.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "o que buscar" } },
      required: ["query"],
    },
  },
  async execute(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) return "query vazia.";
    const hits = await ctx.retriever.search(query, {
      topK: ctx.knowledge.topK,
      minScore: ctx.knowledge.minScore,
    });
    return formatChunks(hits);
  },
};

/** EXTRAÇÃO: a IA preenche campos de qualificação. NÃO decide qualificação. */
const updateLeadFields: AgentTool = {
  definition: {
    name: "update_lead_fields",
    description:
      "Registra campos de qualificação descobertos na conversa (ex.: necessidade, autoridade, orcamento, prazo). Apenas registra — quem decide a qualificação é o sistema.",
    parameters: {
      type: "object",
      properties: { fields: { type: "object", description: "pares campo:valor descobertos" } },
      required: ["fields"],
    },
  },
  async execute(args, ctx) {
    if (typeof args.fields !== "object" || args.fields === null || Array.isArray(args.fields)) {
      return "fields inválido.";
    }
    const fields: Record<string, unknown> = qualificationActive(ctx.qualification)
      ? normalizeLeadFields(args.fields, ctx.qualification.fields)
      : {};
    // A persona sempre coleta o nome, inclusive em kits que não o pontuam.
    // Identidade tem whitelist própria, sem acrescentar pesos ou obrigatórios.
    const raw = args.fields as Record<string, unknown>;
    for (const key of ["nome", "name"]) {
      const value = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;
      if (typeof value === "string" && value.trim()) fields[key] = value.trim().slice(0, 80);
      else delete fields[key];
    }
    if (Object.keys(fields).length === 0) return "Nenhum campo de lead válido para registrar.";
    await mergeLeadFields(ctx.conversationId, fields);
    ctx.turn.fieldsUpdated = { ...ctx.turn.fieldsUpdated, ...fields };
    return `Campos registrados: ${Object.keys(fields).join(", ") || "(nenhum)"}.`;
  },
};

/** Escala para humano — marca o turno; o código aplica o estado/roteamento. */
const requestHumanHandoff: AgentTool = {
  definition: {
    name: "request_human_handoff",
    description: "Sinaliza que o lead deve ser atendido por um humano (dúvida fora do escopo, pedido explícito, ou lead quente).",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "motivo do handoff" } },
      required: ["reason"],
    },
  },
  async execute(args, ctx) {
    ctx.turn.handoffRequested = true;
    ctx.turn.handoffReason = String(args.reason ?? "");
    return "Handoff registrado. Encerre com uma mensagem cordial avisando que um humano assumirá.";
  },
};

/** Registra INTENÇÃO de agendamento (integração real com calendário/CRM é M7+). */
const registerSchedulingIntent: AgentTool = {
  definition: {
    name: "register_scheduling_intent",
    description: "Registra a intenção de agendamento do lead (data/horário/detalhes) de forma estruturada. Não confirma agenda real ainda.",
    parameters: {
      type: "object",
      properties: {
        when: { type: "string", description: "data/horário desejado (texto livre)" },
        details: { type: "string", description: "detalhes do agendamento" },
      },
      required: ["details"],
    },
  },
  async execute(args, ctx) {
    ctx.turn.schedulingIntent = { when: args.when, details: args.details };
    return "Intenção de agendamento registrada. (A confirmação na agenda virá em seguida pelo time.)";
  },
};

/**
 * Consulta horários LIVRES na agenda real (0034). O retorno inclui o
 * `starts_at` EXATO que o modelo deve repassar ao book_appointment — a IA
 * nunca inventa horário, só repete o que a agenda devolveu.
 */
const getAvailableSlots: AgentTool = {
  definition: {
    name: "get_available_slots",
    description:
      "Consulta horários LIVRES na agenda do negócio para oferecer ao lead (use quando ele pedir outro período ou outro dia). Cada opção vem com o starts_at exato a usar em book_appointment. Se o lead só pode no FIM do dia / mais tarde / 'à noite', passe prefer_end_of_day=true para trazer os horários mais próximos do fechamento.",
    parameters: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["manha", "tarde"],
          description: "filtrar por período do dia (opcional)",
        },
        from_day_offset: {
          type: "number",
          description: "buscar a partir de N dias à frente (0 = a partir de agora)",
        },
        prefer_end_of_day: {
          type: "boolean",
          description:
            "true = traz os horários MAIS TARDE disponíveis (fim do expediente), para lead que prefere o fim do dia/à noite",
        },
      },
      required: [],
    },
  },
  async execute(args, ctx) {
    if (!ctx.scheduling) return "Agendamento não está habilitado para este negócio.";
    const period = args.period === "manha" || args.period === "tarde" ? args.period : undefined;
    const offset =
      typeof args.from_day_offset === "number" && Number.isFinite(args.from_day_offset)
        ? Math.max(0, Math.floor(args.from_day_offset))
        : 0;
    try {
      const slots = await ctx.scheduling.svc.listSlots({
        ...(period ? { period } : {}),
        fromDayOffset: offset,
        ...(args.prefer_end_of_day === true ? { latest: true } : {}),
      });
      if (slots.length === 0) {
        return "Nenhum horário livre nesse período. Tente outro período/dia ou ofereça encaminhar para o time.";
      }
      return (
        "Horários LIVRES (ofereça no máximo 2 por mensagem, sem mostrar o starts_at ao lead):\n" +
        slots.map((s) => `- ${s.label} (${s.period}) | starts_at=${s.startsAt}`).join("\n")
      );
    } catch {
      return "Não consegui consultar a agenda agora. Ofereça encaminhar para o time confirmar o horário (request_human_handoff).";
    }
  },
};

/** RESERVA o horário escolhido — cria o compromisso de verdade (código valida). */
const bookAppointment: AgentTool = {
  definition: {
    name: "book_appointment",
    description:
      "Reserva o horário que o lead ESCOLHEU. Use o starts_at exato de uma opção oferecida (nunca invente). Se a conversa já tinha reserva, a anterior é cancelada (remarcação).",
    parameters: {
      type: "object",
      properties: {
        starts_at: {
          type: "string",
          description: "starts_at ISO exato da opção escolhida",
        },
        notes: { type: "string", description: "observação para o time (opcional)" },
      },
      required: ["starts_at"],
    },
  },
  async execute(args, ctx) {
    if (!ctx.scheduling) return "Agendamento não está habilitado para este negócio.";
    const startsAt = String(args.starts_at ?? "").trim();
    if (!startsAt) return "starts_at é obrigatório (use o valor exato de uma opção oferecida).";
    try {
      const res = await ctx.scheduling.svc.book({
        conversationId: ctx.scheduling.conversationId,
        startsAtIso: startsAt,
        ...(ctx.scheduling.contactName ? { contactName: ctx.scheduling.contactName } : {}),
        ...(typeof args.notes === "string" && args.notes.trim()
          ? { details: args.notes.trim().slice(0, 500) }
          : {}),
        dryRun: ctx.scheduling.dryRun ?? false,
      });
      if (!res.ok) {
        const alts = res.alternatives
          .map((a) => `- ${a.label} (${a.period}) | starts_at=${a.startsAt}`)
          .join("\n");
        return `NÃO reservado: ${res.reason}${alts ? `\nOfereça estas alternativas:\n${alts}` : ""}`;
      }
      ctx.turn.bookedAppointment = {
        appointmentId: res.appointmentId,
        label: res.label,
        googleMirrored: res.googleMirrored,
        rebooked: res.rebooked,
      };
      return `Reservado: ${res.label}.${res.rebooked ? " (o horário anterior foi cancelado)" : ""} Confirme ao lead em UMA mensagem curta com dia e horário.`;
    } catch {
      return "Não consegui acessar a agenda agora. Ofereça encaminhar para o time confirmar o horário (request_human_handoff).";
    }
  },
};

/**
 * Registry — nicho/vertical somam tools aqui depois, sem mexer no loop. Com
 * agendamento habilitado, as tools de agenda SUBSTITUEM o registro de intenção
 * (a reserva agora é real; a intenção era o placeholder do M7).
 */
export function buildAgentTools(opts?: { scheduling?: boolean }): AgentTool[] {
  const base = [searchKnowledge, updateLeadFields, requestHumanHandoff];
  return opts?.scheduling
    ? [...base, getAvailableSlots, bookAppointment]
    : [...base, registerSchedulingIntent];
}
