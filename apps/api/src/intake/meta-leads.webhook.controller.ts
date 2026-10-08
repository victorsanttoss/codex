import { createHmac, timingSafeEqual } from "node:crypto";
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { runWithTenant } from "@sdr/core";
import { createNotification } from "@sdr/db";
import { Public } from "../auth/decorators";
import { LeadIntakeService } from "./lead-intake.service";

/**
 * WEBHOOK DIRETO da Meta para LEAD ADS (formulários nativos): o app Meta
 * assina o campo `leadgen` da Página e a Meta chama aqui a cada cadastro.
 *
 * Envs (fail-closed — sem elas o webhook não processa):
 *   META_LEADGEN_VERIFY_TOKEN  token do handshake (GET hub.challenge)
 *   META_APP_SECRET            valida X-Hub-Signature-256 (recomendado)
 *   META_LEADGEN_PAGES         "pageId:tenantId; pageId2:tenantId2" — mapeia a
 *                              Página do anúncio ao tenant/empreendimento
 *   META_PAGE_ACCESS_TOKEN     token de Página p/ buscar o lead no Graph
 *                              (o webhook só entrega o leadgen_id)
 *
 * Alternativa sem app Meta: integradores (Make/Zapier/n8n) já entregam os
 * campos completos → usar POST /integrations/leads.
 */
@Public()
@UseGuards(ThrottlerGuard)
@Controller("webhooks/meta-leads")
export class MetaLeadsWebhookController {
  private readonly logger = new Logger(MetaLeadsWebhookController.name);

  constructor(private readonly service: LeadIntakeService) {}

  /** Handshake de assinatura do webhook (Meta chama no cadastro do endpoint). */
  @Get()
  verify(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") token?: string,
    @Query("hub.challenge") challenge?: string,
  ): string {
    const expected = process.env.META_LEADGEN_VERIFY_TOKEN;
    if (!expected || mode !== "subscribe" || token !== expected) {
      throw new ForbiddenException("verify_token inválido.");
    }
    return challenge ?? "";
  }

  @Post()
  @HttpCode(200)
  // burst legítimo da Meta não pode tomar 429 (achado Codex)
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  async receive(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body ?? {});
    if (!this.signatureOk(req, raw)) {
      this.logger.warn("Webhook meta-leads com assinatura inválida — descartado (200 na borda).");
      return { received: true };
    }

    const pages = parsePagesMap(process.env.META_LEADGEN_PAGES);
    const body = req.body as {
      entry?: Array<{ changes?: Array<{ field?: string; value?: { leadgen_id?: string; page_id?: string } }> }>;
    };

    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "leadgen") continue;
        const leadgenId = change.value?.leadgen_id;
        const pageId = change.value?.page_id;
        if (!leadgenId || !pageId) continue;
        const tenantId = pages.get(String(pageId));
        if (!tenantId) {
          this.logger.warn(`leadgen da página ${pageId} sem tenant mapeado (META_LEADGEN_PAGES) — ignorado.`);
          continue;
        }
        try {
          await this.processLead(tenantId, String(leadgenId));
        } catch (err) {
          // 200 sempre (senão a Meta desabilita o webhook). Falha final vira
          // ALERTA idempotente ao gestor — lead de campanha não some em
          // silêncio (achado Codex); fila durável com retry é evolução.
          this.logger.error(
            `Falha processando leadgen ${leadgenId}: ${err instanceof Error ? err.message : err}`,
          );
          await runWithTenant({ tenantId }, () =>
            createNotification({
              idempotencyKey: `meta-leadgen-failed:${leadgenId}`,
              kind: "handoff",
              title: "Lead da Meta NÃO importado",
              body: `Cadastro leadgen ${leadgenId} falhou ao importar (${err instanceof Error ? err.message : "erro"}) — verificar token/config e reprocessar.`,
            }),
          ).catch(() => undefined);
        }
      }
    }
    return { received: true };
  }

  /** Busca os campos do formulário no Graph (o webhook só traz o id) e registra. */
  private async processLead(tenantId: string, leadgenId: string): Promise<void> {
    const token = process.env.META_PAGE_ACCESS_TOKEN;
    if (!token) {
      this.logger.warn(
        `leadgen ${leadgenId} recebido mas META_PAGE_ACCESS_TOKEN não configurado — use /integrations/leads via integrador ou configure o token.`,
      );
      return;
    }
    const url = new URL(`https://graph.facebook.com/v21.0/${encodeURIComponent(leadgenId)}`);
    url.searchParams.set("fields", "field_data,created_time");
    url.searchParams.set("access_token", token);
    // retry curto p/ transientes do Graph (timeout/5xx/429 — achado Codex)
    let res: Response | null = null;
    let lastErr = "";
    for (const waitMs of [0, 1000, 3000]) {
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) break;
        lastErr = `Graph respondeu ${res.status}`;
        if (res.status < 500 && res.status !== 429) break; // 4xx (exceto 429): não re-tenta
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        res = null;
      }
    }
    if (!res?.ok) throw new Error(lastErr || "Graph indisponível ao buscar o lead.");
    const lead = (await res.json()) as { field_data?: Array<{ name?: string; values?: unknown[] }> };
    const fieldData = lead.field_data;
    if (!fieldData?.length) throw new Error("Lead sem field_data no Graph.");

    await runWithTenant({ tenantId }, () =>
      this.service.intake({
        telefone: "",
        fieldData,
        source: "meta_lead_ad",
        externalId: leadgenId,
      }),
    );
  }

  /** X-Hub-Signature-256 com o app secret; sem secret configurado, NÃO processa. */
  private signatureOk(req: Request, raw: string): boolean {
    const secret = process.env.META_APP_SECRET;
    if (!secret) {
      this.logger.warn("META_APP_SECRET ausente — webhook meta-leads desligado (fail-closed).");
      return false;
    }
    const header = req.headers["x-hub-signature-256"];
    if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
    const given = header.slice("sha256=".length);
    if (given.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  }
}

function parsePagesMap(env: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (env ?? "").split(";")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf(":");
    if (i <= 0) continue;
    map.set(p.slice(0, i).trim(), p.slice(i + 1).trim().toLowerCase());
  }
  return map;
}
