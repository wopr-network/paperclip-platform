/**
 * Product-level container accessor.
 *
 * Holds a reference to the PlatformContainer built by bootPlatformServer().
 * Product-specific modules (tRPC routers, fleet helpers) import from here
 * instead of the old fleet/services.ts / config.ts / db/index.ts singletons.
 */

import { logger } from "@wopr-network/platform-core/config/logger";
import type { PlatformContainer } from "@wopr-network/platform-core/server";
import type { Pool } from "pg";
import { LOCAL_NODE_ID, type NodeConfig, NodeRegistry } from "./fleet/node-registry.js";
import { createPlacementStrategy, type PlacementStrategy } from "./fleet/placement.js";

let _container: PlatformContainer | null = null;
let _nodeRegistry: NodeRegistry | null = null;
let _placementStrategy: PlacementStrategy | null = null;

/** Called once from index.ts after bootPlatformServer() returns. */
export function setContainer(c: PlatformContainer): void {
  _container = c;
  _nodeRegistry = null;
  _placementStrategy = null;
}

export function getContainer(): PlatformContainer {
  if (!_container) throw new Error("PlatformContainer not initialized");
  return _container;
}

// ---------------------------------------------------------------------------
// Convenience accessors — drop-in replacements for the deleted singletons
// ---------------------------------------------------------------------------

export function getDb() {
  return getContainer().db;
}

export function getPool(): Pool {
  return getContainer().pool;
}

export function getCreditLedger() {
  return getContainer().creditLedger;
}

export function getOrgMemberRepo() {
  return getContainer().orgMemberRepo;
}

export function getUserRoleRepo() {
  return getContainer().userRoleRepo;
}

export function getOrgService() {
  return getContainer().orgService;
}

// Fleet accessors — null-safe (fleet may be disabled)
export function getDocker() {
  const fleet = getContainer().fleet;
  if (!fleet) throw new Error("Fleet services not enabled");
  return fleet.docker;
}

export function getFleetManager() {
  const fleet = getContainer().fleet;
  if (!fleet) throw new Error("Fleet services not enabled");
  return fleet.manager;
}

export function getProxyManager() {
  const fleet = getContainer().fleet;
  if (!fleet) throw new Error("Fleet services not enabled");
  return fleet.proxy;
}

export function getProfileStore() {
  const fleet = getContainer().fleet;
  if (!fleet) throw new Error("Fleet services not enabled");
  return fleet.profileStore;
}

export function getServiceKeyRepo() {
  const fleet = getContainer().fleet;
  if (!fleet) return null;
  return fleet.serviceKeyRepo;
}

// ---------------------------------------------------------------------------
// Product-specific fleet singletons (NodeRegistry, PlacementStrategy)
// ---------------------------------------------------------------------------

/**
 * Node registry for multi-node Docker host management.
 * Initialized from FLEET_NODES env var (JSON array of NodeConfig).
 * When FLEET_NODES is empty, registers only the local Docker socket.
 */
export function getNodeRegistry(): NodeRegistry {
  if (!_nodeRegistry) {
    _nodeRegistry = new NodeRegistry();
    const store = getProfileStore();

    let nodeConfigs: NodeConfig[] = [];
    const fleetNodesEnv = process.env.FLEET_NODES ?? "";
    if (fleetNodesEnv) {
      try {
        nodeConfigs = JSON.parse(fleetNodesEnv);
      } catch {
        logger.warn("Failed to parse FLEET_NODES — using local node only");
      }
    }

    if (nodeConfigs.length > 0) {
      for (const nodeConfig of nodeConfigs) {
        _nodeRegistry.register(nodeConfig, store);
      }
      logger.info(`Multi-node mode: ${nodeConfigs.length} node(s) registered`);
    } else {
      _nodeRegistry.register({ id: LOCAL_NODE_ID, name: "local", host: "localhost", useContainerNames: true }, store);
    }
  }
  return _nodeRegistry;
}

/** Placement strategy for distributing containers across nodes. */
export function getPlacementStrategy(): PlacementStrategy {
  if (!_placementStrategy) {
    _placementStrategy = createPlacementStrategy(process.env.FLEET_PLACEMENT_STRATEGY ?? "least-loaded");
  }
  return _placementStrategy;
}

// Product config
export function getProductConfig() {
  return getContainer().productConfig;
}
