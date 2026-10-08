import { Module } from "@nestjs/common";
import { UsageController } from "./usage.controller";
import { UsageRecorder } from "./usage.service";

@Module({
  controllers: [UsageController],
  providers: [UsageRecorder],
  exports: [UsageRecorder],
})
export class MeteringModule {}
