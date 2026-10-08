import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { getDb } from "@sdr/db";
import { Public } from "../auth/decorators";
import { REDIS_CLIENT } from "../redis/redis.module";

@Controller()
export class HealthController {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Liveness: o processo está de pé. */
  @Public()
  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Readiness: dependências (Postgres + Redis) respondem. */
  @Public()
  @Get("ready")
  async ready(): Promise<{ status: "ok"; postgres: "ok"; redis: "ok" }> {
    const checks = await Promise.allSettled([
      getDb().execute(sql`select 1`),
      this.redis.ping(),
    ]);
    const pgOk = checks[0].status === "fulfilled";
    const redisOk = checks[1].status === "fulfilled";
    if (!pgOk || !redisOk) {
      throw new ServiceUnavailableException({
        status: "degraded",
        postgres: pgOk ? "ok" : "down",
        redis: redisOk ? "ok" : "down",
      });
    }
    return { status: "ok", postgres: "ok", redis: "ok" };
  }
}
