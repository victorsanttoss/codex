import { Injectable } from "@nestjs/common";
import {
  aggregateUsage,
  recordUsage,
  type UsageAggregate,
  type UsageEventInput,
} from "@sdr/db";

/**
 * UsageRecorder (item 9): hook genérico de metering por tenant. Adaptadores de
 * canal/LLM reportam consumo aqui; opera sempre no tenant ativo (RLS).
 */
@Injectable()
export class UsageRecorder {
  record(event: UsageEventInput): Promise<void> {
    return recordUsage(event);
  }

  aggregate(from: Date, to: Date): Promise<UsageAggregate> {
    return aggregateUsage(from, to);
  }
}
