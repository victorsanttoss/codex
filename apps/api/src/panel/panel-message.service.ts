import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  getActiveConnectionForTenant,
  getConnectionForConversation,
  getConversationContact,
  getConversationWindow,
  isContactOptedOut,
  isHumanTakeover,
  isPanelConversation,
  isWithinServiceWindow,
  type HistoryMessage,
} from "@sdr/db";
import { ChannelSendError } from "@sdr/whatsapp-cloud";
import { BaileysSendError } from "@sdr/whatsapp-baileys";
import { OutboxService } from "../outbox/outbox.service";

/**
 * Envio MANUAL do humano pelo painel (composer das Conversas). Guardrails ANTES
 * do envio: (a) só com a conversa em human_takeover (409 — a IA está no comando);
 * (b) opt-out do contato é sagrado (403, LGPD); (c) Cloud API exige a janela de
 * 24h para free-form (422; Baileys não tem janela). A entrega é o núcleo
 * unificado do outbox (`sendHumanMessage`, origin='human'): síncrona, pela
 * CONEXÃO DA CONVERSA (fallback: conexão ativa do tenant), com histórico em
 * `messages` como o reply() do agente.
 */
@Injectable()
export class PanelMessageService {
  private readonly logger = new Logger(PanelMessageService.name);

  constructor(private readonly outbox: OutboxService) {}

  async sendHumanMessage(conversationId: string, text: string, clientMessageId?: string): Promise<HistoryMessage> {
    if (!(await isPanelConversation(conversationId))) {
      throw new NotFoundException("Conversa não encontrada.");
    }
    if (!(await isHumanTakeover(conversationId))) {
      throw new ConflictException("A IA está no comando desta conversa — assuma a conversa para enviar manualmente.");
    }
    const contact = await getConversationContact(conversationId);
    if (!contact) throw new NotFoundException("Contato da conversa não encontrado.");
    if (await isContactOptedOut(contact.waId)) {
      throw new ForbiddenException("Este contato pediu para não receber mensagens (opt-out).");
    }
    // Roteamento: a conexão pela qual a conversa CHEGOU; sem vínculo (chave fora
    // da convenção/conexão apagada), a conexão ativa do tenant.
    const connection = (await getConnectionForConversation(conversationId)) ?? (await getActiveConnectionForTenant());
    if (!connection) {
      throw new UnprocessableEntityException("Nenhuma conexão de WhatsApp disponível para enviar.");
    }
    if ("status" in connection && connection.status !== "active") {
      throw new UnprocessableEntityException(
        `A conexão desta conversa (${connection.phoneNumberId}) está indisponível (${connection.status}).`,
      );
    }
    // Janela de 24h: só a Cloud API restringe free-form; Baileys não tem janela.
    if (connection.provider !== "baileys") {
      const window = await getConversationWindow(conversationId);
      if (!isWithinServiceWindow(window)) {
        throw new UnprocessableEntityException(
          "Fora da janela de 24h do WhatsApp — o lead precisa mandar uma mensagem antes de você responder por aqui.",
        );
      }
    }

    // Idempotência (achado Codex): a chave vem do PAINEL — retry da mesma mensagem
    // (falha de rede pós-envio, duplo clique) reusa a chave e NÃO duplica o envio.
    const clientKey = clientMessageId ?? randomUUID();
    try {
      const sent = await this.outbox.sendHumanMessage({
        conversationId,
        toPhone: contact.phone ?? contact.waId,
        text,
        clientKey,
        connection,
      });
      if (sent.state === "in_flight") {
        throw new ConflictException("Este envio já está em andamento — aguarde um instante.");
      }
      if (sent.state === "deduped") {
        this.logger.log(`Envio manual DEDUPLICADO (${conversationId}, chave ${clientKey}).`);
        return { direction: "outbound", type: "text", content: { text }, createdAt: sent.createdAt };
      }
      this.logger.log(`Mensagem manual enviada (${conversationId} → ${sent.externalMessageId}).`);
      return { direction: "outbound", type: "text", content: { text }, createdAt: new Date() };
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Envio manual falhou (${conversationId}): ${msg}`);
      // Sem socket/seam Baileys NESTE processo → indisponibilidade, não erro do dado.
      if (err instanceof ChannelSendError || err instanceof BaileysSendError) {
        throw new ServiceUnavailableException(`Não foi possível enviar agora: ${msg}`);
      }
      throw err;
    }
  }
}
