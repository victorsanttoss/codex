import { BaileysSessionStore, makeCipherFromEnv } from "@sdr/db";

/** Token DI do store cifrado de sessão Baileys. */
export const BAILEYS_SESSION_STORE = "BAILEYS_SESSION_STORE";

export const baileysSessionStoreProvider = {
  provide: BAILEYS_SESSION_STORE,
  useFactory: () => new BaileysSessionStore(makeCipherFromEnv()),
};
