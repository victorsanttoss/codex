import { describe, expect, it } from "vitest";
import { runsHttp, runsScheduler, runsSessionWorker, runsWorkers } from "./roles";

describe("roles (separação de processos M11/M13)", () => {
  it("api: só HTTP", () => {
    expect([runsHttp("api"), runsWorkers("api"), runsScheduler("api")]).toEqual([true, false, false]);
  });
  it("worker: só consumidores de fila", () => {
    expect([runsHttp("worker"), runsWorkers("worker"), runsScheduler("worker")]).toEqual([false, true, false]);
  });
  it("scheduler: só cron/scans", () => {
    expect([runsHttp("scheduler"), runsWorkers("scheduler"), runsScheduler("scheduler")]).toEqual([false, false, true]);
  });
  it("session-worker (M13): só sockets Baileys; isolado de http/worker/scheduler", () => {
    expect([
      runsHttp("session-worker"),
      runsWorkers("session-worker"),
      runsScheduler("session-worker"),
      runsSessionWorker("session-worker"),
    ]).toEqual([false, false, false, true]);
  });
  it("all: tudo (dev/single-process), inclui session-worker", () => {
    expect([runsHttp("all"), runsWorkers("all"), runsScheduler("all"), runsSessionWorker("all")]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});
