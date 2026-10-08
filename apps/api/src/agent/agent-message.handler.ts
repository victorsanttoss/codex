import { Injectable, Logger, Optional } from "@nestjs/common";
import { LlmError } from "@sdr/core";
import {
  getConversationHistory,
  getLeadProfile,
  getOrCreateLeadProfile,
  isHumanTakeover,
  isContactOptedOut,
  mergeLeadFields,
  setLeadSummary,
  type AgentTurnPlan,
  type LeadDecisionUpdate,
} from "@sdr/db";
import type {
  InboundMessageContext,
  InboundMessageHandler,
} from "../whatsapp/message-handler";
import { KnowledgeRetriever } from "../knowledge/knowledge-retriever.service";
import { LeadOutcomeService } from "../crm/lead-outcome.service";
import { CadenceService } from "../cadence/cadence.service";
import { NicheService } from "../niche/niche.service";
import { isOptOutText } from "../cadence/optout";
import { AgentService } from "./agent.service";
import { AgentConfigService } from "./agent-config";
import { FieldExtractor, filterExtracted } from "./field-extractor";
import { AgentTurnService } from "./agent-turn.service";
import { buildConversationMessages } from "./context-builder";
import {
  baseLayer,
  businessLayer,
  composeSystemPrompt,
  conversationLayer,
  describeBusinessWindow,
  nicheLayer,
  schedulingLayer,
  tenantLayer,
  type SchedulingPromptInput,
} from "./prompt-builder";
import {
  decideQualification,
  decisionToLeadState,
  qualificationActive,
  missingQualificationFields,
} from "./qualification";
import { buildAgentTools, type TurnState } from "./tools";
import { TenantCostGuard } from "./tenant-cost-guard";
import { SchedulingConfigService } from "../calendar/scheduling-config.service";
import {
  SchedulingService,
  type SuggestionPair,
} from "../calendar/scheduling.service";

const SUMMARY_THRESHOLD = 20; // gera resumo rolante quando o histórico passa disto
const SUMMARY_EVERY_TURNS = 5; // acima do threshold, resume a cada N turnos (~2 msgs/turno)
const SUMMARY_HISTORY_BUDGET = 1200; // histórico menor quando já existe resumo (tokens)
const HISTORY_BUDGET = 3000;
const MIN_RAG_QUERY_CHARS = 12; // "oi"/"ok" não valem embed+busca (a tool cobre o resto)

/**
 * O AGENTE ligado no seam `INBOUND_HANDLER` (substitui o EchoMessageHandler do
 * M2). Roda no contexto do tenant, dentro do FIFO por conversa e do worker (com
 * retry). O plano persistido permite retomar entrega e efeitos sem gerar de novo
 * a resposta; entregas ambíguas permanecem registradas para intervenção.
 */
@Injectable()
export class AgentMessageHandler implements InboundMessageHandler {
  private readonly logger = new Logger(AgentMessageHandler.name);

  /**
   * Contador in-process de turnos acima do threshold, por conversa — dispara o
   * resumo só PERIODICAMENTE (não a cada turno). Por-processo é suficiente: o
   * resumo é best-effort e a pior consequência é resumir num turno diferente.
   */
  private readonly summaryTurns = new Map<string, number>();

  constructor(
    private readonly agent: AgentService,
    private readonly configSvc: AgentConfigService,
    private readonly retriever: KnowledgeRetriever,
    private readonly outcome: LeadOutcomeService,
    private readonly cadence: CadenceService,
    private readonly niche: NicheService,
    private readonly extractor: FieldExtractor,
    // @Optional: construções manuais em teste (7 args) seguem válidas; em produção
    // o Nest injeta o guard de custo agregado por tenant.
    @Optional() private readonly costGuard?: TenantCostGuard,
    // @Optional pela mesma razão; sem eles o agendamento fica desligado (testes
    // antigos e construções manuais preservam o comportamento pré-0034).
    @Optional() private readonly schedulingCfg?: SchedulingConfigService,
    @Optional() private readonly scheduling?: SchedulingService,
    @Optional() private readonly turns?: AgentTurnService,
  ) {}

