import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCheckHealth = vi.fn();
const mockGetRoutes = vi.fn();
const mockSetRouteHealth = vi.fn();

vi.mock("@wopr-network/provision-client", () => ({
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
}));

vi.mock("../proxy/fleet-resolver.js", () => ({
  getRoutes: () => mockGetRoutes(),
  setRouteHealth: (...args: unknown[]) => mockSetRouteHealth(...args),
}));

vi.mock("../log.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { runHealthChecks, startHealthMonitor, stopHealthMonitor } = await import("../fleet/health-monitor.js");

describe("health-monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    stopHealthMonitor();
  });

  afterEach(() => {
    stopHealthMonitor();
    vi.useRealTimers();
  });

  describe("runHealthChecks", () => {
    it("does nothing when no routes exist", async () => {
      mockGetRoutes.mockReturnValue([]);

      await runHealthChecks();

      expect(mockCheckHealth).not.toHaveBeenCalled();
    });

    it("checks health of all registered routes", async () => {
      mockGetRoutes.mockReturnValue([
        { instanceId: "a", subdomain: "acme", upstreamHost: "wopr-acme", upstreamPort: 3100, healthy: true },
        { instanceId: "b", subdomain: "globex", upstreamHost: "wopr-globex", upstreamPort: 3100, healthy: true },
      ]);
      mockCheckHealth.mockResolvedValue(true);

      await runHealthChecks();

      expect(mockCheckHealth).toHaveBeenCalledTimes(2);
      expect(mockCheckHealth).toHaveBeenCalledWith("http://wopr-acme:3100");
      expect(mockCheckHealth).toHaveBeenCalledWith("http://wopr-globex:3100");
    });

    it("marks healthy container as unhealthy when check fails", async () => {
      mockGetRoutes.mockReturnValue([
        { instanceId: "a", subdomain: "acme", upstreamHost: "wopr-acme", upstreamPort: 3100, healthy: true },
      ]);
      mockCheckHealth.mockResolvedValue(false);

      await runHealthChecks();

      expect(mockSetRouteHealth).toHaveBeenCalledWith("a", false);
    });

    it("marks unhealthy container as healthy when check passes", async () => {
      mockGetRoutes.mockReturnValue([
        { instanceId: "a", subdomain: "acme", upstreamHost: "wopr-acme", upstreamPort: 3100, healthy: false },
      ]);
      mockCheckHealth.mockResolvedValue(true);

      await runHealthChecks();

      expect(mockSetRouteHealth).toHaveBeenCalledWith("a", true);
    });

    it("does not call setRouteHealth when status unchanged", async () => {
      mockGetRoutes.mockReturnValue([
        { instanceId: "a", subdomain: "acme", upstreamHost: "wopr-acme", upstreamPort: 3100, healthy: true },
      ]);
      mockCheckHealth.mockResolvedValue(true);

      await runHealthChecks();

      expect(mockSetRouteHealth).not.toHaveBeenCalled();
    });

    it("marks as unhealthy when checkHealth throws", async () => {
      mockGetRoutes.mockReturnValue([
        { instanceId: "a", subdomain: "acme", upstreamHost: "wopr-acme", upstreamPort: 3100, healthy: true },
      ]);
      mockCheckHealth.mockRejectedValue(new Error("connection refused"));

      await runHealthChecks();

      expect(mockSetRouteHealth).toHaveBeenCalledWith("a", false);
    });

    it("does not double-mark already unhealthy on error", async () => {
      mockGetRoutes.mockReturnValue([
        { instanceId: "a", subdomain: "acme", upstreamHost: "wopr-acme", upstreamPort: 3100, healthy: false },
      ]);
      mockCheckHealth.mockRejectedValue(new Error("connection refused"));

      await runHealthChecks();

      expect(mockSetRouteHealth).not.toHaveBeenCalled();
    });
  });

  describe("startHealthMonitor / stopHealthMonitor", () => {
    it("starts interval that runs health checks", async () => {
      mockGetRoutes.mockReturnValue([
        { instanceId: "a", subdomain: "acme", upstreamHost: "wopr-acme", upstreamPort: 3100, healthy: true },
      ]);
      mockCheckHealth.mockResolvedValue(true);

      startHealthMonitor(1000);

      expect(mockCheckHealth).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockCheckHealth).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockCheckHealth).toHaveBeenCalledTimes(2);
    });

    it("stopHealthMonitor clears the interval", async () => {
      mockGetRoutes.mockReturnValue([
        { instanceId: "a", subdomain: "acme", upstreamHost: "wopr-acme", upstreamPort: 3100, healthy: true },
      ]);
      mockCheckHealth.mockResolvedValue(true);

      startHealthMonitor(1000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockCheckHealth).toHaveBeenCalledTimes(1);

      stopHealthMonitor();

      await vi.advanceTimersByTimeAsync(5000);
      expect(mockCheckHealth).toHaveBeenCalledTimes(1);
    });

    it("startHealthMonitor is idempotent", () => {
      mockGetRoutes.mockReturnValue([]);

      startHealthMonitor(1000);
      startHealthMonitor(1000);

      // Should not throw or create duplicate intervals
      stopHealthMonitor();
    });
  });
});
