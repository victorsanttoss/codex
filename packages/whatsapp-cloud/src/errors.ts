/**
 * Erro de envio mapeado da Meta. `transient` decide se vale retry:
 *  - transiente: rede, 429 (rate limit), 5xx → retry com backoff.
 *  - permanente: 4xx (exceto 429) → marca a mensagem como failed, sem retry.
 */
export class ChannelSendError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly status?: number,
    readonly providerCode?: string | number,
  ) {
    super(message);
    this.name = "ChannelSendError";
  }
}
