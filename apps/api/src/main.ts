import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { loadConfig } from "@sdr/config";
import { AppModule } from "./app.module";
import { runsHttp } from "./runtime/roles";

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();
  const role = cfg.app.role;

  // rawBody: true preserva o corpo bruto (necessário para validar a assinatura
  // do webhook do WhatsApp — HMAC sobre os bytes originais).
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  const log = app.get(Logger);
  // Cabeçalhos de segurança (API JSON): mantém HSTS/noSniff/frameguard/
  // referrerPolicy. CSP fica desligada — a API não serve HTML; a política de
  // conteúdo do painel vive no next.config do web.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "same-site" },
      referrerPolicy: { policy: "no-referrer" },
      hsts: { maxAge: 31536000, includeSubDomains: true },
    }),
  );
  // CORS lido da CONFIG validada (nunca de process.env aqui). Em produção a
  // config já rejeita localhost/wildcard; credentials habilitado (cookies).
  app.enableCors({
    origin: cfg.web.origin.split(",").map((o) => o.trim()).filter(Boolean),
    credentials: true,
  });
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // SIGTERM/SIGINT → drena filas e fecha conexões (OnModuleDestroy dos serviços).
  app.enableShutdownHooks();

  if (runsHttp(role)) {
    await app.listen(cfg.api.port);
    log.log(`API HTTP ouvindo em :${cfg.api.port} (role=${role})`);
  } else {
    // worker/scheduler: inicializa os módulos (workers/scans sobem por role) sem HTTP.
    await app.init();
    log.log(`Processo de fundo iniciado (role=${role})`);
  }
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Falha ao subir o processo:", err);
  process.exit(1);
});
