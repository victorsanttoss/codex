import { Body, Controller, Post } from "@nestjs/common";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { Roles } from "../auth/roles";
import { PlaygroundService, type PlaygroundResult } from "./playground.service";

export class SimulateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  niche?: string;
}

export class ResetDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  niche?: string;
}

/**
 * Playground (M14): testa a SDR sem WhatsApp. Admin, no contexto do tenant. Roda o
 * agente REAL numa conversa sandbox e devolve resposta + RAG + qualificação +
 * custo + score (painel de debug). Nada é enviado a leads reais.
 */
@Controller("admin/playground")
export class PlaygroundController {
  constructor(private readonly playground: PlaygroundService) {}

  @Roles("admin")
  @Post("message")
  simulate(@Body() dto: SimulateDto): Promise<PlaygroundResult> {
    return this.playground.simulate(dto.text, dto.niche);
  }

  @Roles("admin")
  @Post("reset")
  reset(@Body() dto: ResetDto): Promise<{ ok: true }> {
    return this.playground.reset(dto.niche);
  }
}
