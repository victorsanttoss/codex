import { Injectable, Logger } from "@nestjs/common";
import { LlmError } from "@sdr/core";
import {
  applyLeadDecision,
  ensureSandboxConversation,
  getConversationHistory,
  getLeadProfile,
  getNicheByName,
  getOrCreateLeadProfile,
  mergeLeadFields,
  recordInboundMessage,
  recordOutboundMessage,
  resetSandbox,
  type RetrievedChunk,
} from "@sdr/db";
import { AgentService } from "../agent/agent.service";
import { AgentConfigService } from "../agent/agent-config";
import { FieldExtractor, filterExtracted } from "../agent/field-extractor";
import { formatWhatsAppReply } from "../whatsapp/reply-format";
import { NicheService } from "../niche/niche.service";
import { KnowledgeRetriever } from "../knowledge/knowledge-retriever.service";
import { buildConversationMessages } from "../agent/context-builder";
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
} from "../agent/prompt-builder";
import { decideQualification, decisionToLeadState, missingQualificationFields, qualificationActive } from "../agent/qualification";
import { buildSchedulingKickoff, contactNameFrom } from "../agent/agent-message.handler";
import { buildAgentTools, type TurnState } from "../agent/tools";
import { SchedulingConfigService } from "../calendar/scheduling-config.service";
import { SchedulingService } from "../calendar/scheduling.service";

export interface PlaygroundResult {
  reply: string;
  /** Conhecimento recuperado (RAG) com score de match, para o painel de debug. */
  retrieved: Array<{ title: string; snippet: string; score: number }>;
  /** Campos qualificados extraídos pela IA (✓/aguardando no painel). */
  fields: Record<string, unknown>;
  score: number;
  route: string;
  /** Custo da SIMULAÇÃO (micros USD). */
  costMicros: number;
  iterations: number;
}

/**
 * Playground (M14): roda o AGENTE REAL numa conversa SANDBOX e CAPTURA a resposta
 * — NÃO envia ao WhatsApp, NÃO dispara CRM/cadência (não passa pelo handler nem
 * pelo outbox). Reusa os MESMOS blocos do agente (RAG + prompt em camadas +
 * AgentService + qualificação determinística), então o teste reflete a produção.
 * Seletor de nicho: sobrepõe a guidance para simular outro vertical.
 */
@Injectable()
export class PlaygroundService {
  private readonly logger = new Logger(PlaygroundService.name);

  constructor(
    private readonly configSvc: AgentConfigService,
    private readonly agent: AgentService,
    private readonly niche: NicheService,
    private readonly retriever: KnowledgeRetriever,
    private readonly extractor: FieldExtractor,
    private readonly schedulingCfg: SchedulingConfigService,
    private readonly scheduling: SchedulingService,
  ) {}

  async reset(niche?: string): Promise<{ ok: true }> {
    await resetSandbox(niche);
    return { ok: true };
  }

