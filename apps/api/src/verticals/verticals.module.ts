import { Module } from "@nestjs/common";
import { embeddingRegistryProvider } from "../knowledge/embeddings.registry";
import { KitApplierService } from "./kit-applier.service";
import { KitController } from "./kit.controller";
import { PlatformStaffGuard } from "../platform/platform-staff.guard";

/**
 * Verticais (M10): aplica kits declarativos pelos seams do M9 (conteúdo
 * `platform_authored`). Embeddings de plataforma. Staff de plataforma.
 */
@Module({
  controllers: [KitController],
  providers: [embeddingRegistryProvider, KitApplierService, PlatformStaffGuard],
  exports: [KitApplierService],
})
export class VerticalsModule {}
