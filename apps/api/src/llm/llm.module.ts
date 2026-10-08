import { Module } from "@nestjs/common";
import { llmRegistryProvider } from "./llm.registry";
import { LlmService } from "./llm.service";

@Module({
  providers: [llmRegistryProvider, LlmService],
  exports: [LlmService],
})
export class LlmModule {}