  async handle(ctx: InboundMessageContext): Promise<void> {
    const turns =
      this.turns ?? new AgentTurnService(this.outcome, this.cadence);
    await turns.process(ctx, () => this.buildPlan(ctx));
  }

  async resume(ctx: InboundMessageContext): Promise<void> {
    const turns =
      this.turns ?? new AgentTurnService(this.outcome, this.cadence);
    await turns.resume(ctx);
  }

  private async buildPlan(ctx: InboundMessageContext): Promise<AgentTurnPlan> {
    const config = await this.configSvc.forTenant();
    const suppressed = (): AgentTurnPlan => ({
      replyText: "",
      outcome: null,
      decision: null,
    });

    // A falha precisa propagar: não confirmamos opt-out que não foi persistido.
    if (
      ctx.message.type === "text" &&
      ctx.message.text &&
      isOptOutText(ctx.message.text)
    ) {
      await this.cadence.optOut(ctx.conversationId, ctx.from);
      return {
        replyText: config.optOutMessage,
        outcome: null,
        decision: null,
        allowOptOutReply: true,
      };
    }
    await this.cadence.onInbound(ctx.conversationId);
    if (await isContactOptedOut(ctx.from)) return suppressed();

    // M14: humano ASSUMIU a conversa → IA pausa nela (não responde). Guardrail no
    // mesmo lugar dos demais (cadência); a lógica do agente não muda. Vem DEPOIS do
    // opt-out para não bloquear a saída do lead (LGPD).
    if (await isHumanTakeover(ctx.conversationId)) {
      this.logger.log(
        `Conversa ${ctx.conversationId} em atendimento humano — IA pausada.`,
      );
      return suppressed();
    }

    const lead = await getOrCreateLeadProfile(ctx.conversationId);

    // Agendamento (0034) habilitado para o tenant? Muda o pós-qualificação: em
    // vez de silenciar o lead qualificado, a SDR conduz a marcação do horário.
    const schedSettings = this.schedulingCfg
      ? await this.schedulingCfg.forTenant().catch(() => null)
      : null;
    const schedEnabled = (schedSettings?.enabled ?? false) && !!this.scheduling;

    // Lead JÁ escalado: handoff sempre silencia (humano assume); qualified só
    // silencia SEM agendamento (comportamento pré-0034 — repetir a
    // handoffMessage a cada inbound vira spam). Com agendamento, qualified e
    // scheduled continuam conversando (escolher horário / remarcar).
    if (
      lead.status === "handoff" ||
      (lead.status === "qualified" && !schedEnabled)
    ) {
      this.logger.log(
        `Conversa ${ctx.conversationId} já escalada (status ${lead.status}) — sem resposta da IA.`,
      );
      return suppressed();
    }

    // Mensagem não-texto (áudio/imagem): política graciosa. Transcrição é futuro.
    if (ctx.message.type !== "text" || !ctx.message.text) {
      return {
        replyText: config.nonTextMessage,
        outcome: null,
        decision: null,
      };
    }
    const userText = ctx.message.text;

    // TETO DE CUSTO AGREGADO por tenant/dia (achado pentest): os guardrails
    // por-turno não impedem custo ilimitado ao longo do dia. RESERVA ATÔMICA
    // ANTES de qualquer chamada ao LLM/embeddings (achado Codex: GET-antes/
    // INCRBY-depois era bypassável por corrida) — reserva o teto-por-turno (máximo
    // que este turno pode gastar) e só prossegue se ainda couber. As saídas canned
    // acima (opt-out/LGPD, handoff, não-texto) já retornaram e continuam
    // funcionando mesmo estourado. `costReserved` é reconciliado no fim.
    let costReserved = 0;
    if (this.costGuard) {
      const cap = config.guardrails.maxCostMicrosPerDay;
      const perTurn = config.guardrails.maxCostMicrosPerTurn;
      const { allowed, reserved } = await this.costGuard.reserve(
        ctx.tenantId,
        cap,
        perTurn,
      );
      costReserved = reserved;
      if (!allowed) {
        this.logger.error(
          `Teto diário de custo atingido (tenant ${ctx.tenantId}, cap ${cap} micros) — LLM suprimido nesta conversa.`,
        );
        // A reserva deste turno NÃO gastou LLM — devolve para não inflar demais.
        await this.costGuard.reconcile(ctx.tenantId, reserved, 0);
        // Contenção canned UMA vez por dia (não spamar a cada inbound).
        if (await this.costGuard.claimContentionNotice(ctx.tenantId)) {
          return {
            replyText: config.fallbackMessage,
            outcome: null,
            decision: null,
          };
        }
        return suppressed();
      }
    }

    // Pré-trabalho INDEPENDENTE em paralelo (latência): RAG proativo (pulado em
    // mensagem trivial — o modelo ainda tem a tool search_knowledge), histórico
    // e orientação de nicho. Nada aqui depende um do outro.
    const [retrieved, history, nicheGuidance] = await Promise.all([
      userText.trim().length < MIN_RAG_QUERY_CHARS
        ? Promise.resolve([])
        : this.safeSearch(userText, config.knowledge),
      getConversationHistory(ctx.conversationId, 30),
      this.niche.getGuidance().catch(() => null),
    ]);

    // Com resumo rolante, o contexto antigo já está comprimido no system prompt —
    // orçamento de histórico menor (menos tokens por turno).
    const conversation = buildConversationMessages(
      history,
      lead.summary ? SUMMARY_HISTORY_BUDGET : HISTORY_BUDGET,
    );
    // Camada de agendamento: só quando o lead está na FASE de agendar (a
    // sugestão consulta agenda interna + Google — não paga esse custo em lead
    // ainda em qualificação; a transição usa o kickoff determinístico abaixo).
    const inSchedulingFlow =
      schedEnabled &&
      (lead.status === "qualified" || lead.status === "scheduled");
    let schedPrompt: SchedulingPromptInput | null = null;
    if (inSchedulingFlow && this.scheduling) {
      const [suggestions, bookedLabel] = await Promise.all([
        lead.status === "scheduled"
          ? Promise.resolve(null)
          : this.scheduling.suggest().catch(() => null),
        lead.status === "scheduled"
          ? this.scheduling
              .activeBookingLabel(ctx.conversationId)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      schedPrompt = {
        nowLabel: suggestions?.nowLabel ?? nowLabelFallback(),
        appointmentLabel: schedSettings?.appointmentLabel ?? "Atendimento",
        suggestions,
        bookedLabel,
        windowLabel: schedSettings
          ? describeBusinessWindow(schedSettings.hours)
          : null,
      };
    }

    const systemPrompt = composeSystemPrompt([
      baseLayer,
      nicheLayer(nicheGuidance),
      businessLayer(config),
      tenantLayer(config),
      conversationLayer({
        stage: lead.stage,
        summary: lead.summary,
        retrieved,
        qualification: config.qualification,
      }),
      schedulingLayer(schedPrompt),
    ]);

    const turn: TurnState = { handoffRequested: false, fieldsUpdated: {} };
    const tools = buildAgentTools({ scheduling: schedEnabled });
    const toolCtx = {
      conversationId: ctx.conversationId,
      retriever: this.retriever,
      knowledge: config.knowledge,
      qualification: config.qualification,
      turn,
      ...(schedEnabled && this.scheduling
        ? {
            scheduling: {
              svc: this.scheduling,
              conversationId: ctx.conversationId,
              ...(contactNameFrom(lead.fields)
                ? { contactName: contactNameFrom(lead.fields)! }
                : {}),
            },
          }
        : {}),
    };

    // FALLBACK de extração (qualificação irregular de modelos pequenos) EM
    // PARALELO com o turno do agente: o input é só a conversa (não depende da
    // resposta), então rodar em série só somava a latência de uma completion.
    // Dispara apenas quando JÁ faltavam obrigatórios antes do turno; o resultado
    // só é usado se, após o turno, ainda faltarem campos (tool-call vence).
    // `extract` nunca rejeita (best-effort interno).
    const qualBefore = decideQualification(config.qualification, lead.fields);
    const extraction =
      qualBefore.decision === "pending" &&
      missingQualificationFields(config.qualification, lead.fields).length > 0
        ? this.extractor.extract({
            conversation,
            fields: config.qualification.fields,
            missingKeys: missingQualificationFields(
              config.qualification,
              lead.fields,
            ),
            existing: lead.fields,
          })
        : null;

    let text: string;
    let turnCostMicros = 0;
    try {
      const res = await this.agent.run({
        systemPrompt,
        conversation,
        tools,
        toolCtx,
        guardrails: config.guardrails,
      });
      text = res.text.trim() || config.fallbackMessage;
      turnCostMicros = res.costMicros;
    } catch (err) {
      // GUARDRAIL: todos os provedores falharam — contenção + handoff, sem quebrar
      // e sem duplicar (reply é idempotente).
      // Custo do turno abortado é ~0 (agent.run não completou): devolve a reserva
      // (achado Codex: sem isto, a reserva ficava presa e podia esgotar o cap
      // diário durante um outage do provedor de LLM).
      if (this.costGuard) {
        void this.costGuard
          .reconcile(ctx.tenantId, costReserved, turnCostMicros)
          .catch(() => undefined);
      }
      if (err instanceof LlmError) {
        this.logger.error(
          `LLM indisponível (${err.message}) — contenção + handoff.`,
        );
        return {
          replyText: config.fallbackMessage,
          decision: { status: "handoff", stage: "handoff" },
          outcome: {
            conversationId: ctx.conversationId,
            phone: ctx.from,
            fields: lead.fields,
            stage: "handoff",
            status: "handoff",
            handoff: true,
            handoffReason:
              "LLM indisponível — contenção automática; lead aguardando humano.",
          },
        };
      }
      throw err;
    }

    // DECISÃO determinística (código decide; a IA só preencheu via tools).
    let fresh = await getLeadProfile(ctx.conversationId);
    let qual = decideQualification(config.qualification, fresh?.fields ?? {});

    // Usa o passe de extração (que correu em paralelo) SÓ se o turno terminou com
    // obrigatórios faltando e sem handoff pedido pela tool. Campos que a tool já
    // preencheu durante o turno NÃO são sobrescritos (tool vence).
    if (extraction && qual.decision === "pending" && !turn.handoffRequested) {
      const ex = await extraction;
      turnCostMicros += ex.costMicros;
      const freshFields = fresh?.fields ?? {};
      const usable = filterExtracted(
        ex.fields,
        config.qualification.fields,
        freshFields,
      );
      if (Object.keys(usable).length > 0) {
        await mergeLeadFields(ctx.conversationId, usable);
        turn.fieldsUpdated = { ...turn.fieldsUpdated, ...usable };
        fresh = await getLeadProfile(ctx.conversationId);
        qual = decideQualification(config.qualification, fresh?.fields ?? {});
      }
    }
    const state = decisionToLeadState(qual);

    // RECONCILIA a reserva para o custo REAL do turno (best-effort, fora do
    // caminho crítico da resposta). Ajusta `turnCostMicros - costReserved` no
    // contador diário — se o real ficou abaixo da reserva, devolve a diferença.
    if (this.costGuard) {
      void this.costGuard
        .reconcile(ctx.tenantId, costReserved, turnCostMicros)
        .catch((err) =>
          this.logger.warn(
            `Falha ao reconciliar custo do turno: ${err instanceof Error ? err.message : err}`,
          ),
        );
    }

    let decision: LeadDecisionUpdate | null = null;
    let sentText: string;
    let finalStatus: string;
    let finalStage: string;
    let isHandoff = turn.handoffRequested;
    if (turn.handoffRequested) {
      finalStatus = "handoff";
      finalStage = "handoff";
      decision = { status: finalStatus, stage: finalStage, score: state.score };
      sentText = config.handoffMessage;
    } else if (turn.bookedAppointment) {
      // RESERVA feita neste turno (book_appointment): lead vira `scheduled`; a
      // resposta do LLM já confirma dia/horário (instrução da tool).
      finalStatus = "scheduled";
      finalStage = "scheduled";
      decision = { status: finalStatus, stage: finalStage, score: state.score };
      sentText = text;
    } else if (qual.route === "handoff" && schedEnabled && !inSchedulingFlow) {
      // QUALIFICOU agora com agendamento LIGADO (0034): em vez do handoff, o
      // kickoff determinístico do agendamento — pergunta manhã/tarde já com dois
      // horários REAIS da agenda. Agenda lotada/indisponível → handoff clássico.
      const sug = this.scheduling
        ? await this.scheduling.suggest().catch(() => null)
        : null;
      if (sug && (sug.manha || sug.tarde)) {
        finalStatus = "qualified";
        finalStage = "scheduling";
        decision = {
          status: finalStatus,
          stage: finalStage,
          score: state.score,
        };
        // PONTE CONTEXTUAL (feedback do teste real 06/10): o kickoff enlatado
        // atropelava a última fala do lead (ex.: ele informa a renda e recebe
        // "vamos agendar" sem nexo). A ponte via LLM responde a fala e EMENDA o
        // convite com as MESMAS opções reais; falha/vazio → kickoff determinístico.
        sentText = buildSchedulingKickoff(
          contactNameFrom(fresh?.fields ?? {}),
          sug,
        );
        try {
          const options = [
            sug.manha ? `${sug.manha.label} (manhã)` : null,
            sug.tarde ? `${sug.tarde.label} (tarde)` : null,
          ]
            .filter((o): o is string => o !== null)
            .join(" ou ");
          const bridge = await this.agent.bridgeToScheduling({
            conversation,
            appointmentLabel: schedSettings?.appointmentLabel ?? "visita",
            options,
            windowLabel: schedSettings
              ? describeBusinessWindow(schedSettings.hours)
              : null,
            beyondWindow: sug.beyondWindow,
          });
          if (bridge.costMicros > 0 && this.costGuard) {
            // Mesmo padrão best-effort do summarize — fora do caminho do reply.
            void this.costGuard
              .addCost(ctx.tenantId, bridge.costMicros)
              .catch(() => undefined);
          }
          if (bridge.text) sentText = bridge.text;
        } catch (err) {
          this.logger.warn(
            `Ponte de agendamento falhou (seguindo com kickoff padrão): ${err instanceof Error ? err.message : err}`,
          );
        }
      } else {
        isHandoff = true;
        finalStatus = state.status;
        finalStage = state.stage;
        decision = state;
        sentText = config.handoffMessage;
      }
    } else if (qual.route === "handoff" && !schedEnabled) {
      // Lead QUALIFICADO: escala DETERMINISTICAMENTE — não depende de a IA chamar a tool.
      isHandoff = true;
      finalStatus = state.status;
      finalStage = state.stage;
      decision = state;
      sentText = config.handoffMessage;
    } else if (inSchedulingFlow) {
      // Fase de agendamento: o estado NÃO regride nem re-dispara transição — o
      // lead segue qualified (escolhendo horário) ou scheduled (pós-reserva).
      finalStatus = lead.status;
      finalStage = lead.stage;
      sentText = text;
    } else if (qualificationActive(config.qualification)) {
      finalStatus = state.status;
      finalStage = state.stage;
      decision = state;
      sentText = text;
    } else {
      // Qualificação INATIVA (desligada/sem campos): a decisão neutra NÃO toca o
      // lead — não move estágio nem reabre desqualificado (achado Codex). CRM/
      // cadência veem o estado REAL do lead, que segue como estava.
      finalStatus = fresh?.status ?? "new";
      finalStage = fresh?.stage ?? lead.stage;
      sentText = text;
    }
    const intent = turn.schedulingIntent;
    const plan: AgentTurnPlan = {
      replyText: sentText,
      decision,
      armCadence: finalStatus === "new",
      outcome: {
        conversationId: ctx.conversationId,
        phone: ctx.from,
        fields: fresh?.fields ?? {},
        stage: finalStage,
        status: finalStatus,
        score: state.score,
        handoff: isHandoff,
        ...(turn.handoffReason ? { handoffReason: turn.handoffReason } : {}),
        ...(intent
          ? {
              scheduling: {
                details: String(intent.details ?? "Agendamento solicitado"),
                ...(typeof intent.when === "string"
                  ? { when: intent.when }
                  : {}),
              },
            }
          : {}),
        ...(turn.bookedAppointment ? { booked: turn.bookedAppointment } : {}),
      },
    };

    // Resumo rolante em conversa longa: só PERIODICAMENTE (a cada N turnos acima
    // do threshold) e FORA do caminho da resposta (fire-and-forget — não segura o
    // lock da conversa; a corrida com o próximo turno é benigna).
    if (
      history.length >= SUMMARY_THRESHOLD &&
      this.shouldSummarize(ctx.conversationId)
    ) {
      void this.agent
        .summarize([...conversation, { role: "assistant", content: sentText }])
        .then(async (res) => {
          // O resumo também consome LLM — contabiliza no teto diário (achado
          // Codex: senão vira custo invisível ao cap em conversa longa).
          if (this.costGuard && res.costMicros > 0) {
            await this.costGuard
              .addCost(ctx.tenantId, res.costMicros)
              .catch(() => undefined);
          }
          if (res.summary)
            await setLeadSummary(ctx.conversationId, res.summary);
        })
        .catch((err) =>
          this.logger.warn(
            `Falha ao resumir conversa: ${err instanceof Error ? err.message : err}`,
          ),
        );
    }
    return plan;
  }

  /** 1º turno acima do threshold resume; depois, a cada SUMMARY_EVERY_TURNS. */
  private shouldSummarize(conversationId: string): boolean {
    // teto tosco de memória: zera o mapa se crescer demais (contador é heurística).
    if (this.summaryTurns.size > 10_000) this.summaryTurns.clear();
    const n = (this.summaryTurns.get(conversationId) ?? 0) + 1;
    this.summaryTurns.set(conversationId, n);
    return n % SUMMARY_EVERY_TURNS === 1;
  }

  private async safeSearch(
    query: string,
    knowledge: { topK: number; minScore: number },
  ) {
    try {
      return await this.retriever.search(query, {
        topK: knowledge.topK,
        minScore: knowledge.minScore,
      });
    } catch (err) {
      this.logger.warn(
        `RAG falhou (seguindo sem conhecimento): ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }
}

/** Nome do lead a partir dos campos qualificados (chaves usuais dos kits). */
export function contactNameFrom(
  fields: Record<string, unknown>,
): string | null {
  const v = fields.nome ?? fields.name;
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null;
}

/**
 * Kickoff DETERMINÍSTICO da fase de agendamento (transição qualificado →
 * agendando): pergunta manhã/tarde já com os dois horários reais. Template em
 * código (não LLM) — mesma família da handoffMessage: transição auditável.
 */
export function buildSchedulingKickoff(
  name: string | null,
  sug: SuggestionPair,
): string {
  const oi = name ? `Perfeito, ${name}! 🙌` : "Perfeito! 🙌";
  const both = sug.manha && sug.tarde;
  let question: string;
  if (both) {
    question = sug.beyondWindow
      ? `Os horários mais próximos que tenho livres são ${sug.manha!.label} (manhã) ou ${sug.tarde!.label} (tarde). Algum deles fica bom para você?`
      : `Fica melhor para você de manhã ou à tarde? Tenho ${sug.manha!.label} ou ${sug.tarde!.label} disponíveis.`;
  } else {
    const only = (sug.manha ?? sug.tarde)!;
    question = sug.beyondWindow
      ? `O horário mais próximo que tenho livre é ${only.label}. Fica bom para você?`
      : `Tenho ${only.label} disponível. Fica bom para você?`;
  }
  return `${oi} Vamos deixar seu horário agendado.\n\n${question}`;
}

/** Fallback do rótulo de "agora" quando a sugestão falhou (fuso padrão BR). */
function nowLabelFallback(): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
}
