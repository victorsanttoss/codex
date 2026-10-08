import type { QualificationSchema } from "../agent/qualification";

export type KnowledgeType =
  | "objection_handling"
  | "qualifying_question"
  | "vocabulary"
  | "faq"
  | "document_request";

export interface KitKnowledge {
  type: KnowledgeType;
  content: string;
}

export interface KitTemplate {
  name: string;
  languageCode: string;
  variables: string[];
  category: string;
}

/**
 * Descrição DECLARATIVA de uma vertical (um arquivo por vertical). É a SEMENTE do
 * nicho — o conteúdo é `platform_authored` (curado pela plataforma) e o loop de
 * curadoria do M9 o refina com dados reais. Conteúdo é GENÉRICO por construção
 * (sem PII / sem identidade de tenant).
 */
export interface VerticalKit {
  /** semver do kit — idempotência/versionamento. */
  version: string;
  niche: { name: string; vertical: string; motion: string };
  guidance: string;
  knowledge: KitKnowledge[];
  qualificationSchema: QualificationSchema;
  templates: KitTemplate[];
  compliance?: { notes: string };
  /**
   * Termo da vertical para o RECURSO que atende (a "pessoa" por trás de cada
   * agenda do pool, 0036). A UI usa isto em "Adicionar {singular}". Neutro: cada
   * vertical define o seu (profissional/corretor/consultor…); ausente → "agenda".
   */
  resourceNoun?: { singular: string; plural: string };
}
