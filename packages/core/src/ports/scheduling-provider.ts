/**
 * PORT de AGENDAMENTO. Agnóstico ao backend (calendário built-in interno ou
 * Google Calendar). O M7 entrega o built-in; um externo entra depois sem mudar
 * o núcleo.
 */

export interface AppointmentRequest {
  /** Chave de idempotência (ex.: derivada da conversa + intenção). */
  idempotencyKey: string;
  /** Referência da conversa de origem (rastreabilidade). */
  conversationId?: string;
  /** Texto livre do horário desejado (a normalização fina é do adaptador). */
  when?: string;
  /** Início em ISO 8601 quando já resolvido (fuso America/Sao_Paulo). */
  startsAt?: string;
  details: string;
}

export interface SchedulingProvider {
  readonly id: string;
  /** Cria (ou retorna o existente) o agendamento — idempotente pela chave. */
  createAppointment(req: AppointmentRequest): Promise<{ externalId: string }>;
}
