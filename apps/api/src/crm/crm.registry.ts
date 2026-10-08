import { ProviderRegistry } from "@sdr/core";
import { HttpCrmProvider, makeGuardedFetchCrmHttp, type CrmHttpConfig } from "@sdr/crm-http";
import { KommoCrmProvider, makeGuardedKommoHttp, type KommoCrmConfig } from "@sdr/crm-kommo";
import {
  BuiltinCrmProvider,
  BuiltinNotificationProvider,
  BuiltinSchedulingProvider,
} from "./builtin-providers";

/** Token DI do registro de provedores de CRM/agendamento/notificação. */
export const CRM_REGISTRY = "CRM_REGISTRY";

export const crmRegistryProvider = {
  provide: CRM_REGISTRY,
  useFactory: (): ProviderRegistry => {
    const registry = new ProviderRegistry();
    // CRM: built-in (default, tabelas internas) + http (externo genérico).
    registry.registerCrm("builtin", () => new BuiltinCrmProvider());
    // HTTP externo: injeta o fetch GUARDADO (anti-SSRF com pin de IP) como default
    // de produção — a validação de string do baseURL é só a 1ª barreira.
    registry.registerCrm("http", (cfg) => {
      const c = cfg as unknown as CrmHttpConfig;
      return new HttpCrmProvider({ ...c, http: c.http ?? makeGuardedFetchCrmHttp(c.timeoutMs) });
    });
    // Kommo (ex-amoCRM) API v4: token de longa duração + fetch GUARDADO (anti-SSRF
    // com pin de IP, mesma barreira do http genérico).
    registry.registerCrm("kommo", (cfg) => {
      const c = cfg as unknown as KommoCrmConfig;
      return new KommoCrmProvider({ ...c, http: c.http ?? makeGuardedKommoHttp(c.timeoutMs) });
    });
    // Agendamento e notificação: built-in (externos entram depois).
    registry.registerScheduling("builtin", () => new BuiltinSchedulingProvider());
    registry.registerNotification("builtin", () => new BuiltinNotificationProvider());
    return registry;
  },
};
