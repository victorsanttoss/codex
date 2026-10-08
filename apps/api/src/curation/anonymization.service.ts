import { Injectable } from "@nestjs/common";
import { hasPII, redactPII } from "./anonymization";

export interface AnonymizeResult {
  redacted: string;
  found: string[];
  clean: boolean;
}

/**
 * Anonimização em serviço. 1ª camada determinística (regex). A 2ª camada (LLM)
 * é um hook documentado — para o M9, a regra determinística + a re-checagem na
 * promoção garantem ZERO PII no nicho (testado). `clean` = sem PII após redigir.
 */
@Injectable()
export class AnonymizationService {
  process(text: string): AnonymizeResult {
    const { redacted, found } = redactPII(text);
    return { redacted, found, clean: !hasPII(redacted) };
  }

  hasPII(text: string): boolean {
    return hasPII(text);
  }
}
