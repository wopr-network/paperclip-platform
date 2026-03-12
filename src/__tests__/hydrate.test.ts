import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListContainers = vi.fn();
const mockCheckHealth = vi.fn();
const mockRegisterRoute = vi.fn();
const mockSetRouteHealth = vi.fn();
const mockAssignContainer = vi.fn();
const mockResolveUpstreamHost = vi.fn().mockImplementation((_id: string, name: string) => name);

const mockNodeRegistry = {
  list: () => [
    {
      config: { id: "local", name: "local", host: "localhost", useContainerNames: true },
      docker: { listContainers: mockListContainers },
      fleet: {},
    },
  ],
  assignContainer: mockAssignContainer,
  resolveUpstreamHost: mockResolveUpstreamHost,
};

vi.mock("../fleet/services.js", () => ({
  getNodeRegistry: () => mockNodeRegistry,
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
    mockResolveUpstreamHost.mockImplementation((_id: string, name: string) => name);
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
    expect(mockAssignContainer).toHaveBeenCalledWith("container-1", "local");
    expect(mockAssignContainer).toHaveBeenCalledWith("container-2", "local");
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

  it("hydrates from multiple nodes", async () => {
    const mockListContainers2 = vi.fn();
    mockNodeRegistry.list = () => [
      {
        config: { id: "node-1", name: "node-1", host: "h1", useContainerNames: true },
        docker: { listContainers: mockListContainers },
        fleet: {},
      },
      {
        config: { id: "node-2", name: "node-2", host: "192.168.1.100", useContainerNames: false },
        docker: { listContainers: mockListContainers2 },
        fleet: {},
      },
    ];
    mockListContainers.mockResolvedValue([{ Names: ["/wopr-alice"], State: "running", Id: "c1" }]);
    mockListContainers2.mockResolvedValue([{ Names: ["/wopr-bob"], State: "running", Id: "c2" }]);
    mockCheckHealth.mockResolvedValue(true);
    mockResolveUpstreamHost.mockImplementation((_id: string, name: string) => {
      if (_id === "c2") return "192.168.1.100";
      return name;
    });

    await hydrateRoutes();

    expect(mockRegisterRoute).toHaveBeenCalledTimes(2);
    expect(mockAssignContainer).toHaveBeenCalledWith("c1", "node-1");
    expect(mockAssignContainer).toHaveBeenCalledWith("c2", "node-2");
    expect(mockRegisterRoute).toHaveBeenCalledWith("c2", "bob", "192.168.1.100", 3100);

    // Reset list to single node for other tests
    mockNodeRegistry.list = () => [
      {
        config: { id: "local", name: "local", host: "localhost", useContainerNames: true },
        docker: { listContainers: mockListContainers },
        fleet: {},
      },
    ];
  });
});
