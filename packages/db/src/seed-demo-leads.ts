import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { runWithTenant } from "@sdr/core";
import { closeDb, getDb } from "./client";
import { tenants } from "./schema";
import { recordInboundMessage, recordOutboundMessage } from "./conversations";
import { applyLeadDecision, getOrCreateLeadProfile, mergeLeadFields, setLeadSummary } from "./agent";
import { createAppointment } from "./crm";
import { recordUsage } from "./usage";

/**
 * Seed de LEADS DE EXEMPLO (nicho solar) no tenant `demo` — para o painel não ficar
 * vazio durante os testes. Usa os repos reais (RLS). Idempotente o suficiente:
 * rode `pnpm db:seed:leads`; reexecutar cria novos contatos (waId aleatório).
 */
interface DemoLead {
  name: string;
  city: string;
  status: "qualified" | "new" | "handoff" | "disqualified";
  score: number;
  fields?: Record<string, unknown>;
  summary?: string;
  thread: Array<{ from: "lead" | "sdr"; text: string }>;
  appointment?: string;
  daysAgo: number;
}

const LEADS: DemoLead[] = [
  {
    name: "Maria Silva", city: "Uberlândia", status: "qualified", score: 92, daysAgo: 0,
    fields: { conta_de_luz: "R$ 680/mês", cidade: "Uberlândia", tipo_telhado: "cerâmico", tipo_imovel: "casa própria" },
    summary: "Lead quente: conta alta, casa própria, telhado cerâmico. Quer reduzir a conta de luz.",
    thread: [
      { from: "lead", text: "Oi, vi o anúncio de energia solar. Quanto economiza?" },
      { from: "sdr", text: "Oi, Maria! 🌞 Depende da sua conta de luz. Quanto vem em média por mês?" },
      { from: "lead", text: "Uns 680 reais" },
      { from: "sdr", text: "Com esse valor dá pra economizar bastante! O imóvel é seu? E o telhado é de quê?" },
      { from: "lead", text: "É casa própria, telhado de cerâmica" },
      { from: "sdr", text: "Perfeito! Você se encaixa direitinho. Posso agendar uma visita técnica gratuita?" },
    ],
    appointment: "Visita técnica — quinta 14h",
  },
  {
    name: "João Pereira", city: "Araguari", status: "qualified", score: 78, daysAgo: 1,
    fields: { conta_de_luz: "R$ 450/mês", cidade: "Araguari", tipo_imovel: "casa própria" },
    summary: "Conta de R$450, casa própria. Interessado, pediu simulação.",
    thread: [
      { from: "lead", text: "Quero uma simulação de energia solar" },
      { from: "sdr", text: "Claro! Qual o valor médio da sua conta de luz?" },
      { from: "lead", text: "450 por mês, é minha casa" },
      { from: "sdr", text: "Ótimo, João! Vou preparar uma simulação. Posso te ligar amanhã?" },
    ],
    appointment: "Ligação de simulação — amanhã 10h",
  },
  {
    name: "Beatriz Rocha", city: "Patos de Minas", status: "qualified", score: 85, daysAgo: 2,
    fields: { conta_de_luz: "R$ 900/mês", cidade: "Patos de Minas", tipo_telhado: "metálico", tipo_imovel: "comércio" },
    summary: "Comércio com conta de R$900 — alto potencial de economia.",
    thread: [
      { from: "lead", text: "Tenho um comércio e a conta de luz tá nas alturas" },
      { from: "sdr", text: "Energia solar é ideal pra comércio! Quanto vem a conta?" },
      { from: "lead", text: "Quase 900 reais" },
      { from: "sdr", text: "Excelente potencial de economia. Vamos agendar uma análise?" },
    ],
    appointment: "Análise no local — sexta 16h",
  },
  {
    name: "Ana Costa", city: "Uberaba", status: "handoff", score: 70, daysAgo: 1,
    fields: { conta_de_luz: "R$ 520/mês", cidade: "Uberaba" },
    summary: "Qualificada mas com dúvidas sobre financiamento — passou para humano.",
    thread: [
      { from: "lead", text: "A conta é uns 520, mas queria entender o financiamento" },
      { from: "sdr", text: "Posso te explicar! Mas vou te passar para um especialista financeiro do time, tá? 🙌" },
    ],
  },
  {
    name: "Rafael Mendes", city: "Ituiutaba", status: "handoff", score: 65, daysAgo: 3,
    summary: "Pediu para falar com um humano.",
    thread: [
      { from: "lead", text: "Prefiro falar com um atendente de verdade" },
      { from: "sdr", text: "Sem problema! Já estou te encaminhando para nosso time. 🙌" },
    ],
  },
  {
    name: "Carlos Souza", city: "—", status: "new", score: 15, daysAgo: 0,
    thread: [
      { from: "lead", text: "oi" },
      { from: "sdr", text: "Olá! 🌞 Posso te ajudar a economizar na conta de luz com energia solar. Quanto vem a sua conta por mês?" },
    ],
  },
  {
    name: "Fernanda Lima", city: "—", status: "new", score: 25, daysAgo: 0,
    fields: { cidade: "Uberlândia" },
    thread: [
      { from: "lead", text: "Quero saber mais sobre energia solar" },
      { from: "sdr", text: "Legal! Pra eu te dar números reais: qual o valor médio da sua conta de luz?" },
      { from: "lead", text: "deixa eu ver depois" },
    ],
  },
  {
    name: "Pedro Alves", city: "Uberlândia", status: "disqualified", score: 5, daysAgo: 4,
    fields: { tipo_imovel: "alugado" },
    summary: "Inquilino (imóvel alugado) — fora do perfil.",
    thread: [
      { from: "lead", text: "é bom mas eu moro de aluguel, era só curiosidade" },
      { from: "sdr", text: "Entendi, Pedro! Quando tiver um imóvel próprio, estaremos à disposição. 👍" },
    ],
  },
];

