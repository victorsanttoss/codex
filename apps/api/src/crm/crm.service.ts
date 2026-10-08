import { Inject, Injectable } from "@nestjs/common";
import {
  ProviderRegistry,
  requireTenantContext,
  type CrmProvider,
  type NotificationProvider,
  type SchedulingProvider,
} from "@sdr/core";
import { makeCipherFromEnv, TenantSecretsStore } from "@sdr/db";
import { CRM_REGISTRY } from "./crm.registry";
import { CrmConfigService } from "./crm-config.service";

/**
 * Resolve os provedores de CRM/agendamento/notificação para o tenant ATIVO,
 * conforme a config + a chave (tenant `crm_api_key`). Built-in dispensa chave.
 */
@Injectable()
export class CrmService {
  constructor(
    @Inject(CRM_REGISTRY) private readonly registry: ProviderRegistry,
    private readonly config: CrmConfigService,
  ) {}

  async crmForTenant(): Promise<CrmProvider> {
    requireTenantContext();
    const settings = await this.config.forTenant();
    if (settings.crmAdapter === "http" && settings.httpBaseURL) {
      const apiKey = await new TenantSecretsStore(makeCipherFromEnv()).get("crm_api_key");
      return this.registry.crmFor({
        crmAdapter: "http",
        crmConfig: { baseURL: settings.httpBaseURL, ...(apiKey ? { apiKey } : {}) },
      });
    }
    if (settings.crmAdapter === "kommo" && settings.kommoBaseURL) {
      // O Kommo EXIGE token (integração privada, long-lived). Sem ele, fail-safe
      // p/ builtin — não derruba o sync nem vaza lead p/ um destino sem auth.
      const apiKey = await new TenantSecretsStore(makeCipherFromEnv()).get("crm_api_key");
      if (apiKey) {
        return this.registry.crmFor({
          crmAdapter: "kommo",
          crmConfig: {
            baseURL: settings.kommoBaseURL,
            apiKey,
            ...(settings.kommoPipelineId ? { pipelineId: settings.kommoPipelineId } : {}),
            ...(settings.kommoStatusId ? { statusId: settings.kommoStatusId } : {}),
          },
        });
      }
    }
    return this.registry.crmFor({ crmAdapter: "builtin", crmConfig: {} });
  }

  async schedulingForTenant(): Promise<SchedulingProvider> {
    const settings = await this.config.forTenant();
    return this.registry.schedulingFor(settings.schedulingAdapter, {});
  }

  async notificationForTenant(): Promise<NotificationProvider> {
    const settings = await this.config.forTenant();
    return this.registry.notificationFor(settings.notificationAdapter, {});
  }
}
