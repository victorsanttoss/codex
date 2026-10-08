/**
 * PROBE ao vivo do FieldExtractor contra o qwen2.5:3b real (Ollama local).
 * Reproduz o cenário que falhava (kit odonto: procedimento+convênio obrigatórios)
 * usando o MESMO código de produção do passe de extração. Uso:
 *   npx tsx apps/api/scripts/probe-extractor-3b.ts [trials]
 */
import { LlmRouter } from "@sdr/llm-router";
import { OpenAiCompatProvider } from "@sdr/llm-openai-compat";
import type { LlmService } from "../src/llm/llm.service";
import { FieldExtractor } from "../src/agent/field-extractor";
import type { QualificationField } from "../src/agent/qualification";
import { decideQualification } from "../src/agent/qualification";

const MODEL = process.env.PROBE_MODEL ?? "qwen2.5:3b";
const provider = new OpenAiCompatProvider({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });
const router = new LlmRouter([{ provider, model: MODEL }], {
  pricing: { [MODEL]: { input: 0, output: 0 } },
});
const llm = { complete: (req: Parameters<LlmRouter["complete"]>[0]) => router.complete(req) } as unknown as LlmService;

const FIELDS: QualificationField[] = [
  {
    key: "procedimento",
    type: "string",
    required: true,
    weight: 1,
    description: "o procedimento/tratamento que o paciente quer ou mencionou (ex.: implante, clareamento, aparelho, limpeza)",
  },
  {
    key: "convenio",
    type: "string",
    required: true,
    weight: 1,
    description: "o convênio/plano odontológico do paciente, ou 'particular' se não tem",
  },
];
const SCHEMA = { fields: FIELDS, qualifyAtScore: 2 };

// Conversas realistas (o 3B falhava em chamar a tool nestes turnos).
const CASES = [
  {
    name: "info completa em um turno",
    conversation: [
      { role: "assistant" as const, content: "Olá! Sou a assistente da Clínica Sorriso. Como posso ajudar?" },
      { role: "user" as const, content: "oi, queria fazer um implante dentário, tenho plano da Unimed, vocês atendem?" },
    ],
    expect: { procedimento: true, convenio: true },
  },
  {
    name: "info espalhada em turnos",
    conversation: [
      { role: "user" as const, content: "vocês fazem clareamento?" },
      { role: "assistant" as const, content: "Fazemos sim! Você tem convênio ou seria particular?" },
      { role: "user" as const, content: "é pelo bradesco dental" },
    ],
    expect: { procedimento: true, convenio: true },
  },
  {
    name: "nada informado (não pode inventar)",
    conversation: [
      { role: "user" as const, content: "oi, qual o horário de funcionamento de vocês?" },
    ],
    expect: { procedimento: false, convenio: false },
  },
];

async function main() {
  const trials = Number(process.argv[2] ?? 3);
  const extractor = new FieldExtractor(llm);
  let ok = 0;
  let total = 0;
  for (let t = 1; t <= trials; t++) {
    for (const c of CASES) {
      total++;
      const t0 = Date.now();
      const res = await extractor.extract({
        conversation: c.conversation,
        fields: FIELDS,
        missingKeys: FIELDS.map((f) => f.key),
        existing: {},
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const got = {
        procedimento: res.fields.procedimento !== undefined,
        convenio: res.fields.convenio !== undefined,
      };
      const pass = got.procedimento === c.expect.procedimento && got.convenio === c.expect.convenio;
      if (pass) ok++;
      const qual = decideQualification(SCHEMA, res.fields);
      console.log(
        `[t${t}] ${pass ? "PASS" : "FAIL"} ${c.name} (${secs}s) → campos=${JSON.stringify(res.fields)} decisão=${qual.decision}`,
      );
    }
  }
  console.log(`\nResultado: ${ok}/${total} (${Math.round((100 * ok) / total)}%) com ${MODEL}`);
  process.exit(ok === total ? 0 : 1);
}

main().catch((e) => {
  console.error("probe falhou:", e);
  process.exit(2);
});
