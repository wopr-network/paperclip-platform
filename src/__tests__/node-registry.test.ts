import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies — use class syntax so `new Docker()` / `new FleetManager()` work
vi.mock("dockerode", () => {
  return {
    default: class MockDocker {
      listContainers = vi.fn().mockResolvedValue([]);
      ping = vi.fn().mockResolvedValue("OK");
    },
  };
});

vi.mock("@wopr-network/platform-core/fleet/fleet-manager", () => {
  return {
    FleetManager: class MockFleetManager {
      create = vi.fn();
      start = vi.fn();
      stop = vi.fn();
      remove = vi.fn();
      status = vi.fn();
    },
  };
});

vi.mock("../log.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { LOCAL_NODE_ID, NodeRegistry } from "../fleet/node-registry.js";

const mockStore = {
  get: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
} as any;

describe("NodeRegistry", () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  describe("register", () => {
    it("registers a local node", () => {
      registry.register({ id: LOCAL_NODE_ID, name: "local", host: "localhost", useContainerNames: true }, mockStore);
      expect(registry.size).toBe(1);
      expect(registry.get(LOCAL_NODE_ID)).toBeDefined();
    });

    it("registers a remote node with docker URL", () => {
      registry.register(
        { id: "node-2", name: "worker-1", host: "192.168.1.100", dockerUrl: "tcp://192.168.1.100:2376" },
        mockStore,
      );
      expect(registry.size).toBe(1);
      expect(registry.get("node-2")?.config.host).toBe("192.168.1.100");
    });

    it("throws on duplicate node ID", () => {
      registry.register({ id: "n1", name: "a", host: "h1" }, mockStore);
      expect(() => registry.register({ id: "n1", name: "b", host: "h2" }, mockStore)).toThrow(/already registered/);
    });

    it("registers multiple nodes", () => {
      registry.register({ id: "n1", name: "node-1", host: "h1" }, mockStore);
      registry.register({ id: "n2", name: "node-2", host: "h2" }, mockStore);
      registry.register({ id: "n3", name: "node-3", host: "h3" }, mockStore);
      expect(registry.size).toBe(3);
      expect(registry.isMultiNode).toBe(true);
    });
  });

  describe("unregister", () => {
    it("removes a node with no containers", () => {
      registry.register({ id: "n1", name: "node-1", host: "h1" }, mockStore);
      registry.unregister("n1");
      expect(registry.size).toBe(0);
    });

    it("throws when containers are still assigned", () => {
      registry.register({ id: "n1", name: "node-1", host: "h1" }, mockStore);
      registry.assignContainer("c1", "n1");
      expect(() => registry.unregister("n1")).toThrow(/containers still assigned/);
    });
  });

  describe("container tracking", () => {
    beforeEach(() => {
      registry.register({ id: "n1", name: "node-1", host: "h1" }, mockStore);
      registry.register({ id: "n2", name: "node-2", host: "h2" }, mockStore);
    });

    it("assigns and looks up containers", () => {
      registry.assignContainer("c1", "n1");
      registry.assignContainer("c2", "n2");
      registry.assignContainer("c3", "n1");

      expect(registry.getContainerNode("c1")).toBe("n1");
      expect(registry.getContainerNode("c2")).toBe("n2");
      expect(registry.getContainerNode("c3")).toBe("n1");
    });

    it("returns undefined for unknown container", () => {
      expect(registry.getContainerNode("unknown")).toBeUndefined();
    });

    it("unassigns containers", () => {
      registry.assignContainer("c1", "n1");
      registry.unassignContainer("c1");
      expect(registry.getContainerNode("c1")).toBeUndefined();
    });

    it("lists containers on a node", () => {
      registry.assignContainer("c1", "n1");
      registry.assignContainer("c2", "n2");
      registry.assignContainer("c3", "n1");

      expect(registry.getContainersOnNode("n1")).toEqual(["c1", "c3"]);
      expect(registry.getContainersOnNode("n2")).toEqual(["c2"]);
    });

    it("counts containers per node", () => {
      registry.assignContainer("c1", "n1");
      registry.assignContainer("c2", "n1");
      registry.assignContainer("c3", "n2");

      const counts = registry.getContainerCounts();
      expect(counts.get("n1")).toBe(2);
      expect(counts.get("n2")).toBe(1);
    });

    it("initializes empty counts for all nodes", () => {
      const counts = registry.getContainerCounts();
      expect(counts.get("n1")).toBe(0);
      expect(counts.get("n2")).toBe(0);
    });
  });

  describe("resolveUpstreamHost", () => {
    it("uses container name for local node", () => {
      registry.register({ id: LOCAL_NODE_ID, name: "local", host: "localhost", useContainerNames: true }, mockStore);
      registry.assignContainer("c1", LOCAL_NODE_ID);
      expect(registry.resolveUpstreamHost("c1", "wopr-alice")).toBe("wopr-alice");
    });

    it("uses node host for remote node", () => {
      registry.register({ id: "remote-1", name: "worker", host: "192.168.1.100", useContainerNames: false }, mockStore);
      registry.assignContainer("c1", "remote-1");
      expect(registry.resolveUpstreamHost("c1", "wopr-alice")).toBe("192.168.1.100");
    });

    it("defaults to container name for local node ID", () => {
      registry.register({ id: LOCAL_NODE_ID, name: "local", host: "localhost" }, mockStore);
      registry.assignContainer("c1", LOCAL_NODE_ID);
      // useContainerNames defaults to true for LOCAL_NODE_ID
      expect(registry.resolveUpstreamHost("c1", "wopr-alice")).toBe("wopr-alice");
    });

    it("defaults to node host for non-local nodes", () => {
      registry.register({ id: "remote-1", name: "worker", host: "10.0.0.5" }, mockStore);
      registry.assignContainer("c1", "remote-1");
      // useContainerNames defaults to false for non-local
      expect(registry.resolveUpstreamHost("c1", "wopr-alice")).toBe("10.0.0.5");
    });

    it("falls back to container name for unknown container", () => {
      expect(registry.resolveUpstreamHost("unknown", "wopr-alice")).toBe("wopr-alice");
    });
  });

  describe("isMultiNode", () => {
    it("returns false for single node", () => {
      registry.register({ id: "n1", name: "a", host: "h1" }, mockStore);
      expect(registry.isMultiNode).toBe(false);
    });

    it("returns true for multiple nodes", () => {
      registry.register({ id: "n1", name: "a", host: "h1" }, mockStore);
      registry.register({ id: "n2", name: "b", host: "h2" }, mockStore);
      expect(registry.isMultiNode).toBe(true);
    });
  });

  describe("getFleetManager / getDocker", () => {
    it("returns fleet manager for registered node", () => {
      registry.register({ id: "n1", name: "a", host: "h1" }, mockStore);
      expect(registry.getFleetManager("n1")).toBeDefined();
    });

    it("returns docker for registered node", () => {
      registry.register({ id: "n1", name: "a", host: "h1" }, mockStore);
      expect(registry.getDocker("n1")).toBeDefined();
    });

    it("throws for unknown node", () => {
      expect(() => registry.getFleetManager("unknown")).toThrow(/Unknown node/);
      expect(() => registry.getDocker("unknown")).toThrow(/Unknown node/);
    });
  });
});
