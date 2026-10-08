import { RealBaileysDriver } from "@sdr/whatsapp-baileys";

/** Token DI do driver Baileys (real em prod; fake injetado nos testes). */
export const BAILEYS_DRIVER = "BAILEYS_DRIVER";

/** Em produção, o driver REAL (import preguiçoso de @whiskeysockets/baileys). */
export const baileysDriverProvider = {
  provide: BAILEYS_DRIVER,
  useFactory: () => new RealBaileysDriver(),
};
