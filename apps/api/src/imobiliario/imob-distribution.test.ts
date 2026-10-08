import { describe, expect, it, beforeEach, vi } from "vitest";
import { runWithTenant } from "@sdr/core";

const db = vi.hoisted(() => ({
  createNotification: vi.fn(),
  getActiveImobAssignment: vi.fn(),
  listImobBrokers: vi.fn(),
  listImobPriorBrokerIds: vi.fn(),
  listImobBrokerCandidates: vi.fn(),
  recordImobEvent: vi.fn(),
}));

vi.mock("@sdr/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdr/db")>()),
  ...db,
}));

import { ImobDistributionService } from "./imob-distribution.service";

describe("durable imobiliário handoff failures", () => {
  const tenantId = "d28d4a89-e9d5-4a36-9438-4ab53f19768a";
  const conversationId = "3279de21-8b9d-45d4-9ae8-3b6664b475ed";

  beforeEach(() => {
    vi.resetAllMocks();
    db.listImobBrokers.mockResolvedValue([{ id: "broker-1" }]);
    db.getActiveImobAssignment.mockResolvedValue(null);
    db.listImobPriorBrokerIds.mockResolvedValue([]);
    db.listImobBrokerCandidates.mockResolvedValue([]);
    db.recordImobEvent.mockResolvedValue(undefined);
    db.createNotification.mockResolvedValue({ id: "notification-1", created: true });
  });

  it("a no-broker alert failure propagates in durable mode and retry uses the same notification identity", async () => {
    const failure = new Error("notification_store_unavailable");
    db.createNotification.mockRejectedValueOnce(failure);
    const service = new ImobDistributionService();

    await runWithTenant({ tenantId }, async () => {
      await expect(service.onHandoff(conversationId, { retryOnFailure: true }))
        .rejects.toBe(failure);
      await expect(service.onHandoff(conversationId, { retryOnFailure: true }))
        .resolves.toBeUndefined();
    });

    expect(db.createNotification).toHaveBeenCalledTimes(2);
    expect(db.createNotification.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: `imob:exhausted:${conversationId}:no_candidates`,
      kind: "handoff",
    });
    expect(db.createNotification.mock.calls[1]?.[0])
      .toEqual(db.createNotification.mock.calls[0]?.[0]);
  });

  it("callers without a durable journal preserve fail-safe behavior when the manager alert fails", async () => {
    db.createNotification.mockRejectedValueOnce(new Error("notification_store_unavailable"));
    await expect(runWithTenant({ tenantId }, () =>
      new ImobDistributionService().onHandoff(conversationId),
    )).resolves.toBeUndefined();
    expect(db.createNotification).toHaveBeenCalledTimes(1);
  });

  it("an existing active assignment completes replay without distributing or alerting again", async () => {
    db.getActiveImobAssignment.mockResolvedValue({ id: "assignment-1", brokerId: "broker-1" });
    await runWithTenant({ tenantId }, () =>
      new ImobDistributionService().onHandoff(conversationId, { retryOnFailure: true }),
    );
    expect(db.listImobBrokerCandidates).not.toHaveBeenCalled();
    expect(db.recordImobEvent).not.toHaveBeenCalled();
    expect(db.createNotification).not.toHaveBeenCalled();
  });
});