  async simulate(text: string, niche?: string): Promise<PlaygroundResult> {
    const config = await this.configSvc.forTenant();
    const key = `sandbox:${niche ?? "default"}`;

    // Conversa sandbox (sandbox=true → fora do painel). Registra o inbound p/ histórico.
    await ensureSandboxConversation(niche);
    const rec = await recordInboundMessage({
      conversationKey: key,
      waId: "sandbox-tester",
      profileName: "Lead de teste",
      externalMessageId: `pg-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      type: "text",
      content: { text },
    });
    const conversationId = rec.conversationId;
    const lead = await getOrCreateLeadProfile(conversationId);

    // RAG (mesma busca do handler).
    const retrieved: RetrievedChunk[] = await this.retriever
      .search(text, { topK: config.knowledge.topK, minScore: config.knowledge.minScore })
      .catch(() => []);

    // Guidance: sobrepõe pelo nicho selecionado, se houver.
    const nicheGuidance = niche
      ? (await getNicheByName(niche).catch(() => null))?.guidance ?? null
      : await this.niche.getGuidance().catch(() => null);

    const history = await getConversationHistory(conversationId, 30);
    const conversation = buildConversationMessages(history);

    // Agendamento (0034) — MESMO fluxo da produção, mas a reserva é dryRun (a
    // simulação valida contra a agenda real sem criar compromisso).
    const schedSettings = await this.schedulingCfg.forTenant().catch(() => null);
    const schedEnabled = schedSettings?.enabled ?? false;
    const inSchedulingFlow =
      schedEnabled && (lead.status === "qualified" || lead.status === "scheduled");
    let schedPrompt: SchedulingPromptInput | null = null;
    if (inSchedulingFlow) {
      const suggestions =
        lead.status === "scheduled" ? null : await this.scheduling.suggest().catch(() => null);
      schedPrompt = {
        nowLabel: suggestions?.nowLabel ?? "",
        appointmentLabel: schedSettings?.appointmentLabel ?? "Atendimento",
        suggestions,
        bookedLabel: lead.status === "scheduled" ? "(reserva simulada no playground)" : null,
        windowLabel: schedSettings ? describeBusinessWindow(schedSettings.hours) : null,
      };
    }

    const systemPrompt = composeSystemPrompt([
      baseLayer,
      nicheLayer(nicheGuidance),
      businessLayer(config),
      tenantLayer(config),
      conversationLayer({ stage: lead.stage, summary: lead.summary, retrieved, qualification: config.qualification }),
      schedulingLayer(schedPrompt),
    ]);

    const turn: TurnState = { handoffRequested: false, fieldsUpdated: {} };
    const tools = buildAgentTools({ scheduling: schedEnabled });
    const toolCtx = {
      conversationId,
      retriever: this.retriever,
      knowledge: config.knowledge,
      qualification: config.qualification,
      turn,
      ...(schedEnabled
        ? {
            scheduling: {
              svc: this.scheduling,
              conversationId,
              dryRun: true,
              ...(contactNameFrom(lead.fields) ? { contactName: contactNameFrom(lead.fields)! } : {}),
            },
          }
        : {}),
    };

    // FALLBACK de extração — MESMO passe do handler de produção, para o Playground
    // REFLETIR a produção (antes ele só rodava o tool-calling do agente e, como o
    // 3B local é irregular em chamar a tool, a qualificação ficava sempre zerada).
    // Roda EM PARALELO com o turno (input é só a conversa); o resultado só é usado
    // se, após o turno, a descoberta continuar pendente (a tool vence). Nunca rejeita.
    const qualBefore = decideQualification(config.qualification, lead.fields);
    const extraction =
      qualificationActive(config.qualification) && qualBefore.decision === "pending"
        ? this.extractor.extract({
            conversation,
            fields: config.qualification.fields,
            missingKeys: missingQualificationFields(config.qualification, lead.fields),
            existing: lead.fields,
          })
        : null;

    let reply: string;
    let costMicros = 0;
    let iterations = 0;
    try {
      const res = await this.agent.run({
        systemPrompt,
        conversation,
        tools,
        toolCtx,
        guardrails: config.guardrails,
      });
      reply = res.text.trim() || config.fallbackMessage;
      costMicros = res.costMicros;
      iterations = res.iterations;
    } catch (err) {
      if (err instanceof LlmError) {
        // CONTENÇÃO igual à produção (handler): fallback + handoff imediato; a
        // extração paralela é DESCARTADA (não mescla campos num turno abortado) —
        // só coleta o custo, pois `extract` nunca rejeita. Sem CRM/notificação.
        this.logger.warn(`Playground: LLM indisponível (${err.message}).`);
        reply = config.fallbackMessage;
        if (extraction) costMicros += (await extraction).costMicros;
        await applyLeadDecision(conversationId, { status: "handoff", stage: "handoff" });
        await recordOutboundMessage({ conversationId, type: "text", content: { text: reply }, externalMessageId: `pg-out-${Date.now()}-${Math.round(Math.random() * 1e6)}` });
        const aborted = await getLeadProfile(conversationId);
        const abortedState = decisionToLeadState(decideQualification(config.qualification, aborted?.fields ?? {}));
        return {
          reply,
          retrieved: retrieved.map((r) => ({ title: r.title, snippet: r.content.slice(0, 180), score: Number(r.score.toFixed(3)) })),
          fields: aborted?.fields ?? {},
          score: abortedState.score,
          route: "handoff",
          costMicros,
          iterations,
        };
      }
      throw err;
    }

    // DECISÃO determinística (igual à produção; código decide). A IA preencheu via
    // a tool `update_lead_fields` OU via o passe de extração fallback abaixo.
    let fresh = await getLeadProfile(conversationId);
    let qual = decideQualification(config.qualification, fresh?.fields ?? {});

    // Extração paralela: o CUSTO conta SEMPRE que disparou (Codex: só somar no
    // merge sub-reporta a simulação); o MERGE só acontece se ainda faltam
    // campos que podem completar a descoberta e não houve handoff — campo válido da tool NÃO é
    // sobrescrito (a tool vence).
    if (extraction) {
      const ex = await extraction;
      costMicros += ex.costMicros;
      if (qual.decision === "pending" && !turn.handoffRequested) {
        const freshFields = fresh?.fields ?? {};
        const usable = filterExtracted(ex.fields, config.qualification.fields, freshFields);
        if (Object.keys(usable).length > 0) {
          await mergeLeadFields(conversationId, usable);
          turn.fieldsUpdated = { ...turn.fieldsUpdated, ...usable };
          fresh = await getLeadProfile(conversationId);
          qual = decideQualification(config.qualification, fresh?.fields ?? {});
        }
      }
    }
    const state = decisionToLeadState(qual);

    // MESMA árvore de decisão da produção para o texto que o lead receberia e o
    // estado persistido (multi-turno sandbox lê stage/status atualizados; lead
    // qualificado recebe a handoffMessage, não o texto cru do agente). Sandbox:
    // sem CRM/cadência/notificação.
    let sentText: string;
    if (turn.handoffRequested) {
      await applyLeadDecision(conversationId, { status: "handoff", stage: "handoff", score: state.score });
      sentText = config.handoffMessage;
    } else if (turn.bookedAppointment) {
      // Reserva (simulada) neste turno — mesmo estado da produção.
      await applyLeadDecision(conversationId, { status: "scheduled", stage: "scheduled", score: state.score });
      sentText = reply;
    } else if (qual.route === "handoff" && schedEnabled && !inSchedulingFlow) {
      // Transição qualificado → agendando: MESMA ponte contextual da produção
      // (responde a última fala e emenda o convite) com fallback no kickoff.
      const sug = await this.scheduling.suggest().catch(() => null);
      if (sug && (sug.manha || sug.tarde)) {
        await applyLeadDecision(conversationId, { status: "qualified", stage: "scheduling", score: state.score });
        sentText = buildSchedulingKickoff(contactNameFrom(fresh?.fields ?? {}), sug);
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
            windowLabel: schedSettings ? describeBusinessWindow(schedSettings.hours) : null,
            beyondWindow: sug.beyondWindow,
          });
          costMicros += bridge.costMicros;
          if (bridge.text) sentText = bridge.text;
        } catch {
          // Sandbox segue com o kickoff determinístico (mesmo fallback da produção).
        }
      } else {
        await applyLeadDecision(conversationId, state);
        sentText = config.handoffMessage;
      }
    } else if (qual.route === "handoff" && !schedEnabled) {
      await applyLeadDecision(conversationId, state);
      sentText = config.handoffMessage;
    } else if (inSchedulingFlow) {
      // Fase de agendamento: estado não regride (igual à produção).
      sentText = reply;
    } else {
      // Qualificação INATIVA: decisão neutra não toca o lead (igual à produção).
      if (qualificationActive(config.qualification)) await applyLeadDecision(conversationId, state);
      sentText = reply;
    }

    // Mesma formatação do WhatsApp real (sanitiza markdown/[n] + quebras de
    // bolha) — o Playground preve exatamente o que o lead receberia.
    sentText = formatWhatsAppReply(sentText).join("\n\n");

    // Persiste o outbound NA SANDBOX (multi-turno) — o texto DECIDIDO, não o cru.
    await recordOutboundMessage({ conversationId, type: "text", content: { text: sentText }, externalMessageId: `pg-out-${Date.now()}-${Math.round(Math.random() * 1e6)}` });

    return {
      reply: sentText,
      retrieved: retrieved.map((r) => ({ title: r.title, snippet: r.content.slice(0, 180), score: Number(r.score.toFixed(3)) })),
      fields: fresh?.fields ?? {},
      score: state.score,
      route: qual.route,
      costMicros,
      iterations,
    };
  }
}

