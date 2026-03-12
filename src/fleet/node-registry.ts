/**
 * Node registry — tracks Docker hosts available for container placement.
 *
 * Each node has its own Dockerode connection and FleetManager instance.
 * The registry tracks which containers live on which nodes to route
 * lifecycle operations (start/stop/remove) to the correct host.
 *
 * Single-node deployments use a single "local" node (backwards compatible).
 */

import { FleetManager } from "@wopr-network/platform-core/fleet/fleet-manager";
import type { IProfileStore } from "@wopr-network/platform-core/fleet/profile-store";
import Docker from "dockerode";
import { logger } from "../log.js";

export interface NodeConfig {
  /** Unique node identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /**
   * Hostname or IP used to reach containers on this node.
   * For local nodes, container names are used instead (Docker DNS).
   * For remote nodes, this is the address the proxy routes traffic to.
   */
  host: string;
  /**
   * Docker API URL. Omit for local socket (/var/run/docker.sock).
   * For remote: "tcp://host:2376" or "ssh://user@host".
   */
  dockerUrl?: string;
  /** Maximum containers this node should host. 0 = unlimited. */
  maxContainers?: number;
  /**
   * Whether this node uses Docker DNS for container routing.
   * When true, upstream host = container name (e.g., "wopr-alice").
   * When false, upstream host = node.host (requires published ports or overlay network).
   * Defaults to true for the local node, false for remote nodes.
   */
  useContainerNames?: boolean;
}

export interface NodeEntry {
  config: NodeConfig;
  docker: Docker;
  fleet: FleetManager;
}

/** Sentinel node ID for the default local Docker host. */
export const LOCAL_NODE_ID = "local";

export class NodeRegistry {
  private nodes = new Map<string, NodeEntry>();
  private containerNodeMap = new Map<string, string>();

  /**
   * Register a Docker host node.
   * Creates a Dockerode instance and FleetManager for the node.
   */
  register(config: NodeConfig, store: IProfileStore): void {
    if (this.nodes.has(config.id)) {
      throw new Error(`Node already registered: ${config.id}`);
    }

    const docker = config.dockerUrl
      ? new Docker({ host: new URL(config.dockerUrl).hostname, port: Number(new URL(config.dockerUrl).port) || 2376 })
      : new Docker();

    const fleet = new FleetManager(
      docker,
      store,
      undefined, // no platformDiscovery
      undefined, // no networkPolicy
      undefined, // no proxyManager — routes managed separately
      undefined, // no commandBus
      undefined, // no instanceRepo
    );

    this.nodes.set(config.id, { config, docker, fleet });
    logger.info(`Registered node: ${config.name} (${config.id})`, {
      host: config.host,
      dockerUrl: config.dockerUrl ?? "local socket",
      maxContainers: config.maxContainers ?? "unlimited",
    });
  }

  /** Unregister a node. Fails if containers are still assigned to it. */
  unregister(nodeId: string): void {
    const assigned = this.getContainersOnNode(nodeId);
    if (assigned.length > 0) {
      throw new Error(`Cannot unregister node ${nodeId}: ${assigned.length} containers still assigned`);
    }
    this.nodes.delete(nodeId);
  }

  /** List all registered nodes. */
  list(): NodeEntry[] {
    return Array.from(this.nodes.values());
  }

  /** Get a specific node. */
  get(nodeId: string): NodeEntry | undefined {
    return this.nodes.get(nodeId);
  }

  /** Get Docker client for a node. */
  getDocker(nodeId: string): Docker {
    const entry = this.nodes.get(nodeId);
    if (!entry) throw new Error(`Unknown node: ${nodeId}`);
    return entry.docker;
  }

  /** Get FleetManager for a node. */
  getFleetManager(nodeId: string): FleetManager {
    const entry = this.nodes.get(nodeId);
    if (!entry) throw new Error(`Unknown node: ${nodeId}`);
    return entry.fleet;
  }

  /** Track which node a container lives on. */
  assignContainer(containerId: string, nodeId: string): void {
    this.containerNodeMap.set(containerId, nodeId);
  }

  /** Remove container-to-node mapping. */
  unassignContainer(containerId: string): void {
    this.containerNodeMap.delete(containerId);
  }

  /** Look up which node a container is on. */
  getContainerNode(containerId: string): string | undefined {
    return this.containerNodeMap.get(containerId);
  }

  /** List containers assigned to a specific node. */
  getContainersOnNode(nodeId: string): string[] {
    const result: string[] = [];
    for (const [containerId, nId] of this.containerNodeMap) {
      if (nId === nodeId) result.push(containerId);
    }
    return result;
  }

  /** Get container counts per node (for placement decisions). */
  getContainerCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    // Initialize all nodes with 0
    for (const nodeId of this.nodes.keys()) {
      counts.set(nodeId, 0);
    }
    // Count assignments
    for (const nodeId of this.containerNodeMap.values()) {
      counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
    }
    return counts;
  }

  /** Whether the registry has more than one node. */
  get isMultiNode(): boolean {
    return this.nodes.size > 1;
  }

  /** Number of registered nodes. */
  get size(): number {
    return this.nodes.size;
  }

  /**
   * Resolve the upstream host for a container.
   * Local/overlay nodes use the container name; remote nodes use the node host.
   */
  resolveUpstreamHost(containerId: string, containerName: string): string {
    const nodeId = this.containerNodeMap.get(containerId);
    if (!nodeId) return containerName; // fallback to container name

    const entry = this.nodes.get(nodeId);
    if (!entry) return containerName;

    // Use container names for local node or when explicitly configured
    const useContainerNames = entry.config.useContainerNames ?? nodeId === LOCAL_NODE_ID;
    return useContainerNames ? containerName : entry.config.host;
  }
}
