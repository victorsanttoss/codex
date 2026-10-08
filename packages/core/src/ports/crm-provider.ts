/**
 * PORT de CRM. O núcleo não sabe se por trás há um CRM built-in (tabelas
 * internas), HubSpot, Pipedrive ou um webhook genérico — fala somente com esta
 * interface. Nenhum adaptador concreto neste módulo (M7 implementa).
 */

export interface CrmContact {
  /** Chave natural de dedup no CRM (telefone do WhatsApp). */
  phone: string;
  name?: string;
  /** Campos qualificados extraídos pelo agente (livres). */
  fields?: Record<string, unknown>;
}

export interface CrmOpportunity {
  /** id externo do contato dono da oportunidade (de upsertContact). */
  contactExternalId: string;
  /**
   * id externo da oportunidade JÁ criada por nós nesta conversa (do mapa
   * `crm_external_sync`), quando houver. O provider deve preferi-lo para atualizar
   * a MESMA oportunidade — evita adivinhar qual lead é o nosso (e mexer no lead de
   * um negócio criado à mão no CRM). Ausente na 1ª sincronização.
   */
  knownExternalId?: string;
  /** conversa de origem (rastreabilidade). */
  conversationId?: string;
  title: string;
  stage: string;
  status: string;
  score?: number;
  value?: number;
}

export interface CrmActivity {
  contactExternalId: string;
  kind: string; // handoff | scheduling | note | sync
  body: string;
}

export interface CrmProvider {
  readonly id: string;
  /** Cria/atualiza o contato (idempotente por telefone). */
  upsertContact(contact: CrmContact): Promise<{ externalId: string }>;
  /** Cria/atualiza a oportunidade vinculada ao contato (idempotente). */
  upsertOpportunity(opp: CrmOpportunity): Promise<{ externalId: string }>;
  /** Registra uma atividade/nota (opcional). */
  addActivity?(activity: CrmActivity): Promise<void>;
}

/** Erro de provedor de CRM, agnóstico — `transient` decide retry. */
export class CrmError extends Error {
  readonly detail?: string;
  constructor(
    message: string,
    readonly transient: boolean,
    readonly status?: number,
    detail?: string,
  ) {
    super(message);
    this.name = "CrmError";
    if (detail !== undefined) {
      // trunca o detalhe cru do CRM e mantém não-enumerável (não vaza em log/JSON).
      Object.defineProperty(this, "detail", { value: detail.slice(0, 200), enumerable: false });
    }
  }

  static fromStatus(status: number | undefined, transient: boolean, detail?: string): CrmError {
    return new CrmError(crmErrorCategory(status), transient, status, detail);
  }
}

/** Categoria PÚBLICA e segura a partir do status HTTP (sem body/headers/chave). */
export function crmErrorCategory(status?: number): string {
  if (status === undefined) return "CRM: erro de rede";
  if (status === 401 || status === 403) return "CRM: falha de autenticação";
  if (status === 429) return "CRM: rate limit";
  if (status >= 500) return "CRM: erro do provedor";
  if (status === 400) return "CRM: requisição inválida";
  return `CRM: erro (HTTP ${status})`;
}
