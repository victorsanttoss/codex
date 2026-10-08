import { Redis } from "ioredis";
import type { AppConfig } from "@sdr/config";
import { APP_CONFIG } from "../config/config.module";
import { REDIS_CLIENT } from "../redis/redis.module";
import { QR_STORE, RedisQrStore } from "./qr-store";

/** Provider do QrStore (Redis) — troca de QR/estado entre session-worker e API. */
export const qrStoreProvider = {
  provide: QR_STORE,
  inject: [REDIS_CLIENT, APP_CONFIG],
  useFactory: (redis: Redis, cfg: AppConfig) => new RedisQrStore(redis, cfg.baileys.qrTtlSeconds),
};
