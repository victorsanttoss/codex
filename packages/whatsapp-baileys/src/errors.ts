/** Erro de envio do canal não-oficial. `transient` decide retry (espelha ChannelSendError). */
export class BaileysSendError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "BaileysSendError";
  }
}
