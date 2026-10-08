import { Module } from "@nestjs/common";
import { OpsModule } from "../ops/ops.module";
import { PlatformReadController } from "./platform-read.controller";
import { PlatformStaffController } from "./platform-staff.controller";
import { PlatformStaffGuard } from "./platform-staff.guard";

/** Área da Plataforma (M14) — identidade por-staff (PlatformStaffGuard) + gestão de staff.
 * Rate-limit por IP contra força bruta do x-platform-token/PLATFORM_ADMIN_TOKEN via
 * ThrottlerGuard nos controllers (default global 30/min, registrado no AppModule). */
@Module({
  imports: [OpsModule],
  controllers: [PlatformReadController, PlatformStaffController],
  providers: [PlatformStaffGuard],
})
export class PlatformModule {}
