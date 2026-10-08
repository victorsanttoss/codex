import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import { requireTenantContext } from "@sdr/core";
import {
  findConnectionOwner,
  makeCipherFromEnv,
  TenantSecretsStore,
  upsertChannelConnection,
} from "@sdr/db";
import type { HttpClient } from "@sdr/whatsapp-cloud";
import { APP_CONFIG } from "../config/config.module";
import { WHATSAPP_HTTP } from "./http.token";

export class SignupConflictError extends Error {
  constructor(readonly phoneNumberId: string) {
    super(`phone_number_id ${phoneNumberId} já pertence a outro tenant.`);
    this.name = "SignupConflictError";
  }
}
export class SignupError extends Error {
  constructor(message: string, readonly transient: boolean, readonly status?: number) {
    super(message);
    this.name = "SignupError";
  }
}

export interface SignupInput {
  code: string;
  phoneNumberId: string;
  wabaId: string;
}
export interface SignupResult {
  phoneNumberId: string;
  wabaId: string;
  displayPhone?: string;
  reconnected: boolean;
}

const RETRY = { maxAttempts: 3, baseDelayMs: 200 };

/**
 * Orquestra o Embedded Signup (M3): code→token, valida WABA/número, subscreve o
 * app ao webhook da WABA, registra o número, e persiste token cifrado + conexão.
 * Tenant binding é SEMPRE da sessão (requireTenantContext), nunca do payload.
 * Chamadas à Meta via HttpClient injetável (mockado nos testes).
 */
@Injectable()
export class EmbeddedSignupService {
  private readonly logger = new Logger(EmbeddedSignupService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(WHATSAPP_HTTP) private readonly http: HttpClient,
  ) {}

  async connect(input: SignupInput): Promise<SignupResult> {
    const { tenantId } = requireTenantContext(); // binding via sessão (JWT)

    // GUARD de conflito: um número não vive em dois tenants.
    const owner = await findConnectionOwner(input.phoneNumberId);
    if (owner && owner.tenantId !== tenantId) {
      throw new SignupConflictError(input.phoneNumberId);
    }
    const reconnected = !!owner;

    const { token, tokenExpiresAt } = await this.exchangeCodeForToken(input.code);
    const info = await this.getPhoneNumberInfo(input.phoneNumberId, token); // valida o número
    await this.assertNumberInWaba(input.wabaId, input.phoneNumberId, token); // número ∈ WABA
    await this.subscribeApp(input.wabaId, token);
    await this.registerNumber(input.phoneNumberId, token);

    // Persistência no contexto do tenant da sessão. Em corrida cross-tenant, a
    // unique global pode falhar tarde — convertemos para conflito limpo (409).
    try {
      await new TenantSecretsStore(makeCipherFromEnv()).put("whatsapp_token", token);
      await upsertChannelConnection({
        phoneNumberId: input.phoneNumberId,
        wabaId: input.wabaId,
        ...(info.displayPhone ? { displayPhone: info.displayPhone } : {}),
        ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
        subscribedAt: new Date(),
      });
    } catch (err) {
      const raced = await findConnectionOwner(input.phoneNumberId);
      if (raced && raced.tenantId !== tenantId) throw new SignupConflictError(input.phoneNumberId);
      throw err;
    }

    this.logger.log(
      `Conexão ${reconnected ? "reconectada" : "criada"} p/ tenant ${tenantId} (${input.phoneNumberId}).`,
    );
    return {
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      ...(info.displayPhone ? { displayPhone: info.displayPhone } : {}),
      reconnected,
    };
  }

  // ── passos Graph ────────────────────────────────────────────

  private async exchangeCodeForToken(code: string): Promise<{ token: string; tokenExpiresAt?: Date }> {
    const appId = this.cfg.whatsapp.appId;
    const appSecret = this.cfg.whatsapp.appSecret;
    if (!appId || !appSecret) throw new SignupError("appId/appSecret da plataforma ausentes.", false);
    const query = new URLSearchParams({ client_id: appId, client_secret: appSecret, code }).toString();
    const json = (await this.get(`/oauth/access_token?${query}`)) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) throw new SignupError("Troca de code não retornou access_token.", false);
    const result: { token: string; tokenExpiresAt?: Date } = { token: json.access_token };
    if (typeof json.expires_in === "number" && json.expires_in > 0) {
      result.tokenExpiresAt = new Date(Date.now() + json.expires_in * 1000);
    }
    return result;
  }

  private async getPhoneNumberInfo(
    phoneNumberId: string,
    token: string,
  ): Promise<{ id: string; displayPhone?: string }> {
    const json = (await this.get(`/${phoneNumberId}?fields=id,display_phone_number`, token)) as {
      id?: string;
      display_phone_number?: string;
    };
    if (!json.id || json.id !== phoneNumberId) {
      throw new SignupError("phone_number_id não confere com a Graph API.", false);
    }
    return json.display_phone_number
      ? { id: json.id, displayPhone: json.display_phone_number }
      : { id: json.id };
  }

  /** Garante que o número informado realmente pertence à WABA informada. */
  private async assertNumberInWaba(
    wabaId: string,
    phoneNumberId: string,
    token: string,
  ): Promise<void> {
    const json = (await this.get(`/${wabaId}/phone_numbers?fields=id`, token)) as {
      data?: Array<{ id?: string }>;
    };
    const ids = (json.data ?? []).map((p) => p.id);
    if (!ids.includes(phoneNumberId)) {
      throw new SignupError(`Número ${phoneNumberId} não pertence à WABA ${wabaId}.`, false);
    }
  }

  private async subscribeApp(wabaId: string, token: string): Promise<void> {
    await this.post(`/${wabaId}/subscribed_apps`, token, {});
  }

  private async registerNumber(phoneNumberId: string, token: string): Promise<void> {
    try {
      await this.post(`/${phoneNumberId}/register`, token, {
        messaging_product: "whatsapp",
        pin: "000000",
      });
    } catch (err) {
      // "já registrado" não é falha de onboarding.
      if (err instanceof SignupError && /already registered/i.test(err.message)) {
        this.logger.warn(`Número ${phoneNumberId} já registrado — seguindo.`);
        return;
      }
      throw err;
    }
  }

  // ── HTTP com retry ──────────────────────────────────────────

  private base(): string {
    const root = (this.cfg.whatsapp.graphApiBase ?? "https://graph.facebook.com").replace(/\/$/, "");
    return `${root}/${this.cfg.whatsapp.graphApiVersion}`;
  }

  private get(path: string, token?: string): Promise<unknown> {
    return this.withRetry(() =>
      this.http.get(`${this.base()}${path}`, { headers: this.headers(token) }),
    );
  }
  private post(path: string, token: string, body: Record<string, unknown>): Promise<unknown> {
    return this.withRetry(() =>
      this.http.post(`${this.base()}${path}`, {
        headers: { ...this.headers(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  private headers(token?: string): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  private async withRetry(
    call: () => Promise<{ status: number; json(): Promise<unknown> }>,
  ): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const res = await call();
        if (res.status >= 200 && res.status < 300) return res.json().catch(() => ({}));
        throw this.mapError(res.status, await res.json().catch(() => null));
      } catch (err) {
        const e = err instanceof SignupError ? err : new SignupError("erro de rede", true);
        if (!e.transient || attempt >= RETRY.maxAttempts) throw e;
        await new Promise((r) => setTimeout(r, RETRY.baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }

  private mapError(status: number, body: unknown): SignupError {
    const msg =
      (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${status}`;
    return new SignupError(msg, status === 429 || status >= 500, status);
  }
}
