import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../log.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { MemberProvisionClient } = await import("../fleet/member-provision-client.js");

const SECRET = "test-provision-secret";
const BASE = "http://paperclip-alice:3100";

describe("MemberProvisionClient", () => {
  let client: InstanceType<typeof MemberProvisionClient>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    client = new MemberProvisionClient(SECRET);
  });

  // ── Authorization header ──────────────────────────────────────────

  it("includes Bearer token in Authorization header", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await client.addMember(BASE, "org-1", { id: "u1", email: "a@b.com" }, "member");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${SECRET}`,
        }),
      }),
    );
  });

  // ── addMember ─────────────────────────────────────────────────────

  describe("addMember", () => {
    it("sends POST to /internal/members/add with correct body", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const user = { id: "u1", email: "a@b.com", name: "Alice" };
      const result = await client.addMember(BASE, "org-1", user, "admin");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE}/internal/members/add`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ companyId: "org-1", user, role: "admin" }),
        }),
      );
      expect(result).toEqual({ success: true });
    });
  });

  // ── removeMember ──────────────────────────────────────────────────

  describe("removeMember", () => {
    it("sends POST to /internal/members/remove with correct body", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const result = await client.removeMember(BASE, "org-1", "u1");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE}/internal/members/remove`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ companyId: "org-1", userId: "u1" }),
        }),
      );
      expect(result).toEqual({ success: true });
    });
  });

  // ── changeRole ────────────────────────────────────────────────────

  describe("changeRole", () => {
    it("sends POST to /internal/members/change-role with correct body", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const result = await client.changeRole(BASE, "org-1", "u1", "owner");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE}/internal/members/change-role`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ companyId: "org-1", userId: "u1", role: "owner" }),
        }),
      );
      expect(result).toEqual({ success: true });
    });
  });

  // ── Success / failure ─────────────────────────────────────────────

  it("returns { success: true } on 200 response", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const result = await client.addMember(BASE, "org-1", { id: "u1", email: "a@b.com" }, "member");

    expect(result).toEqual({ success: true });
  });

  it("returns { success: false, error } on non-200 response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve("Validation failed"),
    });

    const result = await client.addMember(BASE, "org-1", { id: "u1", email: "a@b.com" }, "member");

    expect(result.success).toBe(false);
    expect(result.error).toContain("422");
    expect(result.error).toContain("Validation failed");
  });

  it("returns { success: false, error } on network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await client.removeMember(BASE, "org-1", "u1");

    expect(result.success).toBe(false);
    expect(result.error).toBe("ECONNREFUSED");
  });

  it("handles text() rejection gracefully on error response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("body stream consumed")),
    });

    const result = await client.changeRole(BASE, "org-1", "u1", "admin");

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });
});
