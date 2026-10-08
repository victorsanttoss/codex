import { Injectable, Logger } from "@nestjs/common";
import { requireTenantContext } from "@sdr/core";
import {
  acceptImobAssignment,
  declineImobAssignment,
  findImobAssignmentAwaitingReply,
  findImobBrokerByWa,
  getImobAssignmentJoined,
  getImobBrokerById,
  recordImobEvent,
  setHumanTakeover,
  setImobAssignmentStage,
  type ImobBrokerRow,
} from "@sdr/db";
import { ImobDistributionService } from "./imob-distribution.service";
import { ImobWorkspaceTokenService } from "./imob-workspace-token.service";
import {
  buildAcceptedConfirmation,
  buildAcceptedConfirmationWorkspace,
  buildDeclinedConfirmation,
  buildNoteSaved,
  buildStageConfirmation,
  buildUnknownReply,
  IMOB_STAGE_MENU,
  leadDisplayName,
  parseNumericReply,
} from "./imob-messages";

export interface BrokerInboundInput {
  /** Remetente (waId/telefone) da mensagem normalizada. */
  from: string;
  /** Texto (ou transcrição); undefined para mídia sem texto. */
  text: string | undefined;
  /** Conversa DO CORRETOR com o número do tenant (onde a resposta sai). */
  conversationId: string;
  reply: (text: string) => Promise<void>;
}

/**
 * Desvio do inbound para CORRETORES: mensagem de número cadastrado como
 * corretor NUNCA vai para o agente SDR de qualificação — cai aqui, onde o
 * "1/2" resolve aceite e o "1-6" resolve status do atendimento.
 */
@Injectable()
export class ImobBrokerInboundService {
  private readonly logger = new Logger(ImobBrokerInboundService.name);

  constructor(
    private readonly distribution: ImobDistributionService,
    private readonly workspaceTokens: ImobWorkspaceTokenService,
  ) {}

  /** true = era corretor e foi tratado (o caller NÃO chama o agente SDR). */
  async maybeHandle(input: BrokerInboundInput): Promise<boolean> {
    const broker = await findImobBrokerByWa(input.from);
    if (!broker) return false;

    try {
      await this.handleBrokerMessage(broker, input);
    } catch (err) {
      // Corretor identificado: mesmo em erro NÃO deixa cair no agente SDR.
      this.logger.error(
        `Falha tratando mensagem do corretor ${broker.name}: ${err instanceof Error ? err.message : err}`,
      );
      await input
        .reply("Tive um problema ao registrar sua resposta — tente de novo em instantes, por favor.")
        .catch(() => undefined);
    }
    return true;
  }

  private async handleBrokerMessage(broker: ImobBrokerRow, input: BrokerInboundInput): Promise<void> {
    const waiting = await findImobAssignmentAwaitingReply(broker.id);
    const n = parseNumericReply(input.text);

    if (!waiting) {
      await input.reply(buildUnknownReply(false));
      return;
    }

    const joined = await getImobAssignmentJoined(waiting.id);
    const leadName = leadDisplayName(joined?.leadFields ?? null, joined?.contactName ?? null);
    const leadConversationId = waiting.conversationId;

    if (waiting.awaitingReply === "accept") {
      if (n === 1) {
        const accepted = await acceptImobAssignment(waiting.id);
        if (!accepted) {
          await input.reply("Essa oferta já não está mais ativa (expirou ou foi redistribuída).");
          return;
        }
        // corretor assume → a IA para de conversar com o LEAD (guardrail M14)
        await setHumanTakeover(leadConversationId, true).catch((err) =>
          this.logger.warn(`Takeover do lead falhou: ${err instanceof Error ? err.message : err}`),
        );
        // modo GRAVADO na oferta — não o da config atual (que pode ter mudado
        // entre oferta e aceite; a oferta 'workspace' foi SEM telefone)
        const mode = accepted.offerMode === "workspace" ? "workspace" : "ficha";
        await recordImobEvent({
          conversationId: leadConversationId,
          assignmentId: waiting.id,
          brokerId: broker.id,
          type: "accepted",
          metadata: { acceptSeconds: Math.round((Date.now() - waiting.offeredAt.getTime()) / 1000), mode },
        });
        if (mode === "workspace") {
          // modo workspace: SEM telefone — o corretor atende pela plataforma
          // (conversa visível ao gestor). Link pessoal assinado + versionado.
          const bk = await getImobBrokerById(broker.id);
          const { tenantId } = requireTenantContext();
          const token = await this.workspaceTokens.sign({
            brokerId: broker.id,
            tenantId,
            v: bk?.accessTokenVersion ?? 1,
          });
          const base = (process.env.WEB_ORIGIN ?? "http://localhost:3100").replace(/\/$/, "");
          // token no FRAGMENT (#t=): nunca chega ao servidor/proxy — não vaza em log
          await input.reply(buildAcceptedConfirmationWorkspace(leadName, `${base}/corretor#t=${token}`));
        } else {
          await input.reply(buildAcceptedConfirmation(leadName, joined?.contactPhone ?? null));
        }
        return;
      }
      if (n === 2) {
        const declined = await declineImobAssignment(waiting.id);
        if (!declined) {
          await input.reply("Essa oferta já não está mais ativa.");
          return;
        }
        await recordImobEvent({
          conversationId: leadConversationId,
          assignmentId: waiting.id,
          brokerId: broker.id,
          type: "declined",
        });
        await input.reply(buildDeclinedConfirmation(leadName));
        await this.distribution.redistributeSafely(leadConversationId, waiting.attempt);
        return;
      }
      await input.reply(buildUnknownReply(true));
      return;
    }

    // awaiting_reply === 'status'
    const item = n !== null ? IMOB_STAGE_MENU.find((o) => o.n === n) : undefined;
    if (item) {
      const updated = await setImobAssignmentStage(waiting.id, item.stage);
      if (!updated) {
        await input.reply("Esse atendimento já foi encerrado — nada a atualizar.");
        return;
      }
      await recordImobEvent({
        conversationId: leadConversationId,
        assignmentId: waiting.id,
        brokerId: broker.id,
        type: "stage_changed",
        metadata: { stage: item.stage },
      });
      await input.reply(buildStageConfirmation(item.stage, leadName));
      return;
    }

    // texto livre durante cobrança de status → vira NOTA no histórico do lead
    if (input.text && input.text.trim().length > 0) {
      await recordImobEvent({
        conversationId: leadConversationId,
        assignmentId: waiting.id,
        brokerId: broker.id,
        type: "note",
        metadata: { text: input.text.trim().slice(0, 2000) },
      });
      await input.reply(buildNoteSaved(leadName));
      return;
    }

    await input.reply(buildUnknownReply(true));
  }
}
