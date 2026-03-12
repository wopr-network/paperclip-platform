import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock platform-core ProxyManager
const mockProxyManager = {
  addRoute: vi.fn(),
  removeRoute: vi.fn(),
  updateHealth: vi.fn(),
  getRoutes: vi.fn().mockReturnValue([]),
  start: vi.fn(),
  stop: vi.fn(),
  reload: vi.fn(),
};

vi.mock("../fleet/services.js", () => ({
  getProxyManager: () => mockProxyManager,
}));

// Stub env before importing modules that read config
vi.stubEnv("PROVISION_SECRET", "test-secret");
vi.stubEnv("GATEWAY_URL", "https://gateway.test/v1");

import { getRoutes, registerRoute, removeRoute, resolveContainerUrl, setRouteHealth } from "../proxy/fleet-resolver.js";

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("fleet-resolver (ProxyManager-backed)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockProxyManager.getRoutes.mockReturnValue([]);
  });

  it("registers a route via ProxyManager.addRoute", async () => {
    await registerRoute("inst-1", "alice", "wopr-alice", 3100);
    expect(mockProxyManager.addRoute).toHaveBeenCalledWith({
      instanceId: "inst-1",
      subdomain: "alice",
      upstreamHost: "wopr-alice",
      upstreamPort: 3100,
      healthy: true,
    });
  });

  it("resolves a healthy route to URL", () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { instanceId: "inst-1", subdomain: "alice", upstreamHost: "wopr-alice", upstreamPort: 3100, healthy: true },
    ]);
    const url = resolveContainerUrl("alice");
    expect(url).toBe("http://wopr-alice:3100");
  });

  it("returns null for unknown subdomain", () => {
    mockProxyManager.getRoutes.mockReturnValue([]);
    expect(resolveContainerUrl("unknown")).toBeNull();
  });

  it("returns null for unhealthy container", () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { instanceId: "inst-1", subdomain: "bob", upstreamHost: "wopr-bob", upstreamPort: 3100, healthy: false },
    ]);
    expect(resolveContainerUrl("bob")).toBeNull();
  });

  it("removes routes via ProxyManager.removeRoute", () => {
    removeRoute("inst-1");
    expect(mockProxyManager.removeRoute).toHaveBeenCalledWith("inst-1");
  });

  it("updates health via ProxyManager.updateHealth", () => {
    setRouteHealth("inst-1", false);
    expect(mockProxyManager.updateHealth).toHaveBeenCalledWith("inst-1", false);
  });

  it("lists routes from ProxyManager", () => {
    const mockRoutes = [
      { instanceId: "i1", subdomain: "d1", upstreamHost: "wopr-d1", upstreamPort: 3100, healthy: true },
      { instanceId: "i2", subdomain: "d2", upstreamHost: "wopr-d2", upstreamPort: 3100, healthy: true },
    ];
    mockProxyManager.getRoutes.mockReturnValue(mockRoutes);
    expect(getRoutes()).toHaveLength(2);
  });
});
