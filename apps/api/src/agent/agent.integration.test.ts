import { ReplyDeliveryError } from "../whatsapp/message-handler";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LlmError,
  runWithTenant,
  type LLMMessage,
  type ToolCall,
} from "@sdr/core";
import {
  applyLeadDecision,
  closeDb,
  getLeadProfile,
  getOrCreateLeadProfile,
  makeMigrationClient,
} from "@sdr/db";
import { AgentService } from "./agent.service";
import { AgentConfigService } from "./agent-config";
import { AgentMessageHandler } from "./agent-message.handler";
import { FieldExtractor } from "./field-extractor";
import type { LlmService } from "../llm/llm.service";
import type { KnowledgeRetriever } from "../knowledge/knowledge-retriever.service";
import type {
  LeadOutcomeService,
  TurnOutcome,
} from "../crm/lead-outcome.service";
import type { CadenceService } from "../cadence/cadence.service";
import type { NicheService } from "../niche/niche.service";
import type { InboundMessageContext } from "../whatsapp/message-handler";

const dbConfigured = Boolean(
  process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL,
);

function outcome(content: string, toolCalls: ToolCall[] = [], cost = 10) {
  return {
    content,
    toolCalls,
    usage: { tokensIn: 1, tokensOut: 1 },
    finishReason: "stop" as const,
    providerId: "fake",
    model: "m",
    costMicros: cost,
  };
}
/**
 * LLM fake ROTEADO por tipo de chamada (o extractor agora roda em PARALELO com
 * o turno do agente — a ordem das chamadas deixou de ser determinística, então
 * o script é separado por caminho, identificado pelo system prompt).
 */
function scriptedLlm(
  script: Array<ReturnType<typeof outcome>>,
  opts: {
    extract?: Array<ReturnType<typeof outcome>>;
    summary?: Array<ReturnType<typeof outcome>>;
    onSummary?: () => void;
  } = {},
): LlmService {
  const extract = opts.extract ?? [outcome("{}")]; // default: extração não acha nada
  const summary = opts.summary ?? [outcome("resumo da conversa")];
  let i = 0;
  let e = 0;
  let s = 0;
  return {
    async complete(req: { messages: LLMMessage[] }) {
      const sys =
        req.messages[0]?.role === "system"
          ? String(req.messages[0].content)
          : "";
      if (sys.includes("extrai dados estruturados")) {
        const r = extract[Math.min(e, extract.length - 1)]!;
        e++;
        return r;
      }
      if (sys.includes("Resuma a conversa")) {
        opts.onSummary?.();
        const r = summary[Math.min(s, summary.length - 1)]!;
        s++;
        return r;
      }
      const r = script[Math.min(i, script.length - 1)]!;
      i++;
      return r;
    },
  } as unknown as LlmService;
}
function throwingLlm(): LlmService {
  return {
    async complete() {
      throw new LlmError("Todos os provedores falharam", true);
    },
  } as unknown as LlmService;
}
const noKnowledge = {
  async search() {
    return [];
  },
} as unknown as KnowledgeRetriever;

function makeCtx(
  conversationId: string,
  opts: Partial<InboundMessageContext["message"]> = {},
): {
  ctx: InboundMessageContext;
  replies: string[];
} {
  const replies: string[] = [];
  const ctx: InboundMessageContext = {
    tenantId: "",
    conversationId,
    conversationKey: "ck",
    from: "5511999",
    message: {
      externalMessageId: "ext-" + randomUUID(),
      type: "text",
      text: "quero um CRM",
      ...opts,
    },
    reply: async (t: string) => void replies.push(t),
  };
  return { ctx, replies };
}

