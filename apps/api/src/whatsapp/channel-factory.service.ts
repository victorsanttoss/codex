import { Inject, Injectable } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import type { TenantSecretKind } from "@sdr/core";
import { makeCipherFromEnv, TenantSecretsStore } from "@sdr/db";
import {
  CloudApiChannelProvider,
  type CloudApiConfig,
  type HttpClient,
} from "@sdr/whatsapp-cloud";
import { APP_CONFIG } from "../config/config.module";
import { WHATSAPP_HTTP } from "./http.token";

/**
 * Constrói instâncias do adaptador Cloud API. Separa o NORMALIZADOR da
 * plataforma (só appSecret, para verificar assinatura no webhook) do SENDER do
 * tenant (com phone_number_id + token do TenantSecretsStore).
 */
@Injectable()
export class ChannelFactory {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(WHATSAPP_HTTP) private readonly http: HttpClient,
  ) {}

  private graph() {
    return {
      appSecret: this.cfg.whatsapp.appSecret ?? "",
      graphApiBase: this.cfg.whatsapp.graphApiBase,
      graphApiVersion: this.cfg.whatsapp.graphApiVersion,
      http: this.http,
    };
  }

  /** Normalizador da plataforma (verifica assinatura; não envia). */
  platformNormalizer(): CloudApiChannelProvider {
    return new CloudApiChannelProvider(this.graph());
  }

  /** Sender do tenant ATIVO (precisa de contexto de tenant para ler o token). */
  async tenantSender(
    phoneNumberId: string,
    secretRef: TenantSecretKind,
    options?: Pick<CloudApiConfig, "retry">,
  ): Promise<CloudApiChannelProvider> {
    const token = await new TenantSecretsStore(makeCipherFromEnv()).get(
      secretRef,
    );
    if (!token) throw new Error("Tenant sem token de envio (whatsapp_token).");
    return new CloudApiChannelProvider({
      ...this.graph(),
      phoneNumberId,
      accessToken: token,
      ...options,
    });
  }
}
