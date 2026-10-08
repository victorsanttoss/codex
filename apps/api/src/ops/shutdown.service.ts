import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { closeDb } from "@sdr/db";

/**
 * Fecha o pool do Postgres no shutdown gracioso (SIGTERM). Os workers BullMQ e o
 * Redis fecham nos próprios OnModuleDestroy; aqui garantimos que o Postgres não
 * dependa do encerramento abrupto do processo.
 */
@Injectable()
export class ShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(ShutdownService.name);

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Shutdown (${signal ?? "?"}) — fechando o pool do Postgres.`);
    try {
      await closeDb();
    } catch (err) {
      this.logger.warn(`closeDb falhou: ${err instanceof Error ? err.message : err}`);
    }
  }
}
