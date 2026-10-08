import { Module } from "@nestjs/common";
import { SerializedRunner } from "./serialized-runner";

@Module({
  providers: [SerializedRunner],
  exports: [SerializedRunner],
})
export class QueueModule {}
