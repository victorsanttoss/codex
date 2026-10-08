import { Injectable, Logger } from "@nestjs/common";
import { toolResultMessage, type LLMMessage } from "@sdr/core";
import { LlmService } from "../llm/llm.service";
import type { Guardrails } from "./agent-config";
import type { AgentTool, AgentToolContext } from "./tools";

export interface AgentRunInput {
  systemPrompt: string;
  conversation: LLMMessage[];
  tools: AgentTool[];
  toolCtx: AgentToolContext;
  guardrails: Guardrails;
}

export interface AgentRunResult {
  text: string;
  iterations: number;
  costMicros: number;
  stopReason: "completed" | "tool_cap" | "cost_cap";
}

/**
 * Loop do agente: completa via LLM com tools; executa tool calls e reenvia os
 * resultados até o modelo dar uma resposta em texto. GUARDRAILS: teto de
 * iterações de tool e teto de custo por turno — nunca loop/custo ilimitado.
 * Falha total do LLM (`LlmError`) propaga para o handler tratar (contenção).
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(private readonly llm: LlmService) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { guardrails } = input;
    const toolDefs = input.tools.map((t) => t.definition);
    const messages: LLMMessage[] = [
      { role: "system", content: input.systemPrompt },
      ...input.conversation,
    ];
    let costMicros = 0;

    for (let i = 0; i < guardrails.maxToolIterations; i++) {
      // HARD CAP: nunca faz nova chamada se o orçamento já estourou (sem custo extra).
      if (costMicros >= guardrails.maxCostMicrosPerTurn) {
        return { text: "", iterations: i, costMicros, stopReason: "cost_cap" };
      }
      const out = await this.llm.complete({ messages, tools: toolDefs, maxTokens: 1024 });
      costMicros += out.costMicros;

      if (out.toolCalls.length === 0) {
        return { text: out.content, iterations: i, costMicros, stopReason: "completed" };
      }

      messages.push({ role: "assistant", content: out.content, toolCalls: out.toolCalls });
      for (const tc of out.toolCalls) {
        const tool = input.tools.find((t) => t.definition.name === tc.name);
        // contrato do port assume objeto; defende contra provider malformado.
        const args = isPlainObject(tc.arguments) ? tc.arguments : {};
        let result: string;
        try {
          result = tool ? await tool.execute(args, input.toolCtx) : `Ferramenta desconhecida: ${tc.name}.`;
        } catch (err) {
          this.logger.warn(`Tool ${tc.name} falhou: ${err instanceof Error ? err.message : err}`);
          result = `Falha ao executar ${tc.name}.`;
        }
        messages.push(toolResultMessage(tc.id, result));
      }
    }

    // Atingiu o teto de iterações. Só força um close (SEM tools) se ainda há orçamento.
    if (costMicros >= guardrails.maxCostMicrosPerTurn) {
      return { text: "", iterations: guardrails.maxToolIterations, costMicros, stopReason: "cost_cap" };
    }
    const closing = await this.closeWithoutTools(messages);
    return {
      text: closing.text,
      iterations: guardrails.maxToolIterations,
      costMicros: costMicros + closing.cost,
      stopReason: "tool_cap",
    };
  }

  // —— helpers ——

  private async closeWithoutTools(messages: LLMMessage[]): Promise<{ text: string; cost: number }> {
    const out = await this.llm.complete({ messages, maxTokens: 512 });
    return { text: out.content, cost: out.costMicros };
  }

  /** Resumo rolante: comprime a conversa quando fica longa (controla custo/contexto).
   * Devolve o custo (micros) para contabilizar no teto diário do tenant. */
  async summarize(conversation: LLMMessage[]): Promise<{ summary: string; costMicros: number }> {
    const out = await this.llm.complete({
      maxTokens: 256,
      messages: [
        {
          role: "system",
          content:
            "Resuma a conversa abaixo em até 4 frases objetivas, preservando o que o lead quer, " +
            "dados já informados e pendências. Sem saudações.",
        },
        ...conversation,
      ],
    });
    return { summary: out.content.trim(), costMicros: out.costMicros ?? 0 };
  }

  /** Ponte da transição qualificado→agendando: responde a ÚLTIMA fala do lead e
   * emenda o convite com as opções REAIS de horário — substitui o kickoff
   * enlatado quando o LLM está de pé (texto vazio/falha → o chamador usa o
   * determinístico). Devolve o custo para o teto diário do tenant. */
  async bridgeToScheduling(input: {
    conversation: LLMMessage[];
    appointmentLabel: string;
    options: string;
    windowLabel: string | null;
    beyondWindow: boolean;
  }): Promise<{ text: string; costMicros: number }> {
    const out = await this.llm.complete({
      maxTokens: 320,
      messages: [
        {
          role: "system",
          content:
            "Você é a atendente da conversa de WhatsApp abaixo. O lead acabou de se qualificar " +
            "e o próximo passo é agendar. Escreva a PRÓXIMA mensagem dela, com duas partes " +
            "emendadas com naturalidade: (1) responda PRIMEIRO a última mensagem do lead — se " +
            "foi pergunta, responda-a; se foi uma informação (ex.: renda), reconheça-a de forma " +
            "positiva e concreta, sem prometer aprovação; (2) convide para agendar a " +
            `${input.appointmentLabel}, oferecendo exatamente estas opções: ${input.options}.` +
            (input.beyondWindow
              ? " Não há vaga nos próximos dias: deixe claro que esses são os PRÓXIMOS horários livres."
              : "") +
            (input.windowLabel ? ` O funcionamento dos atendimentos é ${input.windowLabel}.` : "") +
            " Estilo WhatsApp: frases curtas, no máximo uma pergunta, sem markdown, sem inventar " +
            "horários além dos oferecidos. Responda SÓ com a mensagem final.",
        },
        ...input.conversation,
      ],
    });
    // Resposta CORTADA pelo teto de tokens não vai para o lead (é a mensagem
    // mais importante do funil) — o chamador cai no kickoff determinístico.
    if (out.finishReason === "length") return { text: "", costMicros: out.costMicros ?? 0 };
    return { text: out.content.trim(), costMicros: out.costMicros ?? 0 };
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
