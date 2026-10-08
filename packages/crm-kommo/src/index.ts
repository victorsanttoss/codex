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

export const CRM_KOMMO_ADAPTER_KEY = "kommo";

/**
 * HTTP injetável (testes mockam; prod usa fetch guardado). O Kommo precisa de GET
 * (busca de contato/lead), POST (criar) e PATCH (atualizar status) — por isso é
 * mais rico que o `CrmHttp` do @sdr/crm-http (só POST).
 */
export interface KommoHttp {
  request(
    method: "GET" | "POST" | "PATCH",
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }>;
}

/** Timeout default (15s): CRM externo lento não pode segurar o worker de sync. */
export const DEFAULT_KOMMO_TIMEOUT_MS = 15_000;

/** Erro de destino bloqueado pelo guard anti-SSRF (IP privado/reservado). */
export class KommoBlockedTargetError extends Error {
  constructor(reason: string) {
    super(`Kommo: destino bloqueado (anti-SSRF): ${reason}`);
    this.name = "KommoBlockedTargetError";
  }
}

/**
 * Fetch GUARDADO anti-SSRF (2ª barreira, definitiva): resolve o DNS, REJEITA se
 * qualquer IP cair em faixa privada/reservada e FIXA (pin) o IP validado ao
 * conectar — um rebinding entre validação e conexão não tem efeito; o TLS segue
 * validando o certificado contra o hostname (SNI preservado). Generaliza o guard
 * do @sdr/crm-http para GET/POST/PATCH com corpo opcional. A 1ª barreira (string)
 * fica na config (`safeHttpBaseURL`), que valida o baseURL do tenant.
 */
export function makeGuardedKommoHttp(timeoutMs: number = DEFAULT_KOMMO_TIMEOUT_MS): KommoHttp {
  return {
    async request(method, url, headers, body) {
      const target = new URL(url);
      if (target.protocol !== "https:") {
        throw new KommoBlockedTargetError(`protocolo não-https (${target.protocol})`);
      }
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
            cb(new KommoBlockedTargetError(`sem endereços para ${hostname}`), "", 0);
            return;
          }
          for (const a of addresses) {
            if (isPrivateOrReservedIp(a.address)) {
              cb(new KommoBlockedTargetError(`${hostname} → IP privado/reservado ${a.address}`), "", 0);
              return;
            }
          }
          const first = addresses[0]!;
          cb(null, first.address, first.family);
        });
      };

      const payload = body === undefined ? undefined : JSON.stringify(body);
      return await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
        const req = https.request(
          url,
          {
            method,
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
          req.destroy(new Error(`Kommo: timeout de rede após ${timeoutMs}ms`));
        });
        req.on("error", (err) => reject(err));
        if (payload !== undefined) req.write(payload);
        req.end();
      });
    },
  };
}

export interface KommoCrmConfig {
  /** Base da conta Kommo, ex.: `https://acme.kommo.com` (SEM `/api/v4`). */
  baseURL: string;
  /** Token de LONGA DURAÇÃO da integração privada (Authorization: Bearer). */
  apiKey: string;
  http?: KommoHttp;
  /** Timeout de rede por requisição (default 15s) — usado quando `http` não é injetado. */
  timeoutMs?: number;
  /** Funil onde o lead deve cair (opcional; sem isto o Kommo usa o funil principal). */
  pipelineId?: number;
  /** Etapa do funil para o lead (opcional; sem isto cai na 1ª etapa, "Leads de entrada"). */
  statusId?: number;
  id?: string;
}

/**
 * Adaptador de CRM para o **Kommo** (ex-amoCRM), API v4. Reaproveita toda a infra
 * de sync (fila/retry/dedup/secrets) — implementa só o contrato `CrmProvider`:
 *  - contato: dedup por telefone (busca `?query=` → cria se não achar);
 *  - oportunidade: 1 lead por contato (reaproveita o lead já ligado ao contato,
 *    senão cria), honrando funil/etapa configurados;
 *  - atividade/qualificação: NOTAS no contato (não exige mapear custom-field IDs
 *    por conta — a corretora lê renda/FGTS/etc. direto na nota).
 * Auth = token de longa duração (integração privada); OAuth completo fica para
 * um cenário multi-conta futuro. Erros viram `CrmError` (categoria segura).
 */
export class KommoCrmProvider implements CrmProvider {
  readonly id: string;
  private readonly base: string;
  private readonly http: KommoHttp;

  constructor(private readonly config: KommoCrmConfig) {
    if (!config.baseURL) throw new Error("KommoCrmProvider: baseURL é obrigatório.");
    if (!config.apiKey) throw new Error("KommoCrmProvider: apiKey (token) é obrigatório.");
    this.id = config.id ?? CRM_KOMMO_ADAPTER_KEY;
    this.base = `${config.baseURL.replace(/\/$/, "")}/api/v4`;
    this.http = config.http ?? makeGuardedKommoHttp(config.timeoutMs);
  }

