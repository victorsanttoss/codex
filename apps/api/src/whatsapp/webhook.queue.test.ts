import { describe, expect, it } from "vitest";
import { LockTimeoutError } from "../queue/redis-mutex";
import { InboundProcessingError } from "./inbound-pipeline.service";
import { fairnessKeyFromRawBody, isLockContention } from "./webhook.queue";

describe("isLockContention (requeue por contenção vs falha real)", () => {
  it("LockTimeoutError direto → contenção", () => {
    expect(isLockContention(new LockTimeoutError("conv-1"))).toBe(true);
  });

  it("erro agregado com AO MENOS um LockTimeoutError → contenção", () => {
    const err = new InboundProcessingError([new Error("llm caiu"), new LockTimeoutError("conv-2")]);
    expect(isLockContention(err)).toBe(true);
  });

  it("erro agregado SEM lock timeout → falha real (retry do BullMQ)", () => {
    expect(isLockContention(new InboundProcessingError([new Error("db caiu")]))).toBe(false);
  });

  it("erro comum → falha real", () => {
    expect(isLockContention(new Error("qualquer"))).toBe(false);
    expect(isLockContention(undefined)).toBe(false);
  });
});

describe("fairnessKeyFromRawBody (cota de jobs em voo por tenant)", () => {
  it("extrai o phone_number_id do payload do webhook", () => {
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "PN123" } } }] }],
    });
    expect(fairnessKeyFromRawBody(body)).toBe("PN123");
  });

  it("payload sem metadata/número → undefined (sem cota)", () => {
    expect(fairnessKeyFromRawBody(JSON.stringify({ entry: [{ changes: [{ value: {} }] }] }))).toBeUndefined();
    expect(fairnessKeyFromRawBody("{}")).toBeUndefined();
  });

  it("payload não-JSON → undefined (não lança)", () => {
    expect(fairnessKeyFromRawBody("<xml/>")).toBeUndefined();
    expect(fairnessKeyFromRawBody("")).toBeUndefined();
  });
});