describe.skipIf(!dbConfigured)(
  "M6 — AgentMessageHandler (integração ao vivo)",
  () => {
    let mig: ReturnType<typeof makeMigrationClient>;
    let tenantId = "";

    async function seedConversation(): Promise<string> {
      return mig.sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        const [c] = await tx<{ id: string }[]>`
        INSERT INTO contacts (tenant_id, wa_id) VALUES (${tenantId}, ${"wa-" + randomUUID()}) RETURNING id`;
        const [conv] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, contact_id, conversation_key)
        VALUES (${tenantId}, ${c!.id}, ${"ck-" + randomUUID()}) RETURNING id`;
        return conv!.id;
      }) as Promise<string>;
    }

    beforeAll(async () => {
      mig = makeMigrationClient();
      const [t] = await mig.sql<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES ('AGENT', ${"agent-" + randomUUID()}) RETURNING id`;
      tenantId = t!.id;
    });
    afterAll(async () => {
      await mig.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
      await mig.sql.end();
      await closeDb();
    });

    const outcomes: TurnOutcome[] = [];
    const fakeOutcome = {
      async onTurnEnd(o: TurnOutcome) {
        outcomes.push(o);
      },
    } as unknown as LeadOutcomeService;
    const cadenceCalls: string[] = [];
    const fakeCadence = {
      async onInbound() {
        cadenceCalls.push("onInbound");
      },
      async optOut() {
        cadenceCalls.push("optOut");
      },
      async armFirstStep() {
        cadenceCalls.push("arm");
      },
    } as unknown as CadenceService;

    const fakeNiche = {
      async getGuidance() {
        return null;
      },
    } as unknown as NicheService;

    function handler(llm: LlmService): AgentMessageHandler {
      return new AgentMessageHandler(
        new AgentService(llm),
        new AgentConfigService(),
        noKnowledge,
        fakeOutcome,
        fakeCadence,
        fakeNiche,
        new FieldExtractor(llm),
      );
    }

    it("round-trip de tool + qualificação determinística + resposta", async () => {
      const conversationId = await seedConversation();
      const llm = scriptedLlm([
        outcome("", [
          {
            id: "c1",
            name: "update_lead_fields",
            arguments: {
              fields: {
                necessidade: "CRM",
                autoridade: "decisor",
                orcamento: 5000,
                prazo: "30 dias",
              },
            },
          },
        ]),
        outcome("Mais alguma coisa que você precisa?"),
      ]);
      const { ctx, replies } = makeCtx(conversationId);
      await runWithTenant({ tenantId }, () => handler(llm).handle(ctx));

      expect(replies).toHaveLength(1);
      const lead = await runWithTenant({ tenantId }, () =>
        getLeadProfile(conversationId),
      );
      expect(lead?.status).toBe("qualified"); // código decidiu (não a IA)
      expect(lead?.fields).toMatchObject({
        necessidade: "CRM",
        orcamento: 5000,
      });
      // desfecho propagado p/ a integração (CRM): qualificado escala (handoff determinístico)
      expect(outcomes.at(-1)).toMatchObject({
        status: "qualified",
        handoff: true,
      });
    });

    it("FALLBACK de extração: modelo NÃO chama a tool → passe dedicado extrai e qualifica", async () => {
      // Reproduz o bug do modelo pequeno (qwen2.5:3b local): o turno conversa mas
      // não chama update_lead_fields. O passe de extração (2ª chamada, JSON sujo
      // com cerca de código) resgata os campos e o motor determinístico qualifica.
      const conversationId = await seedConversation();
      // Em produção a pipeline grava o inbound ANTES do handler → o histórico (e o
      // transcript da extração) contém a mensagem. Reproduz isso aqui.
      await mig.sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`
        INSERT INTO messages (tenant_id, conversation_id, direction, type, content, status)
        VALUES (${tenantId}, ${conversationId}, 'inbound', 'text',
                ${'{"text":"quero um CRM, sou o decisor, orçamento 5000, prazo 30 dias"}'}::jsonb, 'received')`;
      });
      const llm = scriptedLlm(
        [outcome("Legal! Vou verificar para você.")], // turno do agente: SEM tool call
        {
          extract: [
            outcome(
              '```json\n{"necessidade":"CRM","autoridade":"decisor","orcamento":5000,"prazo":"30 dias"}\n```',
            ),
          ],
        },
      );
      const { ctx, replies } = makeCtx(conversationId);
      await runWithTenant({ tenantId }, () => handler(llm).handle(ctx));

      expect(replies).toHaveLength(1);
      const lead = await runWithTenant({ tenantId }, () =>
        getLeadProfile(conversationId),
      );
      expect(lead?.fields).toMatchObject({
        necessidade: "CRM",
        autoridade: "decisor",
        orcamento: 5000,
      });
      expect(lead?.status).toBe("qualified"); // decisão re-computada após a extração
    });

    it("IDEMPOTÊNCIA: retry do worker (handle 2x) não envia a resposta 2×", async () => {
      const conversationId = await seedConversation();
      const { ctx } = makeCtx(conversationId);
      const replies1: string[] = [];
      const replies2: string[] = [];
      const ctx1 = {
        ...ctx,
        reply: async (t: string) => void replies1.push(t),
      };
      const ctx2 = {
        ...ctx,
        reply: async (t: string) => void replies2.push(t),
      }; // MESMO externalMessageId
      await runWithTenant({ tenantId }, () =>
        handler(scriptedLlm([outcome("Olá!")])).handle(ctx1),
      );
      await runWithTenant({ tenantId }, () =>
        handler(scriptedLlm([outcome("Olá!")])).handle(ctx2),
      );
      expect(replies1).toHaveLength(1);
      expect(replies2).toHaveLength(0); // 2ª vez: chave já reivindicada → não reenvia
    });

    it("COMPENSAÇÃO: envio comprovadamente não tentado → retry retoma resposta salva", async () => {
      // Achado Codex: sem liberar o claim na falha de envio, o retry veria a chave
      // existente e pularia o envio — mensagem processada sem resposta ao lead.
      const conversationId = await seedConversation();
      const { ctx } = makeCtx(conversationId);
      const replies2: string[] = [];
      const ctx1 = {
        ...ctx,
        reply: async () => {
          throw new ReplyDeliveryError(
            "not_sent",
            "envio bloqueado antes da tentativa",
          );
        },
      };
      const ctx2 = {
        ...ctx,
        reply: async (t: string) => void replies2.push(t),
      }; // MESMO externalMessageId
      await expect(
        runWithTenant({ tenantId }, () =>
          handler(scriptedLlm([outcome("Olá!")])).handle(ctx1),
        ),
      ).rejects.toThrow("envio bloqueado antes da tentativa"); // erro propaga → job falha → BullMQ re-tenta
      await runWithTenant({ tenantId }, () =>
        handler(scriptedLlm([outcome("Olá!")])).handle(ctx2),
      );
      expect(replies2).toHaveLength(1); // claim liberado na falha → retry reenvia
    });

    it("GUARDRAIL: LLM indisponível → contenção + handoff + NOTIFICA o humano", async () => {
      const conversationId = await seedConversation();
      const { ctx, replies } = makeCtx(conversationId);
      outcomes.length = 0;
      await runWithTenant({ tenantId }, () =>
        handler(throwingLlm()).handle(ctx),
      );
      expect(replies).toHaveLength(1);
      const lead = await runWithTenant({ tenantId }, () =>
        getLeadProfile(conversationId),
      );
      expect(lead?.status).toBe("handoff");
      // o handoff de contenção NÃO pode morrer em silêncio: dispara a notificação.
      expect(outcomes.at(-1)).toMatchObject({
        status: "handoff",
        handoff: true,
      });
      expect(outcomes.at(-1)?.handoffReason).toContain("LLM indisponível");
    });

    it("lead JÁ escalado (handoff): não repete a handoffMessage a cada inbound", async () => {
      const conversationId = await seedConversation();
      await runWithTenant({ tenantId }, async () => {
        await getOrCreateLeadProfile(conversationId);
        await applyLeadDecision(conversationId, {
          status: "handoff",
          stage: "handoff",
        });
      });
      // LLM que explode se for chamado — prova que nem o turno roda.
      const { ctx, replies } = makeCtx(conversationId);
      await runWithTenant({ tenantId }, () =>
        handler(throwingLlm()).handle(ctx),
      );
      expect(replies).toHaveLength(0); // silêncio: transição já foi comunicada 1×
    });

    it("lead QUALIFICADO: inbound seguinte não re-envia a mensagem de transição", async () => {
      const conversationId = await seedConversation();
      await runWithTenant({ tenantId }, async () => {
        await getOrCreateLeadProfile(conversationId);
        await applyLeadDecision(conversationId, {
          status: "qualified",
          stage: "qualified",
          score: 3,
        });
      });
      const { ctx, replies } = makeCtx(conversationId, {
        text: "e aí, alguém me chama?",
      });
      await runWithTenant({ tenantId }, () =>
        handler(throwingLlm()).handle(ctx),
      );
      expect(replies).toHaveLength(0);
    });

    it("mensagem não-texto → resposta graciosa, sem chamar o LLM", async () => {
      const conversationId = await seedConversation();
      const { ctx, replies } = makeCtx(conversationId, {
        type: "media",
        text: undefined,
      });
      // LLM que explode se for chamado — prova que não é chamado
      await runWithTenant({ tenantId }, () =>
        handler(throwingLlm()).handle(ctx),
      );
      expect(replies).toHaveLength(1);
      expect(replies[0]!.toLowerCase()).toContain("texto");
    });

    it("OPT-OUT: inbound de saída confirma e NÃO chama o LLM (compliance)", async () => {
      const conversationId = await seedConversation();
      const { ctx, replies } = makeCtx(conversationId, {
        text: "pode parar de me mandar mensagem",
      });
      cadenceCalls.length = 0;
      await runWithTenant({ tenantId }, () =>
        handler(throwingLlm()).handle(ctx),
      ); // LLM explode se chamado
      expect(replies).toHaveLength(1); // só a confirmação de opt-out
      expect(cadenceCalls).toContain("optOut");
    });

    it("RESUMO: fora do caminho da resposta (fire-and-forget) e só periódico", async () => {
      const conversationId = await seedConversation();
      // conversa LONGA (>= threshold de 20) persistida como a pipeline faria.
      await mig.sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        for (let i = 0; i < 22; i++) {
          await tx`
          INSERT INTO messages (tenant_id, conversation_id, direction, type, content, status)
          VALUES (${tenantId}, ${conversationId}, ${i % 2 === 0 ? "inbound" : "outbound"}, 'text',
                  ${JSON.stringify({ text: `msg ${i}` })}::jsonb, 'received')`;
        }
      });
      let summaryCalls = 0;
      const llm = scriptedLlm([outcome("certo!")], {
        summary: [outcome("resumo: lead quer CRM")],
        onSummary: () => summaryCalls++,
      });
      const h = handler(llm); // MESMA instância nos 2 turnos (contador por conversa)
      const { ctx, replies } = makeCtx(conversationId);
      await runWithTenant({ tenantId }, () => h.handle(ctx));
      expect(replies).toHaveLength(1);
      // fire-and-forget: o resumo aparece depois — faz poll do lead.summary.
      const deadline = Date.now() + 2_000;
      let summary: string | null = null;
      while (Date.now() < deadline && !summary) {
        summary =
          (
            await runWithTenant({ tenantId }, () =>
              getLeadProfile(conversationId),
            )
          )?.summary ?? null;
        if (!summary) await new Promise((r) => setTimeout(r, 25));
      }
      expect(summary).toBe("resumo: lead quer CRM");
      expect(summaryCalls).toBe(1);

      // 2º turno logo em seguida: acima do threshold, mas DENTRO do período → não resume de novo.
      const { ctx: ctx2 } = makeCtx(conversationId);
      await runWithTenant({ tenantId }, () => h.handle(ctx2));
      await new Promise((r) => setTimeout(r, 100)); // margem p/ um eventual fire-and-forget indevido
      expect(summaryCalls).toBe(1);
    });
  },
);
