import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller";

/** Onboarding/wizard (M14) — estado por tenant. Apenas leitura/escrita do estado. */
@Module({ controllers: [OnboardingController] })
export class OnboardingModule {}
