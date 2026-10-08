import { describe, expect, it, vi } from "vitest";
import { runWithTenant } from "@sdr/core";
import type { AppConfig } from "@sdr/config";
import type { HttpClient } from "@sdr/whatsapp-cloud";
import { ChannelFactory } from "./channel-factory.service";

vi.mock("@sdr/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdr/db")>()),
  makeCipherFromEnv: () => ({}),
  TenantSecretsStore: class {
    async get() {
      return "fake-test-token";
    }
  },
}));

describe("reactive sender retries", () => {
  it("reactive override performs exactly one HTTP attempt on an unknown network outcome", async () => {
    const post = vi
      .fn()
      .mockRejectedValue(new Error("timeout after possible delivery"));
    const channels = new ChannelFactory(
      { whatsapp: { appSecret: "test-secret" } } as AppConfig,
      { post } as unknown as HttpClient,
    );
    await runWithTenant({ tenantId: "test-tenant" }, async () => {
      const sender = await channels.tenantSender(
        "account-1",
        "whatsapp_token",
        { retry: { maxAttempts: 1, baseDelayMs: 0 } },
      );
      await expect(
        sender.sendMessage({ to: "5511999999999", text: "test" }),
      ).rejects.toThrow();
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("other callers preserve the adapter's existing default retry policy", async () => {
    const post = vi.fn().mockRejectedValue(new Error("network unavailable"));
    const channels = new ChannelFactory(
      { whatsapp: { appSecret: "test-secret" } } as AppConfig,
      { post } as unknown as HttpClient,
    );
    await runWithTenant({ tenantId: "test-tenant" }, async () => {
      const sender = await channels.tenantSender("account-1", "whatsapp_token");
      await expect(
        sender.sendMessage({ to: "5511999999999", text: "test" }),
      ).rejects.toThrow();
    });
    expect(post).toHaveBeenCalledTimes(3);
  });
});
