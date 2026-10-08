import { createHash } from "node:crypto";
import type { Params } from "nestjs-pino";
import type { AppConfig } from "@sdr/config";
import { getContext } from "@sdr/core";

/**
 * Configura o pino com os seguintes critérios:
 *  - HTTP/erros usam campos permitidos, sem payload, headers ou URL com query.
 *  - REDACT: defesa adicional para objetos logados diretamente.
 *  - customProps: IDs internos e correlação pseudonimizada da conversa.
 */
export function buildPinoParams(cfg: AppConfig): Params {
  return {
    pinoHttp: {
      level: cfg.logLevel,
      serializers: {
        req: (req: {
          id?: unknown;
          method?: string;
          raw?: { route?: { path?: unknown } };
        }) => {
          // O template da rota é configuração do servidor; a URL original pode
          // conter telefone, token de verificação ou outros dados enviados pelo cliente.
          const route = req.raw?.route?.path;
          return {
            id: req.id,
            method: req.method,
            ...(typeof route === "string" ? { url: route } : {}),
          };
        },
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
        err: safeErrorFields,
      },
      // No middleware inicial o Express ainda não resolveu a rota. Anexa o
      // template no encerramento, quando ele existe, sem usar a URL do cliente.
      customSuccessObject: (req, _res, val) => ({
        ...val,
        ...httpRouteFields(req),
      }),
      customErrorObject: (req, _res, _err, val) => ({
        ...val,
        ...httpRouteFields(req),
      }),
      redact: {
        // Cobre nomes comuns em objetos diretos e nos níveis usuais de config/
        // headers. A proteção dos erros não depende da profundidade do payload:
        // safeErrorFields descarta as propriedades externas por completo.
        paths: ["", "*.", "*.*.", "*.*.*."].flatMap((prefix) =>
          [
            "authorization",
            "cookie",
            "password",
            "passwordHash",
            "password_hash",
            "token",
            "accessToken",
            "refreshToken",
            "access_token",
            "refresh_token",
            "apiKey",
            "api_key",
            "clientSecret",
            "client_secret",
            "secret",
            "ciphertext",
            '["set-cookie"]',
            '["x-platform-token"]',
            '["x-intake-token"]',
            '["x-broker-token"]',
          ].map(
            (key) =>
              `${key.startsWith("[") ? prefix.replace(/\.$/, "") : prefix}${key}`,
          ),
        ),
        remove: true,
      },
      customProps: () => {
        const ctx = getContext();
        if (!ctx) return {};
        return {
          requestId: ctx.requestId,
          ...(ctx.tenantId
            ? { tenantId: ctx.tenantId, userId: ctx.userId }
            : {}),
          ...(ctx.system ? { system: true } : {}),
          ...(ctx.conversationKey
            ? { conversationRef: logCorrelationId(ctx.conversationKey) }
            : {}),
        };
      },
    },
  };
}

function httpRouteFields(request: unknown): Record<string, unknown> {
  const route = (request as { route?: { path?: unknown } }).route?.path;
  return typeof route === "string" ? { route } : {};
}

/** Correlação estável sem imprimir telefone/JID. Hash é pseudônimo, não anonimização. */
export function logCorrelationId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Mensagens/cause/config de erros externos podem conter payloads ou credenciais. */
export function safeErrorFields(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { type: "UnknownError" };
  const err = error as {
    type?: unknown;
    code?: unknown;
    statusCode?: unknown;
    stack?: unknown;
  };
  const type = error instanceof Error ? error.constructor.name : err.type;
  const result: Record<string, unknown> = {
    type:
      typeof type === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(type)
        ? type
        : "Error",
  };
  if (
    typeof err.code === "string" &&
    /^(?:E[A-Z_]{2,24}|ERR_[A-Z_]{1,48}|[0-9A-Z]{5})$/.test(err.code)
  ) {
    result.code = err.code;
  }
  if (
    typeof err.statusCode === "number" &&
    err.statusCode >= 100 &&
    err.statusCode <= 599
  ) {
    result.statusCode = err.statusCode;
  }
  if (typeof err.stack === "string") {
    // Preserva frames do runtime (arquivo/linha), mas não o cabeçalho, mensagens
    // multilinha, URLs de provedores ou caminhos com query/valores externos.
    const frames = err.stack
      .split("\n")
      .filter((line) =>
        /^\s+at (?:[A-Za-z0-9_.$<> \[\]]+ \()?\/?[A-Za-z0-9_./@:\\-]+:\d+:\d+\)?$/.test(
          line,
        ),
      )
      .slice(0, 12);
    if (frames.length) result.stack = frames.join("\n");
  }
  return result;
}
