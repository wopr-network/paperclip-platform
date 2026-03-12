import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stubs
vi.stubEnv("PROVISION_SECRET", "test-secret");
vi.stubEnv("GATEWAY_URL", "https://gateway.test/v1");
vi.stubEnv("PLATFORM_DOMAIN", "runpaperclip.com");
vi.stubEnv("ADMIN_API_KEY", "admin-key-123");

const mockIsPlatformAdmin = vi.fn();
let userRoleRepoEnabled = true;

vi.mock("../fleet/services.js", () => ({
  getUserRoleRepo: () => (userRoleRepoEnabled ? { isPlatformAdmin: mockIsPlatformAdmin } : null),
  getDocker: () => ({}),
  getProfileStore: () => ({ list: vi.fn().mockResolvedValue([]) }),
  getFleetManager: () => ({}),
  getProxyManager: () => ({}),
  getOrgMemberRepo: () => null,
  getCreditLedger: () => null,
}));

vi.mock("../log.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock BetterAuth — controlled per test
const mockGetSession = vi.fn();
vi.mock("@wopr-network/platform-core/auth/better-auth", () => ({
  getAuth: () => ({
    api: { getSession: mockGetSession },
  }),
}));

const { adminAuth } = await import("../middleware/admin-auth.js");

function createApp() {
  const app = new Hono();
  app.use("/api/admin/*", adminAuth);
  app.get("/api/admin/test", (c) => c.json({ ok: true }));
  return app;
}

describe("admin auth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userRoleRepoEnabled = true;
    mockGetSession.mockResolvedValue(null);
  });

  it("returns 401 when no auth is provided", async () => {
    const app = createApp();
    const res = await app.request(new Request("http://localhost/api/admin/test"));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Unauthorized");
  });

  it("allows access with valid ADMIN_API_KEY", async () => {
    const app = createApp();
    const res = await app.request(
      new Request("http://localhost/api/admin/test", {
        headers: { authorization: "Bearer admin-key-123" },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 403 with invalid API key", async () => {
    const app = createApp();
    const res = await app.request(
      new Request("http://localhost/api/admin/test", {
        headers: { authorization: "Bearer wrong-key" },
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("invalid credentials");
  });

  it("allows access for platform admin via session", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
    mockIsPlatformAdmin.mockResolvedValue(true);

    const app = createApp();
    const res = await app.request(
      new Request("http://localhost/api/admin/test", {
        headers: { cookie: "session=valid" },
      }),
    );

    expect(res.status).toBe(200);
    expect(mockIsPlatformAdmin).toHaveBeenCalledWith("user-1");
  });

  it("returns 403 for non-admin authenticated user", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-2" } });
    mockIsPlatformAdmin.mockResolvedValue(false);

    const app = createApp();
    const res = await app.request(
      new Request("http://localhost/api/admin/test", {
        headers: { cookie: "session=valid" },
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("admin access required");
  });

  it("returns 403 when session exists but no role repo configured", async () => {
    userRoleRepoEnabled = false;
    mockGetSession.mockResolvedValue({ user: { id: "user-3" } });

    const app = createApp();
    const res = await app.request(
      new Request("http://localhost/api/admin/test", {
        headers: { cookie: "session=valid" },
      }),
    );

    expect(res.status).toBe(403);
  });

  it("API key takes precedence over session check", async () => {
    const app = createApp();
    const res = await app.request(
      new Request("http://localhost/api/admin/test", {
        headers: {
          authorization: "Bearer admin-key-123",
          cookie: "session=valid",
        },
      }),
    );

    expect(res.status).toBe(200);
    // Session check should not have been called since API key matched first
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});
