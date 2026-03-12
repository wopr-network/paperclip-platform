import { describe, expect, it } from "vitest";
import type { NodeEntry } from "../fleet/node-registry.js";
import { createPlacementStrategy, LeastLoadedStrategy, RoundRobinStrategy } from "../fleet/placement.js";

/** Create a minimal NodeEntry for testing. */
function makeNode(id: string, maxContainers?: number): NodeEntry {
  return {
    config: { id, name: `node-${id}`, host: `host-${id}`, maxContainers },
    docker: {} as any,
    fleet: {} as any,
  };
}

describe("LeastLoadedStrategy", () => {
  const strategy = new LeastLoadedStrategy();

  it("selects the node with fewest containers", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const counts = new Map([
      ["a", 5],
      ["b", 2],
      ["c", 3],
    ]);
    const selected = strategy.selectNode(nodes, counts);
    expect(selected.config.id).toBe("b");
  });

  it("selects first node when all empty", () => {
    const nodes = [makeNode("a"), makeNode("b")];
    const counts = new Map([
      ["a", 0],
      ["b", 0],
    ]);
    const selected = strategy.selectNode(nodes, counts);
    expect(selected.config.id).toBe("a");
  });

  it("skips nodes at capacity", () => {
    const nodes = [makeNode("a", 2), makeNode("b", 10), makeNode("c", 5)];
    const counts = new Map([
      ["a", 2], // at capacity
      ["b", 3],
      ["c", 5], // at capacity
    ]);
    const selected = strategy.selectNode(nodes, counts);
    expect(selected.config.id).toBe("b");
  });

  it("treats maxContainers=0 as unlimited", () => {
    const nodes = [makeNode("a", 0), makeNode("b", 2)];
    const counts = new Map([
      ["a", 100],
      ["b", 1],
    ]);
    // b has fewer, so b is selected
    const selected = strategy.selectNode(nodes, counts);
    expect(selected.config.id).toBe("b");
  });

  it("throws when all nodes at capacity", () => {
    const nodes = [makeNode("a", 2), makeNode("b", 3)];
    const counts = new Map([
      ["a", 2],
      ["b", 3],
    ]);
    expect(() => strategy.selectNode(nodes, counts)).toThrow(/No available nodes/);
  });

  it("handles nodes with no count entry", () => {
    const nodes = [makeNode("a"), makeNode("b")];
    const counts = new Map([["a", 5]]);
    // b has 0 (no entry), so b is selected
    const selected = strategy.selectNode(nodes, counts);
    expect(selected.config.id).toBe("b");
  });

  it("handles single node", () => {
    const nodes = [makeNode("a")];
    const counts = new Map([["a", 0]]);
    const selected = strategy.selectNode(nodes, counts);
    expect(selected.config.id).toBe("a");
  });
});

describe("RoundRobinStrategy", () => {
  it("cycles through nodes in order", () => {
    const strategy = new RoundRobinStrategy();
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const counts = new Map([
      ["a", 0],
      ["b", 0],
      ["c", 0],
    ]);

    expect(strategy.selectNode(nodes, counts).config.id).toBe("a");
    expect(strategy.selectNode(nodes, counts).config.id).toBe("b");
    expect(strategy.selectNode(nodes, counts).config.id).toBe("c");
    expect(strategy.selectNode(nodes, counts).config.id).toBe("a");
  });

  it("skips nodes at capacity", () => {
    const strategy = new RoundRobinStrategy();
    const nodes = [makeNode("a", 1), makeNode("b"), makeNode("c", 1)];
    const counts = new Map([
      ["a", 1], // at capacity
      ["b", 0],
      ["c", 1], // at capacity
    ]);

    // Only b is available
    expect(strategy.selectNode(nodes, counts).config.id).toBe("b");
    expect(strategy.selectNode(nodes, counts).config.id).toBe("b");
  });

  it("throws when all nodes at capacity", () => {
    const strategy = new RoundRobinStrategy();
    const nodes = [makeNode("a", 1), makeNode("b", 1)];
    const counts = new Map([
      ["a", 1],
      ["b", 1],
    ]);
    expect(() => strategy.selectNode(nodes, counts)).toThrow(/No available nodes/);
  });
});

describe("createPlacementStrategy", () => {
  it("creates least-loaded by default", () => {
    const strategy = createPlacementStrategy("least-loaded");
    expect(strategy).toBeInstanceOf(LeastLoadedStrategy);
  });

  it("creates round-robin", () => {
    const strategy = createPlacementStrategy("round-robin");
    expect(strategy).toBeInstanceOf(RoundRobinStrategy);
  });

  it("defaults to least-loaded for unknown names", () => {
    const strategy = createPlacementStrategy("unknown");
    expect(strategy).toBeInstanceOf(LeastLoadedStrategy);
  });
});
