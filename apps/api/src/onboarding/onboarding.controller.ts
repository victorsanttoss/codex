import { Body, Controller, Get, Post, Put } from "@nestjs/common";
import { IsInt, IsObject, IsOptional, Max, Min } from "class-validator";
import { activateOnboarding, getOnboarding, saveOnboarding, type OnboardingState } from "@sdr/db";
import { Roles } from "../auth/roles";

export class SaveOnboardingDto {
  @IsInt()
  @Min(1)
  @Max(10) // 10 etapas no fork imob ("Corretores parceiros" entrou como etapa 6)
  step!: number;

  @IsOptional()
  @IsObject()
  patch?: Record<string, unknown>;
}

/**
 * Estado do ONBOARDING (wizard) do tenant ativo (M14). Autosave por etapa; leitura
 * reentrável. Admin, no contexto do tenant (RLS). Não há segredo aqui — só
 * preferências do wizard (nicho escolhido, tom, etc.).
 */
@Controller("admin/onboarding")
export class OnboardingController {
  @Roles("admin")
  @Get()
  get(): Promise<OnboardingState> {
    return getOnboarding();
  }

  @Roles("admin")
  @Put()
  save(@Body() dto: SaveOnboardingDto): Promise<OnboardingState> {
    return saveOnboarding(dto.step, dto.patch ?? {});
  }

  @Roles("admin")
  @Post("activate")
  async activate(): Promise<{ activated: true }> {
    await activateOnboarding();
    return { activated: true };
  }
}
