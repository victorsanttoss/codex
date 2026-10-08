import { Injectable } from "@nestjs/common";
import { getApprovedTemplate } from "@sdr/db";

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export interface ResolvedTemplate {
  templateName: string;
  languageCode: string;
  variables?: Record<string, string>;
  /** Corpo escrito pelo cliente (M8-ext) — canal não-oficial envia como texto. */
  bodyText?: string;
}

/**
 * Valida o envio contra o catálogo de templates APROVADOS (HSM). Template não
 * aprovado ou variáveis faltando → `TemplateError` (recusa tipada). Fora da
 * janela de 24h, ESTE é o único caminho de envio.
 */
@Injectable()
export class TemplateService {
  async resolve(
    name: string,
    languageCode: string,
    variables?: Record<string, string>,
  ): Promise<ResolvedTemplate> {
    const tmpl = await getApprovedTemplate(name, languageCode);
    if (!tmpl) throw new TemplateError(`Template não aprovado: ${name}/${languageCode}.`);
    const provided = variables ?? {};
    const missing = tmpl.variables.filter((v) => !(v in provided) || provided[v] === undefined);
    if (missing.length > 0) {
      throw new TemplateError(`Template ${name}: variáveis faltando: ${missing.join(", ")}.`);
    }
    return {
      templateName: name,
      languageCode,
      ...(tmpl.variables.length > 0 ? { variables: provided } : {}),
      ...(tmpl.bodyText ? { bodyText: tmpl.bodyText } : {}),
    };
  }
}
