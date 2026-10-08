/**
 * PORT de NOTIFICAÇÃO do time humano (handoff). Agnóstico ao canal (painel
 * built-in, Slack, e-mail). O M7 entrega o built-in.
 */

export interface HumanNotification {
  /** Chave de idempotência (dispara UMA vez por evento). */
  idempotencyKey: string;
  kind: string; // handoff | scheduling
  title: string;
  body: string;
}

export interface NotificationProvider {
  readonly id: string;
  /** Notifica o time. Idempotente pela chave (não duplica no retry). */
  notify(n: HumanNotification): Promise<void>;
}
