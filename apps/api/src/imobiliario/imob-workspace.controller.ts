import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { runWithTenant } from "@sdr/core";
import {
  getConversationHistory,
  getImobAssignmentJoined,
  imobAssignmentForBrokerConversation,
  listImobWorkspaceAssignments,
  recordImobEvent,
  setImobAssignmentStage,
} from "@sdr/db";
import { Public } from "../auth/decorators";
import { PanelMessageService } from "../panel/panel-message.service";
import { IMOB_STAGE_MENU, leadDisplayName } from "./imob-messages";
import { IMOB_CONFIG } from "./imob.config";
import { ImobWorkspaceGuard, type ActingBroker } from "./imob-workspace.guard";

type BrokerReq = Request & { broker: ActingBroker };

/**
 * Campos qualificados SEM contato direto: leadFields pode vir de formulários e
 * integrações com chaves variadas (Telefone, phone_number, e-mail…) — deny por
 * PADRÃO na chave normalizada, não por lista exata (achado Codex 2ª rodada).
 */
const CONTACT_KEY = /(telefone|celular|whats|phone|fone|mail|contato)/;
function sanitizeLeadFields(fields: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!fields) return null;
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([k]) => !CONTACT_KEY.test(k.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()),
    ),
  );
}

/**
 * WORKSPACE DO CORRETOR (modo 'workspace'): o corretor atende o lead PELA
 * plataforma via link pessoal — a conversa fica 100% registrada e visível ao
 * gestor em tempo real. Escopo duro: cada rota valida que a conversa pertence
 * a um atendimento ATIVO DESTE corretor (nunca enxerga leads dos outros).
 * `@Public` pula o JWT de usuário; o ImobWorkspaceGuard resolve o corretor.
 */
@Public()
@UseGuards(ThrottlerGuard, ImobWorkspaceGuard)
// teto acima do global (30/min): o chat faz POLLING de mensagens a cada 5s.
// Limite alto SÓ na leitura; mutações têm teto próprio (refinamento Codex).
@Throttle({ default: { ttl: 60_000, limit: 90 } })
@Controller("workspace/imob")
export class ImobWorkspaceController {
  constructor(private readonly panelMessages: PanelMessageService) {}

  /** Corretor + seus atendimentos ativos (lista do workspace). */
  @Get("me")
  async me(@Req() req: BrokerReq) {
    const { broker } = req;
    return runWithTenant({ tenantId: broker.tenantId }, async () => {
      const assignments = await listImobWorkspaceAssignments(broker.brokerId);
      return {
        broker: { name: broker.name },
        projectName: IMOB_CONFIG.projectName,
        stages: IMOB_STAGE_MENU,
        // SEM leadPhone (achado Codex): no modo workspace o corretor atende
        // pela plataforma — expor o telefone furaria o próprio modo
        assignments: assignments.map((a) => ({
          id: a.id,
          conversationId: a.conversationId,
          leadName: leadDisplayName(a.leadFields, a.contactName),
          stage: a.stage,
          leadScore: a.leadScore,
          leadFields: sanitizeLeadFields(a.leadFields),
          respondedAt: a.respondedAt,
          stageUpdatedAt: a.stageUpdatedAt,
        })),
      };
    });
  }

  /** Histórico da conversa (polling do chat — por isso o teto maior). */
  @Throttle({ default: { ttl: 60_000, limit: 240 } })
  @Get("conversations/:conversationId/messages")
  async messages(
    @Req() req: BrokerReq,
    @Param("conversationId") conversationId: string,
    @Query("limit") limit?: string,
  ) {
    const { broker } = req;
    return runWithTenant({ tenantId: broker.tenantId }, async () => {
      const scoped = await imobAssignmentForBrokerConversation(broker.brokerId, conversationId);
      if (!scoped) throw new ForbiddenException("Conversa fora dos seus atendimentos ativos.");
      const history = await getConversationHistory(
        conversationId,
        Math.min(Number(limit) || 100, 200),
      );
      return { messages: history };
    });
  }

  /** Envia mensagem ao lead PELO número da plataforma (fica no histórico). */
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post("conversations/:conversationId/messages")
  async send(
    @Req() req: BrokerReq,
    @Param("conversationId") conversationId: string,
    @Body() body: { text?: string; clientMessageId?: string },
  ) {
    const text = body?.text?.trim();
    if (!text) throw new BadRequestException("Mensagem vazia.");
    if (text.length > 4000) throw new BadRequestException("Mensagem longa demais.");
    const { broker } = req;
    return runWithTenant({ tenantId: broker.tenantId }, async () => {
      const scoped = await imobAssignmentForBrokerConversation(broker.brokerId, conversationId);
      if (!scoped) throw new ForbiddenException("Conversa fora dos seus atendimentos ativos.");
      const message = await this.panelMessages.sendHumanMessage(
        conversationId,
        text,
        body?.clientMessageId,
      );
      // Corrida checagem→envio (achado Codex): sem lock compartilhado com o
      // PanelMessageService, uma redistribuição NO MEIO do envio não é
      // bloqueável — mas é detectável. A mensagem fica 100% no histórico;
      // aqui só damos visibilidade ao gestor.
      const still = await imobAssignmentForBrokerConversation(broker.brokerId, conversationId);
      if (!still) {
        await recordImobEvent({
          conversationId,
          assignmentId: scoped.id,
          brokerId: broker.brokerId,
          type: "alert",
          metadata: { reason: "workspace_sent_after_reassign" },
        }).catch(() => undefined);
      }
      return { message };
    });
  }

  /** Atualiza a etapa pelo workspace (mesmos estágios do menu 1-6). */
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post("assignments/:assignmentId/stage")
  async stage(
    @Req() req: BrokerReq,
    @Param("assignmentId") assignmentId: string,
    @Body() body: { stage?: string },
  ) {
    const item = IMOB_STAGE_MENU.find((s) => s.stage === body?.stage);
    if (!item) throw new BadRequestException("Etapa desconhecida.");
    const { broker } = req;
    return runWithTenant({ tenantId: broker.tenantId }, async () => {
      // dono validado ANTES de mutar (corretor A não pode mover lead do B);
      // e só atendimentos ofertados como 'workspace' — os 'ficha' são geridos
      // pelo WhatsApp (achado Codex 2ª rodada)
      const own = await getImobAssignmentJoined(assignmentId);
      if (
        !own ||
        own.brokerId !== broker.brokerId ||
        own.status !== "accepted" ||
        own.offerMode !== "workspace"
      ) {
        throw new ForbiddenException("Atendimento não encontrado entre os seus.");
      }
      const updated = await setImobAssignmentStage(assignmentId, item.stage);
      if (!updated) throw new ForbiddenException("Atendimento já encerrado.");
      await recordImobEvent({
        conversationId: updated.conversationId,
        assignmentId,
        brokerId: broker.brokerId,
        type: "stage_changed",
        metadata: { stage: item.stage, via: "workspace" },
      }).catch(() => undefined);
      return { ok: true, stage: item.stage, closed: updated.status === "closed" };
    });
  }
}
