import { Global, Module } from "@nestjs/common";
import { loadConfig, type AppConfig } from "@sdr/config";

/** Token de injeção da config validada (12-factor). */
export const APP_CONFIG = "APP_CONFIG";

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
