import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stubs
vi.stubEnv("PROVISION_SECRET", "test-secret");
vi.stubEnv("GATEWAY_URL", "https://gateway.test/v1");
vi.stubEnv("PLATFORM_DOMAIN", "runpaperclip.ai");

const mockValidateTenantAccess = vi.fn();
const mockGetOrgMemberRepo = vi.fn();
const mockProfileStoreList = vi.fn();

vi.mock("@wopr-network/platform-core/auth", () => ({
  validateTenantAccess: (...args: unknown[]) => mockValidateTenantAccess(...args),
}));

vi.mock("@wopr-network/platform-core/auth/better-auth", () => ({
  getAuth: () => ({
    api: {
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
    },
  }),
}));

vi.mock("../fleet/services.js", () => ({
  getOrgMemberRepo: () => mockGetOrgMemberRepo(),
  getProfileStore: () => ({ list: mockProfileStoreList }),
  getDocker: () => ({}),
  getFleetManager: () => ({}),
  getProxyManager: () => ({
    getRoutes: () => [
      { instanceId: "i1", subdomain: "acme", upstreamHost: "wopr-acme", upstreamPort: 3100, healthy: true },
    ],
    addRoute: vi.fn(),
  }),
}));

vi.mock("../proxy/fleet-resolver.js", () => ({
  resolveContainerUrl: (sub: string) => (sub === "acme" ? "http://wopr-acme:3100" : null),
}));

vi.mock("../log.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { tenantProxyMiddleware } = await import("../proxy/tenant-proxy.js");

function createApp() {
  const app = new Hono();
  app.use("/*", tenantProxyMiddleware);
  app.get("/*", (c) => c.json({ passthrough: true }));
  return app;
}

describe("tenant ownership check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 when user is not a member of the tenant", async () => {
    const orgRepo = { findMember: vi.fn() };
    mockGetOrgMemberRepo.mockReturnValue(orgRepo);
    mockProfileStoreList.mockResolvedValue([{ name: "acme", tenantId: "tenant-abc" }]);
    mockValidateTenantAccess.mockResolvedValue(false);

    const app = createApp();
    const res = await app.request("http://acme.runpaperclip.ai/dashboard", {
      headers: { host: "acme.runpaperclip.ai" },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("not a member");
    expect(mockValidateTenantAccess).toHaveBeenCalledWith("user-1", "tenant-abc", orgRepo);
  });

  it("allows access when user is a member of the tenant", async () => {
    const orgRepo = { findMember: vi.fn() };
    mockGetOrgMemberRepo.mockReturnValue(orgRepo);
    mockProfileStoreList.mockResolvedValue([{ name: "acme", tenantId: "tenant-abc" }]);
    mockValidateTenantAccess.mockResolvedValue(true);

    // Mock fetch for the upstream proxy call
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const app = createApp();
    const res = await app.request("http://acme.runpaperclip.ai/dashboard", {
      headers: { host: "acme.runpaperclip.ai" },
    });

    expect(res.status).toBe(200);
    expect(mockValidateTenantAccess).toHaveBeenCalledWith("user-1", "tenant-abc", orgRepo);

    globalThis.fetch = originalFetch;
  });

  it("skips ownership check when orgMemberRepo is not configured", async () => {
    mockGetOrgMemberRepo.mockReturnValue(null);

    // Mock fetch for the upstream proxy call
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const app = createApp();
    const res = await app.request("http://acme.runpaperclip.ai/dashboard", {
      headers: { host: "acme.runpaperclip.ai" },
    });

    expect(res.status).toBe(200);
    expect(mockValidateTenantAccess).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it("allows access when profile not found in store (new container)", async () => {
    const orgRepo = { findMember: vi.fn() };
    mockGetOrgMemberRepo.mockReturnValue(orgRepo);
    mockProfileStoreList.mockResolvedValue([{ name: "other", tenantId: "tenant-other" }]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const app = createApp();
    const res = await app.request("http://acme.runpaperclip.ai/dashboard", {
      headers: { host: "acme.runpaperclip.ai" },
    });

    // No profile match → ownership check skipped → proxied
    expect(res.status).toBe(200);
    expect(mockValidateTenantAccess).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it("passes through non-tenant requests without ownership check", async () => {
    const app = createApp();
    const res = await app.request("http://runpaperclip.ai/health", {
      headers: { host: "runpaperclip.ai" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passthrough).toBe(true);
    expect(mockValidateTenantAccess).not.toHaveBeenCalled();
  });
});
