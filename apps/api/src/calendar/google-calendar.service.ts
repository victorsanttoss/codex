import { createSign } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AppConfig } from "@sdr/config";
import { APP_CONFIG } from "../config/config.module";
import type { BusyInterval } from "./availability";

/**
 * Cliente Google Calendar via CONTA DE SERVIÇO da plataforma (server-to-server,
 * sem OAuth por usuário): o cliente compartilha a agenda do profissional com o
 * e-mail da SA ("Fazer alterações em eventos") e cola o ID da agenda no
 * onboarding. Uma credencial atende todos os tenants — o isolamento é o
 * compartilhamento explícito de cada agenda.
 *
 * Sem SDK do Google (dependência pesada p/ 3 chamadas REST): JWT RS256 assinado
 * com node:crypto + fetch. Token OAuth cacheado até perto do exp.
 */

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";
const HTTP_TIMEOUT_MS = 10_000;

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

export interface GoogleEventInput {
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  timezone: string;
}

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  private key: ServiceAccountKey | null | undefined; // undefined = ainda não parseado
  private token: { value: string; expiresAt: number } | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Credencial da plataforma presente e válida? (não fala com a rede) */
  isConfigured(): boolean {
    return this.parseKey() !== null;
  }

  /** E-mail da SA — o onboarding mostra para o cliente compartilhar a agenda. */
  serviceAccountEmail(): string | null {
    return this.parseKey()?.client_email ?? null;
  }

  /** Blocos ocupados [from,to) da agenda externa (freeBusy). Lança em falha. */
  async getBusy(calendarId: string, from: Date, to: Date): Promise<BusyInterval[]> {
    const map = await this.getBusyMulti([calendarId], from, to);
    return map.get(calendarId) ?? [];
  }

  /**
   * freeBusy de VÁRIAS agendas numa única chamada (pool multi-recurso, 0036).
   * Mapa id→ocupados. Uma agenda com erro (ex.: não compartilhada com a SA)
   * LANÇA — fail-closed, igual ao caso de uma agenda só: não sugerir horário
   * sobre disponibilidade que não conseguimos ler de verdade.
   */
  async getBusyMulti(
    calendarIds: string[],
    from: Date,
    to: Date,
  ): Promise<Map<string, BusyInterval[]>> {
    const out = new Map<string, BusyInterval[]>();
    if (calendarIds.length === 0) return out;
    const res = await this.fetchJson(`${CALENDAR_API}/freeBusy`, {
      method: "POST",
      body: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: calendarIds.map((id) => ({ id })),
      },
    });
    const calendars =
      (res as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> })
        .calendars ?? {};
    for (const id of calendarIds) {
      const cal = calendars[id];
      if (!cal || (cal.errors && cal.errors.length > 0)) {
        throw new Error(
          `freeBusy falhou para a agenda ${id} (agenda não compartilhada com a conta de serviço?)`,
        );
      }
      out.set(id, (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) })));
    }
    return out;
  }

  /** Cria o evento na agenda externa; retorna o id do evento no Google. */
  async createEvent(calendarId: string, input: GoogleEventInput): Promise<{ id: string }> {
    const res = await this.fetchJson(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        body: {
          summary: input.summary,
          ...(input.description ? { description: input.description } : {}),
          start: { dateTime: input.start.toISOString(), timeZone: input.timezone },
          end: { dateTime: input.end.toISOString(), timeZone: input.timezone },
        },
      },
    );
    const id = (res as { id?: string }).id;
    if (!id) throw new Error("Google não retornou id do evento criado.");
    return { id };
  }

  /** Cancela (deleta) um evento criado por nós na agenda externa. Best-effort. */
  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const token = await this.accessToken();
    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    );
    // 404/410 = já não existe — ok para cancelamento.
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`Google delete event ${res.status}`);
    }
  }

  /**
   * Validação do onboarding: a SA enxerga esta agenda? Retorna erro legível
   * para o cliente corrigir (compartilhamento/ID errado) sem stacktrace.
   */
  async validateAccess(calendarId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isConfigured()) {
      return { ok: false, error: "Integração Google não configurada na plataforma." };
    }
    try {
      const now = new Date();
      await this.getBusy(calendarId, now, new Date(now.getTime() + 60_000));
      return { ok: true };
    } catch (err) {
      this.logger.warn(`validateAccess(${calendarId}): ${err instanceof Error ? err.message : err}`);
      return {
        ok: false,
        error:
          "Não consegui acessar essa agenda. Confira o ID e se ela foi compartilhada com o e-mail da plataforma (permissão de alterar eventos).",
      };
    }
  }

  // ── credencial / token ──────────────────────────────────────

  private parseKey(): ServiceAccountKey | null {
    if (this.key !== undefined) return this.key;
    const raw = this.config.googleCalendar.serviceAccountJson;
    this.key = null;
    if (raw) {
      try {
        const text = raw.trim().startsWith("{")
          ? raw
          : Buffer.from(raw, "base64").toString("utf8");
        const parsed = JSON.parse(text) as Partial<ServiceAccountKey>;
        if (parsed.client_email && parsed.private_key) {
          this.key = { client_email: parsed.client_email, private_key: parsed.private_key };
        } else {
          this.logger.error("GOOGLE_CALENDAR_SA_JSON sem client_email/private_key — integração desligada.");
        }
      } catch {
        this.logger.error("GOOGLE_CALENDAR_SA_JSON inválido (nem JSON nem base64 de JSON) — integração desligada.");
      }
    }
    return this.key;
  }

  private async accessToken(): Promise<string> {
    const key = this.parseKey();
    if (!key) throw new Error("Google Calendar não configurado (GOOGLE_CALENDAR_SA_JSON ausente).");
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const iat = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Google token ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google token sem access_token.");
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  private async fetchJson(url: string, opts: { method: string; body: unknown }): Promise<unknown> {
    const token = await this.accessToken();
    const res = await fetch(url, {
      method: opts.method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(opts.body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}
