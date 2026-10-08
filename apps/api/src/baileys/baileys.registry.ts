import { ProviderRegistry, type TenantProviderSelection } from "@sdr/core";
import {
  BaileysChannelProvider,
  BAILEYS_ADAPTER_KEY,
  type BaileysChannelConfig,
  type BaileysConnection,
} from "@sdr/whatsapp-baileys";

/** Token DI do registro de canais NÃO-OFICIAIS (composition root). */
export const BAILEYS_REGISTRY = "BAILEYS_REGISTRY";

/** Registra o adaptador `baileys` no ProviderRegistry agnóstico (mesma port do Cloud). */
export const baileysRegistryProvider = {
  provide: BAILEYS_REGISTRY,
  useFactory: (): ProviderRegistry => {
    const registry = new ProviderRegistry();
    registry.registerChannel(
      BAILEYS_ADAPTER_KEY,
      (cfg) => new BaileysChannelProvider(cfg as unknown as BaileysChannelConfig),
    );
    return registry;
  },
};

/** Constrói um provider Baileys para um número, opcionalmente com socket vivo. */
export function baileysProviderFor(
  registry: ProviderRegistry,
  accountId: string,
  connection?: BaileysConnection,
): BaileysChannelProvider {
  const selection: TenantProviderSelection = {
    channelAdapter: BAILEYS_ADAPTER_KEY,
    channelConfig: { accountId, ...(connection ? { connection } : {}) },
    llmAdapter: "",
    llmConfig: {},
  };
  return registry.channelFor(selection) as BaileysChannelProvider;
}
