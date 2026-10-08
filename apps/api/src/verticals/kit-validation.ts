import { redactPII } from "../curation/anonymization";
import type { VerticalKit } from "./vertical-kit";

const SEMVER = /^\d+\.\d+\.\d+$/;

export class KitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitError";
  }
}

/** Compara semver "a.b.c". >0 se a>b, 0 se igual, <0 se a<b. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Validação CENTRAL do kit antes de qualquer write/embedding: semver, estrutura, e
 * varredura de PII em TODOS os textos (guidance, knowledge, compliance, templates).
 * Conteúdo de plataforma é genérico por construção — PII aqui é erro de autoria.
 */
export function validateKit(kit: VerticalKit): void {
  if (!SEMVER.test(kit.version)) throw new KitError(`version inválida (use semver x.y.z): ${kit.version}`);
  if (!kit.niche?.name || !kit.niche?.vertical || !kit.niche?.motion) {
    throw new KitError("niche.name/vertical/motion obrigatórios.");
  }
  if (!Array.isArray(kit.knowledge) || kit.knowledge.length === 0) {
    throw new KitError("kit sem knowledge.");
  }
  const texts: string[] = [
    kit.guidance,
    kit.compliance?.notes ?? "",
    ...kit.knowledge.map((k) => k.content),
    ...kit.templates.flatMap((t) => [t.name, ...t.variables]),
  ];
  for (const t of texts) {
    if (!t) continue;
    // 'money' é permitido em KIT: valores de tabela/programa público (ex.:
    // faixas do MCMV, subsídio) são conteúdo autoral legítimo da plataforma e
    // não identificam pessoa. A regra de money existe p/ conteúdo de TENANT
    // (curadoria — preço de concorrente vazando entre tenants do nicho).
    // PII real (cpf/cnpj/telefone/e-mail/url/handle/dígitos longos) segue vetada.
    const found = redactPII(t).found.filter((k) => k !== "money");
    if (found.length > 0) {
      throw new KitError(`kit contém PII num campo textual (${found.join(", ")}) — conteúdo deve ser genérico.`);
    }
  }
}
