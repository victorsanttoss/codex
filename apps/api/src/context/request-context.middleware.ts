import { randomUUID } from "node:crypto";
import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { runWithRequestContext } from "@sdr/core";

/**
 * Envolve a requisição INTEIRA num único contexto (storage.run), anônimo no
 * início. O JwtAuthGuard preenche o tenant depois via assignTenant, mutando
 * este mesmo store — visível para handler e services (evita a armadilha do
 * enterWith). Também propaga request_id para todos os logs.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request & { requestId?: string }, res: Response, next: NextFunction): void {
    const headerId = req.headers["x-request-id"];
    const requestId = (typeof headerId === "string" && headerId) || randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    runWithRequestContext(requestId, () => next());
  }
}
