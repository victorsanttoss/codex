import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant, type LLMMessage, type ToolCall } from "@sdr/core";
import {
  closeDb,
  getLeadProfile,
  getOrCreateLeadProfile,
  makeMigrationClient,
  mergeLeadFields,
  recordInboundMessage,
} from "@sdr/db";
import { AgentMessageHandler } from "./agent-message.handler";
import { AgentService } from "./agent.service";
import { DEFAULT_AGENT_CONFIG, type AgentConfigService } from "./agent-config";
import { FieldExtractor } from "./field-extractor";
import { IMOBILIARIO_KIT } from "../verticals/kits/imobiliario";
import type { QualificationSchema } from "./qualification";
import type { LlmService } from "../llm/llm.service";
import type { KnowledgeRetriever } from "../knowledge/knowledge-retriever.service";
import type { LeadOutcomeService } from "../crm/lead-outcome.service";
import type { CadenceService } from "../cadence/cadence.service";
import type { NicheService } from "../niche/niche.service";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

function llmForTurn(toolFields?: Record<string, unknown>, extracted = "{}"): LlmService {
  let calledTool = false;
  return {
    async complete(req: { messages: LLMMessage[] }) {
      const extracting = String(req.messages[0]?.content).includes("extrai dados estruturados");
      const toolCalls: ToolCall[] = !extracting && toolFields && !calledTool
        ? [{ id: "qualification-test", name: "update_lead_fields", arguments: { fields: toolFields } }]
        : [];
      if (toolCalls.length > 0) calledTool = true;
      return {
        content: extracting ? extracted : "Você tem saldo de FGTS disponível?",
        toolCalls,
        usage: { tokensIn: 1, tokensOut: 1 },
        finishReason: "stop",
        providerId: "test",
        model: "test",
        costMicros: 7,
      };
    },
  } as unknown as LlmService;
}

describe.skipIf(!dbConfigured)("D05 — descoberta imobiliária em múltiplos turnos", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  let tenantId: string;

  beforeAll(async () => {
    mig = makeMigrationClient();
    const [tenant] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('QUALIFICATION TEST', ${`qualification-${randomUUID()}`}) RETURNING id`;
    tenantId = tenant!.id;
  });

  afterAll(async () => {
    await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await mig.sql.end();
    await closeDb();
  });

  function handler(llm: LlmService, qualification = IMOBILIARIO_KIT.qualificationSchema, cadenceArmed: string[] = []): AgentMessageHandler {
    return new AgentMessageHandler(
      new AgentService(llm),
      { async forTenant() { return { ...DEFAULT_AGENT_CONFIG, qualification }; } } as unknown as AgentConfigService,
      { async search() { return []; } } as unknown as KnowledgeRetriever,
      { async onTurnEnd() {} } as unknown as LeadOutcomeService,
      { async onInbound() {}, async armFirstStep(conversationId: string) { cadenceArmed.push(conversationId); } } as unknown as CadenceService,
      { async getGuidance() { return null; } } as unknown as NicheService,
      new FieldExtractor(llm),
    );
  }

  async function inbound(conversationKey: string, text: string, llm: LlmService, qualification?: QualificationSchema) {
    return runWithTenant({ tenantId }, async () => {
      const externalMessageId = `qualification-${randomUUID()}`;
      const rec = await recordInboundMessage({
        conversationKey,
        waId: conversationKey,
        externalMessageId,
        type: "text",
        content: { text },
      });
      const replies: string[] = [];
      const cadenceArmed: string[] = [];
      await handler(llm, qualification, cadenceArmed).handle({
        tenantId,
        conversationId: rec.conversationId,
        conversationKey,
        from: conversationKey,
        message: { externalMessageId, type: "text", text },
        reply: async (reply) => void replies.push(reply),
      });
      return { lead: await getLeadProfile(rec.conversationId), replies, cadenceArmed };
    });
  }

  it("não descarta após obrigatórios e usa fallback para o opcional do turno seguinte", async () => {
    const key = `qualification-${randomUUID()}`;
    const first = await inbound(key, "Sou Ana, renda familiar 4500 e não tenho imóvel.", llmForTurn({
      nome: "Ana", renda_familiar: 4500, possui_imovel: false,
    }));
    expect(first.lead).toMatchObject({ status: "new", stage: "qualifying", score: 4 });
    expect(first.replies).toHaveLength(1);
    expect(first.cadenceArmed).toHaveLength(1);

    const second = await inbound(key, "Não tenho FGTS disponível.", llmForTurn(undefined, '{"fgts_disponivel":false}'));
    expect(second.lead).toMatchObject({ status: "qualified", score: 5, fields: { fgts_disponivel: false, possui_imovel: false } });
    expect(second.replies).toEqual([DEFAULT_AGENT_CONFIG.handoffMessage]);
    expect(second.cadenceArmed).toHaveLength(0);
  });

  it("seleciona e repara renda inválida legada sem perder negativas já informadas", async () => {
    const key = `qualification-${randomUUID()}`;
    await runWithTenant({ tenantId }, async () => {
      const rec = await recordInboundMessage({
        conversationKey: key, waId: key, externalMessageId: `legacy-${randomUUID()}`,
        type: "text", content: { text: "Dados anteriores" },
      });
      await getOrCreateLeadProfile(rec.conversationId);
      await mergeLeadFields(rec.conversationId, { nome: "Ana", renda_familiar: "não sei", possui_imovel: false, fgts_disponivel: false });
    });
    const corrected = await inbound(key, "Nossa renda é 4200.", llmForTurn(undefined, '{"renda_familiar":"4200"}'));
    expect(corrected.lead).toMatchObject({ status: "qualified", score: 5, fields: { renda_familiar: 4200, possui_imovel: false, fgts_disponivel: false } });
    expect(corrected.replies).toHaveLength(1);
  });

  it("eliminatório permanece ativo e renda corrigida pelo lead substitui o fato anterior", async () => {
    const qualification: QualificationSchema = {
      qualifyAtScore: 1,
      fields: [{ key: "renda_familiar", type: "number", required: true, weight: 1, eliminatory: { min: 1000 } }],
    };
    const key = `qualification-${randomUUID()}`;
    const first = await inbound(key, "A renda é 500.", llmForTurn({ renda_familiar: 500 }), qualification);
    expect(first.lead).toMatchObject({ status: "disqualified", fields: { renda_familiar: 500 } });
    expect(first.cadenceArmed).toHaveLength(0);
    const correction = await inbound(key, "Corrigindo: somando a família é 4200.", llmForTurn({ renda_familiar: 4200 }), qualification);
    expect(correction.lead).toMatchObject({ status: "qualified", score: 1, fields: { renda_familiar: 4200 } });
    expect(correction.replies).toEqual([DEFAULT_AGENT_CONFIG.handoffMessage]);
  });
});