async function main(): Promise<void> {
  const [demo] = await getDb().select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, "demo"));
  if (!demo) throw new Error("Tenant 'demo' não encontrado — rode `pnpm db:seed` primeiro.");
  const tenantId = demo.id;

  await runWithTenant({ tenantId }, async () => {
    for (const lead of LEADS) {
      const wa = "5534" + Math.floor(100000000 + Math.random() * 899999999);
      const convKey = `cloud_api:demo-pn:${wa}`;
      const base = Date.now() - lead.daysAgo * 86_400_000;
      let conversationId = "";
      let i = 0;
      for (const msg of lead.thread) {
        const at = new Date(base + i * 60_000);
        if (msg.from === "lead") {
          const rec = await recordInboundMessage({
            conversationKey: convKey,
            waId: wa,
            phone: `+${wa}`,
            profileName: lead.name,
            externalMessageId: "demo." + randomUUID(),
            type: "text",
            content: { text: msg.text },
            receivedAt: at,
          });
          conversationId = rec.conversationId;
          await recordUsage({ type: "inbound_message", channel: "whatsapp" });
        } else {
          await recordOutboundMessage({
            conversationId,
            type: "text",
            content: { text: msg.text },
            externalMessageId: "demo-out." + randomUUID(),
          });
          await recordUsage({ type: "llm_call", model: "claude-haiku-4-5", tokensIn: 800, tokensOut: 120, costMicros: 1400 });
        }
        i++;
      }
      await getOrCreateLeadProfile(conversationId);
      if (lead.fields) await mergeLeadFields(conversationId, lead.fields);
      if (lead.summary) await setLeadSummary(conversationId, lead.summary);
      await applyLeadDecision(conversationId, { status: lead.status, stage: lead.status, score: lead.score });
      if (lead.appointment) {
        await createAppointment({
          conversationId,
          idempotencyKey: "demo-appt-" + randomUUID(),
          whenText: lead.appointment,
          details: `Energia solar — ${lead.name} (${lead.city})`,
          status: "scheduled",
        });
      }
      console.log(`  + ${lead.name} (${lead.status}, score ${lead.score})`);
    }
  });

  console.log(`Seed de leads demo OK no tenant '${demo.id}' (${LEADS.length} leads).`);
  await closeDb();
}

main().catch((err) => {
  console.error("Falha no seed de leads:", err);
  process.exit(1);
});
