import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListContainers = vi.fn();
const mockCheckHealth = vi.fn();
const mockRegisterRoute = vi.fn();
const mockSetRouteHealth = vi.fn();

vi.mock("../fleet/services.js", () => ({
  getDocker: () => ({ listContainers: mockListContainers }),
}));

vi.mock("@wopr-network/provision-client", () => ({
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
}));

vi.mock("../proxy/fleet-resolver.js", () => ({
  registerRoute: (...args: unknown[]) => mockRegisterRoute(...args),
  setRouteHealth: (...args: unknown[]) => mockSetRouteHealth(...args),
}));

vi.mock("../config.js", () => ({
  getConfig: () => ({
    PAPERCLIP_CONTAINER_PORT: 3100,
  }),
}));

vi.mock("../log.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { hydrateRoutes } = await import("../fleet/hydrate.js");

describe("hydrateRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no wopr-* containers exist", async () => {
    mockListContainers.mockResolvedValue([{ Names: ["/some-other-container"], State: "running", Id: "abc" }]);

    await hydrateRoutes();

    expect(mockRegisterRoute).not.toHaveBeenCalled();
  });

  it("registers routes for running wopr-* containers", async () => {
    mockListContainers.mockResolvedValue([
      { Names: ["/wopr-acme"], State: "running", Id: "container-1" },
      { Names: ["/wopr-globex"], State: "running", Id: "container-2" },
    ]);
    mockCheckHealth.mockResolvedValue(true);

    await hydrateRoutes();

    expect(mockRegisterRoute).toHaveBeenCalledTimes(2);
    expect(mockRegisterRoute).toHaveBeenCalledWith("container-1", "acme", "wopr-acme", 3100);
    expect(mockRegisterRoute).toHaveBeenCalledWith("container-2", "globex", "wopr-globex", 3100);
  });

  it("skips stopped containers", async () => {
    mockListContainers.mockResolvedValue([
      { Names: ["/wopr-acme"], State: "running", Id: "container-1" },
      { Names: ["/wopr-stopped"], State: "exited", Id: "container-2" },
    ]);
    mockCheckHealth.mockResolvedValue(true);

    await hydrateRoutes();

    expect(mockRegisterRoute).toHaveBeenCalledTimes(1);
    expect(mockRegisterRoute).toHaveBeenCalledWith("container-1", "acme", "wopr-acme", 3100);
  });

  it("marks unhealthy containers in route table", async () => {
    mockListContainers.mockResolvedValue([{ Names: ["/wopr-sick"], State: "running", Id: "container-1" }]);
    mockCheckHealth.mockResolvedValue(false);

    await hydrateRoutes();

    expect(mockRegisterRoute).toHaveBeenCalledWith("container-1", "sick", "wopr-sick", 3100);
    expect(mockSetRouteHealth).toHaveBeenCalledWith("container-1", false);
  });

  it("handles empty container list", async () => {
    mockListContainers.mockResolvedValue([]);

    await hydrateRoutes();

    expect(mockRegisterRoute).not.toHaveBeenCalled();
  });

  it("registers healthy containers without calling setRouteHealth", async () => {
    mockListContainers.mockResolvedValue([{ Names: ["/wopr-healthy"], State: "running", Id: "container-1" }]);
    mockCheckHealth.mockResolvedValue(true);

    await hydrateRoutes();

    expect(mockRegisterRoute).toHaveBeenCalledTimes(1);
    expect(mockSetRouteHealth).not.toHaveBeenCalled();
  });
});
