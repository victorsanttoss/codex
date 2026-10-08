import { Global, Module, type OnModuleDestroy, Inject } from "@nestjs/common";
import { Redis } from "ioredis";
import type { AppConfig } from "@sdr/config";
import { APP_CONFIG } from "../config/config.module";

export const REDIS_CLIENT = "REDIS_CLIENT";

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      // maxRetriesPerRequest: null é requerido pelo BullMQ.
      useFactory: (cfg: AppConfig): Redis =>
        new Redis(cfg.redis.url, { maxRetriesPerRequest: null }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
