import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  Res,
} from "@nestjs/common";
import { Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import type { AppConfig } from "@sdr/config";
import { Public } from "../auth/decorators";
import { APP_CONFIG } from "../config/config.module";
import { ChannelFactory } from "./channel-factory.service";
import { WebhookQueue } from "./webhook.queue";

@Controller("webhooks/whatsapp")
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly channels: ChannelFactory,
    private readonly queue: WebhookQueue,
  ) {}

  /** Verificação do webhook (challenge) com o verify token da PLATAFORMA. */
  @Public()
  @Get()
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
    @Res() res: Response,
  ): void {
    const expected = this.cfg.whatsapp.verifyToken;
    if (mode === "subscribe" && expected && token === expected) {
      res.status(200).send(challenge);
    } else {
      res.status(403).send("forbidden");
    }
  }

  /**
   * Recebe eventos. Valida a assinatura na BORDA (descarta forjados sem poluir a
   * fila), ENFILEIRA e responde 200 rápido. O worker processa de forma durável.
   */
  @Public()
  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body ?? {});
    const request = {
      headers: lowerHeaders(req.headers),
      query: (req.query ?? {}) as Record<string, string>,
      rawBody,
    };
    if (!this.channels.platformNormalizer().verifySignature(request)) {
      this.logger.warn("Webhook com assinatura inválida — descartado na borda.");
      return { received: true }; // 200 mesmo assim (não vaza), mas não enfileira
    }
    await this.queue.enqueue(request);
    return { received: true };
  }
}

function lowerHeaders(headers: Request["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(",");
  }
  return out;
}
