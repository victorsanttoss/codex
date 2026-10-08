import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import {
  getConversationHistory,
  getLeadProfile,
  isPanelConversation,
  leadFunnel,
  listAppointmentsForConversation,
  listConversations,
  listLeads,
  setHumanTakeover,
  type AppointmentRow,
  type ConversationRow,
  type HistoryMessage,
  type LeadProfile,
  type LeadRow,
  type Paged,
} from "@sdr/db";
import { aggregateUsage } from "@sdr/db";
import { Roles } from "../auth/roles";
import { PanelMessageService } from "./panel-message.service";

class TakeoverDto {
  @IsBoolean()
  on!: boolean;
}

class SendMessageDto {
  @IsString()
  @IsNotEmpty({ message: "Mensagem vazia." })
  @MaxLength(4096)
  text!: string;

  /** Idempotência do painel: retry da MESMA mensagem reusa a chave e não duplica o envio. */
  @IsOptional()
  @IsUUID()
  clientMessageId?: string;
}

function toInt(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * APIs de LEITURA do painel (M14): leads, conversas, dashboard — tenant-scoped
 * (RLS). Mais a ação "assumir conversa". Reusa repos existentes (sem tocar agente).
 */
@Controller("admin")
export class PanelController {
  constructor(private readonly panelMessages: PanelMessageService) {}

  // ── Leads / pipeline ──
  @Roles("agent")
  @Get("leads")
  leads(
    @Query("status") status?: string,
    @Query("stage") stage?: string,
    @Query("minScore") minScore?: string,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<Paged<LeadRow>> {
    return listLeads({
      ...(status ? { status } : {}),
      ...(stage ? { stage } : {}),
      ...(minScore ? { minScore: toInt(minScore, 0) } : {}),
      ...(search ? { search } : {}),
      limit: toInt(limit, 20),
      offset: toInt(offset, 0),
    });
  }

  @Roles("agent")
  @Get("leads/:conversationId")
  async leadDetail(@Param("conversationId") conversationId: string): Promise<{
    profile: LeadProfile | null;
    appointments: AppointmentRow[];
    history: HistoryMessage[];
  }> {
    if (!(await isPanelConversation(conversationId))) throw new NotFoundException("Conversa não encontrada.");
    const [profile, appointments, history] = await Promise.all([
      getLeadProfile(conversationId),
      listAppointmentsForConversation(conversationId),
      getConversationHistory(conversationId, 100),
    ]);
    return { profile, appointments, history };
  }

  // ── Conversas ──
  @Roles("agent")
  @Get("conversations")
  conversations(
    @Query("handoff") handoff?: string,
    @Query("qualified") qualified?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<Paged<ConversationRow>> {
    return listConversations({
      ...(handoff === "1" || handoff === "true" ? { handoff: true } : {}),
      ...(qualified === "1" || qualified === "true" ? { qualified: true } : {}),
      limit: toInt(limit, 30),
      offset: toInt(offset, 0),
    });
  }

  @Roles("agent")
  @Get("conversations/:conversationId")
  async conversationDetail(@Param("conversationId") conversationId: string): Promise<{
    history: HistoryMessage[];
    profile: LeadProfile | null;
  }> {
    if (!(await isPanelConversation(conversationId))) throw new NotFoundException("Conversa não encontrada.");
    const [history, profile] = await Promise.all([
      getConversationHistory(conversationId, 200),
      getLeadProfile(conversationId),
    ]);
    return { history, profile };
  }

  /** "Assumir conversa" / devolver à IA (admin). */
  @Roles("admin")
  @Post("conversations/:conversationId/takeover")
  async takeover(@Param("conversationId") conversationId: string, @Body() dto: TakeoverDto): Promise<{ ok: boolean }> {
    const ok = await setHumanTakeover(conversationId, dto.on);
    return { ok };
  }

  /**
   * Envio MANUAL do humano (composer do painel). Só com a conversa assumida
   * (409); honra opt-out (403) e a janela de 24h da Cloud API (422). Entrega
   * síncrona pelo núcleo do outbox (origin='human') e devolve a mensagem criada.
   */
  @Roles("admin")
  @Post("conversations/:conversationId/messages")
  async sendMessage(
    @Param("conversationId") conversationId: string,
    @Body() dto: SendMessageDto,
  ): Promise<{ message: HistoryMessage }> {
    const text = dto.text.trim();
    if (!text) throw new BadRequestException("Mensagem vazia.");
    const message = await this.panelMessages.sendHumanMessage(conversationId, text, dto.clientMessageId);
    return { message };
  }

  // ── Dashboard ──
  @Roles("agent")
  @Get("dashboard")
  async dashboard(): Promise<{ funnel: Record<string, number>; usage: Awaited<ReturnType<typeof aggregateUsage>> }> {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [funnel, usage] = await Promise.all([leadFunnel(), aggregateUsage(from, to)]);
    return { funnel, usage };
  }
}
