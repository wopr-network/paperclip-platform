import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkHealth, provisionContainer } from "@wopr-network/provision-client";

/**
 * Tests that the provision-client package integration works correctly.
 * These test the imported functions from @wopr-network/provision-client.
 */
describe("provision-client package integration", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("provisionContainer", () => {
    it("sends provision request with generic field names", async () => {
      const mockResponse = {
        tenantEntityId: "comp-1",
        tenantSlug: "ACM",
        adminUserId: "user-1",
        agents: [],
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await provisionContainer("http://wopr-alice:3100", "secret", {
        tenantId: "t1",
        tenantName: "Acme Corp",
        gatewayUrl: "https://gw.test/v1",
        apiKey: "sk-test",
        budgetCents: 10000,
        adminUser: { id: "user-1", email: "a@acme.com", name: "Admin" },
      });

      expect(result.tenantEntityId).toBe("comp-1");
      expect(result.tenantSlug).toBe("ACM");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://wopr-alice:3100/internal/provision",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer secret",
          }),
        }),
      );
    });

    it("throws on non-ok response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.resolve("Missing fields"),
      });

      await expect(
        provisionContainer("http://wopr-alice:3100", "secret", {
          tenantId: "t1",
          tenantName: "Test",
          gatewayUrl: "https://gw.test/v1",
          apiKey: "sk-test",
          budgetCents: 0,
          adminUser: { id: "u1", email: "a@test.com", name: "A" },
        }),
      ).rejects.toThrow("Provision failed (422)");
    });
  });

  describe("checkHealth", () => {
    it("returns true for healthy container", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, provisioning: true }),
      });

      expect(await checkHealth("http://wopr-alice:3100")).toBe(true);
    });

    it("returns false on network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      expect(await checkHealth("http://wopr-alice:3100")).toBe(false);
    });

    it("returns false when provisioning is disabled", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, provisioning: false }),
      });

      expect(await checkHealth("http://wopr-alice:3100")).toBe(false);
    });
  });
});