  async upsertContact(contact: CrmContact): Promise<{ externalId: string }> {
    // 1) Dedup por telefone (E.164 com '+'). O Kommo responde 204 (sem corpo) quando
    //    não há match. LIMITAÇÃO (validar com conta real): o `query` é full-text — um
    //    contato criado FORA da plataforma noutro formato ('(11) 9...') pode não casar
    //    e gerar duplicata; entre chamadas nossas há auto-consistência (gravamos e
    //    lemos o mesmo +E.164), então o fluxo da SDR não quebra.
    const found = await this.req("GET", `/contacts?query=${encodeURIComponent(contact.phone)}`);
    const existing = firstId(found, "contacts");
    if (existing) return { externalId: existing };

    // 2) Cria o contato com o telefone no custom-field padrão PHONE.
    const created = await this.req("POST", "/contacts", [
      {
        ...(contact.name ? { name: contact.name } : {}),
        custom_fields_values: [
          { field_code: "PHONE", values: [{ value: contact.phone, enum_code: "WORK" }] },
        ],
      },
    ]);
    const id = firstId(created, "contacts");
    if (!id) throw new CrmError("Kommo: resposta sem id de contato", false, 502);

    // 3) Qualificação como NOTA (best-effort: nota é secundária, não derruba o sync).
    const note = summarizeFields(contact.fields);
    if (note) await this.addNote("contacts", id, note).catch(() => undefined);
    return { externalId: id };
  }

  async upsertOpportunity(opp: CrmOpportunity): Promise<{ externalId: string }> {
    // PREFERE o lead que NÓS já criamos nesta conversa (do mapa crm_external_sync):
    // atualiza exatamente esse, sem risco de mexer num lead que um corretor abriu à
    // mão para o mesmo contato. Só cai no "lead ligado ao contato" na 1ª sync.
    const existingLead =
      opp.knownExternalId ??
      firstId(
        await this.req("GET", `/contacts/${encodeURIComponent(opp.contactExternalId)}?with=leads`),
        "leads",
      );
    if (existingLead) {
      // Atualiza a etapa do funil, se configurada (sem IDs, não há como mover).
      if (this.config.statusId || this.config.pipelineId) {
        await this.req("PATCH", `/leads/${encodeURIComponent(existingLead)}`, {
          ...(this.config.pipelineId ? { pipeline_id: this.config.pipelineId } : {}),
          ...(this.config.statusId ? { status_id: this.config.statusId } : {}),
        });
      }
      return { externalId: existingLead };
    }

    const created = await this.req("POST", "/leads", [
      {
        name: opp.title,
        ...(this.config.pipelineId ? { pipeline_id: this.config.pipelineId } : {}),
        ...(this.config.statusId ? { status_id: this.config.statusId } : {}),
        ...(opp.value !== undefined && Number.isFinite(opp.value)
          ? { price: Math.max(0, Math.round(opp.value)) }
          : {}),
        _embedded: { contacts: [{ id: toNumericId(opp.contactExternalId) }] },
      },
    ]);
    const id = firstId(created, "leads");
    if (!id) throw new CrmError("Kommo: resposta sem id de lead", false, 502);
    return { externalId: id };
  }

  async addActivity(activity: CrmActivity): Promise<void> {
    await this.addNote("contacts", activity.contactExternalId, activity.body);
  }

  private async addNote(entity: "contacts" | "leads", id: string, text: string): Promise<void> {
    await this.req("POST", `/${entity}/${encodeURIComponent(id)}/notes`, [
      { note_type: "common", params: { text: text.slice(0, 5000) } },
    ]);
  }

  private async req(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let res: { status: number; json: unknown };
    try {
      res = await this.http.request(method, `${this.base}${path}`, this.headers(), body);
    } catch (err) {
      throw CrmError.fromStatus(undefined, true, err instanceof Error ? err.message : undefined);
    }
    // 204 No Content = busca sem resultado (Kommo): sucesso, corpo vazio.
    if (res.status === 204) return null;
    if (res.status < 200 || res.status >= 300) {
      throw CrmError.fromStatus(
        res.status,
        res.status === 429 || res.status >= 500,
        kommoErrorDetail(res.json),
      );
    }
    return res.json;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.config.apiKey}`,
    };
  }
}

/** Extrai o id da 1ª entidade embutida (`_embedded.<kind>[0].id`), como string. */
function firstId(json: unknown, kind: "contacts" | "leads"): string | undefined {
  const arr = (json as { _embedded?: Record<string, unknown> } | null)?._embedded?.[kind];
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const id = (arr[0] as { id?: unknown } | undefined)?.id;
  return id === undefined || id === null ? undefined : String(id);
}

/** O `_embedded.contacts[].id` do Kommo é NUMÉRICO — converte o externalId guardado. */
function toNumericId(externalId: string): number {
  const n = Number(externalId);
  if (!Number.isFinite(n)) throw new CrmError("Kommo: id de contato não-numérico", false, 502);
  return n;
}

/** Resumo humano dos campos qualificados para virar nota no contato (sem PII crua extra). */
function summarizeFields(fields?: Record<string, unknown>): string | null {
  if (!fields) return null;
  const entries = Object.entries(fields).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (entries.length === 0) return null;
  return (
    "Qualificação (SDR IA):\n" +
    entries.map(([k, v]) => `• ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("\n")
  );
}

/** Detalhe seguro a partir do corpo de erro do Kommo (vários formatos possíveis). */
function kommoErrorDetail(json: unknown): string | undefined {
  const o = json as Record<string, unknown> | null;
  if (!o) return undefined;
  const direct = o.detail ?? o.title ?? o.message;
  if (typeof direct === "string") return direct;
  const ve = o["validation-errors"];
  if (Array.isArray(ve) && ve.length > 0) return "validation-errors";
  return undefined;
}
