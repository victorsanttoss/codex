import { Module } from "@nestjs/common";
import { NicheService } from "./niche.service";
import { NicheKnowledgeSource } from "./niche-knowledge.source";

/**
 * Camada de NICHO no consumo (M9). Exporta a fonte de conhecimento de nicho
 * (somada ao retriever) e o serviço (resolve nicho do tenant, orientação p/ o
 * prompt). A curadoria/produção fica no CurationModule.
 */
@Module({
  providers: [NicheService, NicheKnowledgeSource],
  exports: [NicheService, NicheKnowledgeSource],
})
export class NicheModule {}
