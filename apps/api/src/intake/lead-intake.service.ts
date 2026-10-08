import { Injectable, Logger } from "@nestjs/common";
import {
  enqueueOutbox,
  ensureIntakeLead,
  getActiveConnectionForTenant,
  normalizePhoneDigits,
  recordImobEvent,
} from "@sdr/db";
import { IMOB_CONFIG } from "../imobiliario/imob.config";

/** Cadastro vindo de campanha (Meta Lead Ads, formulário, integração). */
export interface IntakeLeadInput {
  nome?: string;
  telefone: string;
  email?: string;
  /** Campos extras já mapeados (viram fields do lead). */
  fields?: Record<string, unknown>;
  /** Formato NATIVO do Meta leadgen (field_data) — pass-through de integradores. */
  fieldData?: Array<{ name?: string; values?: unknown[] }>;
  /** Origem (meta_lead_ad, landing_page, csv...). */
  source?: string;
  /** Id externo (ex.: leadgen_id da Meta) — auditoria/dedup. */
  externalId?: string;
}

export interface IntakeLeadResult {
  conversationId: string;
  contactId: string;
  created: boolean;
  firstTouchQueued: boolean;
}

/**
 * ENTRADA DE LEADS DE CAMPANHA: registra o lead (contato + conversa + perfil
 * pré-preenchido com os campos do formulário) e enfileira o PRIMEIRO CONTATO
 * da SDR no WhatsApp. Quando o lead responde, a resposta cai na MESMA conversa
 * (mesma conversation_key do canal) e a qualificação continua de onde o
 * formulário parou. Idempotente: reentrega do webhook não duplica nada.
 */
@Injectable()
export class LeadIntakeService {
  private readonly logger = new Logger(LeadIntakeService.name);

  async intake(input: IntakeLeadInput): Promise<IntakeLeadResult> {
    const mapped = input.fieldData?.length ? mapMetaFieldData(input.fieldData) : {};
    const nome = input.nome?.trim() || (typeof mapped.nome === "string" ? mapped.nome : undefined);
    const telefoneBruto =
      input.telefone?.trim() || (typeof mapped.telefone === "string" ? (mapped.telefone as string) : "");
    const digits = normalizeBrPhone(telefoneBruto);
    if (!digits) throw new Error("Telefone do lead inválido (mínimo 10 dígitos com DDD).");

    // chave da conversa = a MESMA que o canal usará quando o lead responder.
    // SEM conexão ativa o intake é RECUSADO (fail-fast, achado Codex): uma
    // chave provisória perderia o join da resposta em silêncio — melhor o
    // integrador ver o erro e religar depois de parear o WhatsApp.
    const conn = await getActiveConnectionForTenant();
    if (!conn) {
      throw new Error(
        "Sem conexão WhatsApp ativa neste empreendimento — conecte o número antes de ligar as campanhas.",
      );
    }
    const conversationKey = `${conn.provider === "baileys" ? "baileys" : "cloud_api"}:${conn.phoneNumberId}:${digits}`;
    // Limitação v1 documentada: se o tenant TROCAR de número depois do cadastro,
    // a resposta do lead cai numa conversa nova sem os campos do formulário
    // (aliasing por wa_id é evolução).

    // telefone/email/nome do formulário viram campos do lead (a conversa vence)
    const fields: Record<string, unknown> = {
      ...mapped,
      ...(input.fields ?? {}),
      ...(nome ? { nome } : {}),
      ...(input.email?.trim() ? { email: input.email.trim() } : {}),
    };
    delete fields.telefone; // já é a identidade do contato

    const r = await ensureIntakeLead({
      waId: digits,
      phone: digits,
      profileName: nome ?? null,
      conversationKey,
      fields,
    });

    // auditoria/timeline (aparece nos eventos do lead no painel)
    await recordImobEvent({
      conversationId: r.conversationId,
      type: "intake",
      metadata: {
        source: input.source ?? "integracao",
        ...(input.externalId ? { externalId: input.externalId } : {}),
        fieldsRecebidos: Object.keys(fields),
      },
    }).catch(() => undefined);

    // primeiro contato: só se a SDR nunca falou com esse lead (reentrega do
    // webhook e recadastro não geram spam) — idempotente por conversa
    let firstTouchQueued = false;
    if (!r.hadOutbound) {
      const saudacao = buildFirstTouch(nome, IMOB_CONFIG.projectName);
      // SEM conversationId de propósito (achado Codex CRÍTICO): a conversa do
      // cadastro nasce sem janela de 24h e o outbox cancelaria o free_form
      // vinculado ("out_of_window"). Sem vínculo, sai pelo mesmo caminho da
      // ficha do corretor (business-initiated). Na Cloud API oficial, mensagem
      // ativa fora de janela exige TEMPLATE aprovado — para o piloto (Baileys)
      // free_form funciona; template configurável é passo do go-live oficial.
      const res = await enqueueOutbox({
        toPhone: digits,
        kind: "free_form",
        payload: { text: saudacao },
        idempotencyKey: `intake:first:${r.conversationId}`,
        clientMessageId: `intake-first-${r.conversationId}`,
        billing: "service",
      });
      firstTouchQueued = res.created;
    }

    this.logger.log(
      `Lead de campanha registrado (${input.source ?? "integracao"}): conversa ${r.conversationId}${firstTouchQueued ? " + primeiro contato enfileirado" : ""}.`,
    );
    return {
      conversationId: r.conversationId,
      contactId: r.contactId,
      created: r.conversationCreated,
      firstTouchQueued,
    };
  }
}

/**
 * Telefone BR: aceita com/sem +55 e com/sem 9º dígito. 10-11 dígitos (DDD+nº)
 * ganham o DDI 55; menos de 10 é inválido. Internacional passa como veio.
 */
export function normalizeBrPhone(v: string): string | null {
  let d = normalizePhoneDigits(v ?? "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length < 10) return null; // sem DDD não tem como contatar
  if (d.length === 10 || d.length === 11) return `55${d}`; // DDD+nº sem DDI → BR
  return d; // já veio com DDI (55...) ou internacional
}

/** field_data do Meta leadgen → campos do lead (nome/telefone/email + customs). */
export function mapMetaFieldData(
  fieldData: Array<{ name?: string; values?: unknown[] }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fieldData) {
    const name = (f.name ?? "").trim().toLowerCase();
    const value = f.values?.[0];
    if (!name || value === undefined || value === null || value === "") continue;
    if (name === "full_name" || name === "nome" || name === "name") out.nome = String(value).trim();
    else if (name === "phone_number" || name === "telefone" || name === "phone" || name === "whatsapp")
      out.telefone = String(value).trim();
    else if (name === "email") out.email = String(value).trim();
    else out[slugKey(name)] = value;
  }
  return out;
}

function slugKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function buildFirstTouch(nome: string | undefined, empreendimento: string): string {
  const oi = nome ? `Oi, ${nome.split(" ")[0]}!` : "Oi!";
  return (
    `${oi} Recebemos o seu cadastro sobre o ${empreendimento} 😊\n` +
    `Sou a assistente do empreendimento e posso te passar valores, condições de entrada ` +
    `(inclusive uso de FGTS e subsídio) e agendar uma visita.\n` +
    `Pra começar: você procura o imóvel pra morar ou como investimento?`
  );
}
