import dns from "node:dns";
import https from "node:https";
import {
  CrmError,
  isPrivateOrReservedIp,
  type CrmActivity,
  type CrmContact,
  type CrmOpportunity,
  type CrmProvider,
} from "@sdr/core";

export const CRM_HTTP_ADAPTER_KEY = "http";

/** HTTP injetável (testes mockam; prod usa fetch). */
export interface CrmHttp {
  post(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown }>;
}

/** Timeout default (15s): CRM externo lento não pode segurar o worker de sync. */
export const DEFAULT_CRM_TIMEOUT_MS = 15_000;

/**
 * Fábrica do cliente fetch com TIMEOUT (AbortSignal). Timeout vira Error de rede
 * comum — `send()` o converte em CrmError TRANSIENTE (o job re-tenta).
 */
export function makeFetchCrmHttp(timeoutMs: number = DEFAULT_CRM_TIMEOUT_MS): CrmHttp {
  return {
    async post(url, headers, body) {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err) => {
        const name = (err as { name?: string } | null)?.name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new Error(`CRM: timeout de rede após ${timeoutMs}ms`);
        }
        throw err;
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
  };
}

export const fetchCrmHttp: CrmHttp = makeFetchCrmHttp();

/** Erro de destino bloqueado pelo guard anti-SSRF (IP privado/reservado). */
export class CrmBlockedTargetError extends Error {
  constructor(reason: string) {
    super(`CRM: destino bloqueado (anti-SSRF): ${reason}`);
    this.name = "CrmBlockedTargetError";
  }
}

/**
 * Anti-SSRF (2ª barreira — DEFINITIVA, no momento do fetch): a validação de string
 * do `httpBaseURL` não resolve DNS, então não cobre rebinding. Aqui, ao conectar,
 * um `lookup` customizado (a) EXIGE https, (b) resolve o hostname UMA vez, (c)
 * REJEITA se QUALQUER IP resolvido cair em faixa privada/reservada (v4/v6) e (d)
 * FIXA (pin) o IP validado — o socket conecta exatamente nesse IP, então um
 * rebinding entre a validação e a conexão não tem efeito. O TLS continua validando
 * o certificado contra o hostname original (SNI preservado).
 */
export function makeGuardedFetchCrmHttp(timeoutMs: number = DEFAULT_CRM_TIMEOUT_MS): CrmHttp {
  return {
    async post(url, headers, body) {
      const target = new URL(url);
      if (target.protocol !== "https:") {
        throw new CrmBlockedTargetError(`protocolo não-https (${target.protocol})`);
      }
      // lookup com pin: valida TODOS os endereços e conecta só no 1º validado.
      const pinnedLookup = (
        hostname: string,
        _options: unknown,
        cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
      ): void => {
        dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
          if (err) {
            cb(err, "", 0);
            return;
          }
          if (addresses.length === 0) {
            cb(new CrmBlockedTargetError(`sem endereços para ${hostname}`), "", 0);
            return;
          }
          for (const a of addresses) {
            if (isPrivateOrReservedIp(a.address)) {
              cb(new CrmBlockedTargetError(`${hostname} → IP privado/reservado ${a.address}`), "", 0);
              return;
            }
          }
          const first = addresses[0]!;
          cb(null, first.address, first.family);
        });
      };

      return await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
        const req = https.request(
          url,
          {
            method: "POST",
            headers: { ...headers, "content-type": headers["content-type"] ?? "application/json" },
            lookup: pinnedLookup as unknown as typeof dns.lookup,
            timeout: timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              let json: unknown = null;
              try {
                json = text ? JSON.parse(text) : null;
              } catch {
                json = null;
              }
              resolve({ status: res.statusCode ?? 0, json });
            });
          },
        );
        req.on("timeout", () => {
          req.destroy(new Error(`CRM: timeout de rede após ${timeoutMs}ms`));
        });
        req.on("error", (err) => reject(err));
        req.write(JSON.stringify(body));
        req.end();
      });
    },
  };
}

export interface CrmHttpConfig {
  /** baseURL do CRM (webhook/REST genérico). Dedup por telefone é do backend. */
  baseURL: string;
  apiKey?: string;
  http?: CrmHttp;
  /** Timeout de rede por requisição (default 15s) — usado quando `http` não é injetado. */
  timeoutMs?: number;
  id?: string;
}

/**
 * Adaptador de CRM genérico via HTTP — prova o seam agnóstico (HubSpot/Pipedrive/
 * webhook próprio expõem o mesmo shape). Erros viram `CrmError` (categoria
 * segura). O backend é responsável pelo dedup por telefone/e-mail.
 */
export class HttpCrmProvider implements CrmProvider {
  readonly id: string;
  private readonly base: string;
  private readonly http: CrmHttp;

  constructor(private readonly config: CrmHttpConfig) {
    if (!config.baseURL) throw new Error("HttpCrmProvider: baseURL é obrigatório.");
    this.id = config.id ?? CRM_HTTP_ADAPTER_KEY;
    this.base = config.baseURL.replace(/\/$/, "");
    this.http = config.http ?? makeFetchCrmHttp(config.timeoutMs);
  }

  async upsertContact(contact: CrmContact): Promise<{ externalId: string }> {
    const json = await this.send("/contacts", {
      phone: contact.phone,
      ...(contact.name ? { name: contact.name } : {}),
      fields: contact.fields ?? {},
    });
    return { externalId: extractId(json) };
  }

  async upsertOpportunity(opp: CrmOpportunity): Promise<{ externalId: string }> {
    const json = await this.send("/opportunities", {
      contact_id: opp.contactExternalId,
      title: opp.title,
      stage: opp.stage,
      status: opp.status,
      ...(opp.score !== undefined ? { score: opp.score } : {}),
      ...(opp.value !== undefined ? { value: opp.value } : {}),
    });
    return { externalId: extractId(json) };
  }

  async addActivity(activity: CrmActivity): Promise<void> {
    await this.send("/activities", {
      contact_id: activity.contactExternalId,
      kind: activity.kind,
      body: activity.body,
    });
  }

  private async send(path: string, body: Record<string, unknown>): Promise<unknown> {
    let res: { status: number; json: unknown };
    try {
      res = await this.http.post(`${this.base}${path}`, this.headers(), body);
    } catch (err) {
      throw CrmError.fromStatus(undefined, true, err instanceof Error ? err.message : undefined);
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = (res.json as { error?: { message?: string } } | null)?.error?.message;
      throw CrmError.fromStatus(res.status, res.status === 429 || res.status >= 500, detail);
    }
    return res.json;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }
}

function extractId(json: unknown): string {
  const id = (json as { id?: unknown } | null)?.id;
  if (id === undefined || id === null) throw new CrmError("CRM: resposta sem 'id'", false, 502);
  return String(id);
}
