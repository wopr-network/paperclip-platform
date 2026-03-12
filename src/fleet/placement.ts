/**
 * Container placement strategies — decide which node receives new containers.
 *
 * Strategies are stateless functions that pick from available nodes based
 * on current load and capacity constraints.
 */

import type { NodeEntry } from "./node-registry.js";

export interface PlacementStrategy {
  /** Select a node for a new container. Throws if no node is available. */
  selectNode(nodes: NodeEntry[], containerCounts: Map<string, number>): NodeEntry;
}

/**
 * Least-loaded placement: pick the node with the fewest containers.
 * Respects maxContainers limits. Ties broken by registration order.
 */
export class LeastLoadedStrategy implements PlacementStrategy {
  selectNode(nodes: NodeEntry[], containerCounts: Map<string, number>): NodeEntry {
    let best: NodeEntry | null = null;
    let bestCount = Number.POSITIVE_INFINITY;

    for (const node of nodes) {
      const count = containerCounts.get(node.config.id) ?? 0;
      const max = node.config.maxContainers ?? 0;

      // Skip nodes at capacity (0 = unlimited)
      if (max > 0 && count >= max) continue;

      if (count < bestCount) {
        best = node;
        bestCount = count;
      }
    }

    if (!best) {
      throw new Error("No available nodes: all nodes are at capacity");
    }

    return best;
  }
}

/**
 * Round-robin placement: distribute containers evenly across nodes.
 * Respects maxContainers limits. Stateful — tracks last-used index.
 */
export class RoundRobinStrategy implements PlacementStrategy {
  private lastIndex = -1;

  selectNode(nodes: NodeEntry[], containerCounts: Map<string, number>): NodeEntry {
    const available = nodes.filter((node) => {
      const count = containerCounts.get(node.config.id) ?? 0;
      const max = node.config.maxContainers ?? 0;
      return max === 0 || count < max;
    });

    if (available.length === 0) {
      throw new Error("No available nodes: all nodes are at capacity");
    }

    this.lastIndex = (this.lastIndex + 1) % available.length;
    return available[this.lastIndex];
  }
}

/** Create a placement strategy by name. */
export function createPlacementStrategy(name: string): PlacementStrategy {
  switch (name) {
    case "round-robin":
      return new RoundRobinStrategy();
    default:
      return new LeastLoadedStrategy();
  }
}
