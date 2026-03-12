/**
 * Fleet service singletons for paperclip-platform.
 *
 * Wraps platform-core's fleet management infrastructure:
 * - FleetManager for Docker container lifecycle
 * - ProxyManager for tenant subdomain routing
 * - ProfileStore for bot profile persistence
 * - NodeRegistry for multi-node Docker host management
 *
 * All initialization is lazy — nothing runs at import time.
 */

import type { IUserRoleRepository } from "@wopr-network/platform-core/auth";
import type { ICreditLedger } from "@wopr-network/platform-core/credits/credit-ledger";
import { FleetManager } from "@wopr-network/platform-core/fleet/fleet-manager";
import { ProfileStore } from "@wopr-network/platform-core/fleet/profile-store";
import type { IServiceKeyRepository } from "@wopr-network/platform-core/gateway";
import { ProxyManager } from "@wopr-network/platform-core/proxy/manager";
import type { IOrgMemberRepository } from "@wopr-network/platform-core/tenancy/org-member-repository";
import Docker from "dockerode";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { LOCAL_NODE_ID, type NodeConfig, NodeRegistry } from "./node-registry.js";
import { createPlacementStrategy, type PlacementStrategy } from "./placement.js";

let _docker: Docker | null = null;
let _store: ProfileStore | null = null;
let _fleet: FleetManager | null = null;
let _proxy: ProxyManager | null = null;
let _orgMemberRepo: IOrgMemberRepository | null = null;
let _creditLedger: ICreditLedger | null = null;
let _userRoleRepo: IUserRoleRepository | null = null;
let _nodeRegistry: NodeRegistry | null = null;
let _placementStrategy: PlacementStrategy | null = null;
let _serviceKeyRepo: IServiceKeyRepository | null = null;

export function getDocker(): Docker {
  if (!_docker) {
    _docker = new Docker();
  }
  return _docker;
}

export function getProfileStore(): ProfileStore {
  if (!_store) {
    const config = getConfig();
    _store = new ProfileStore(config.FLEET_DATA_DIR);
  }
  return _store;
}

/**
 * FleetManager for the local Docker host.
 *
 * Created WITHOUT a ProxyManager — we register proxy routes manually
 * after container creation so we can control the upstream port
 * (Paperclip uses 3100, not the default 7437).
 */
export function getFleetManager(): FleetManager {
  if (!_fleet) {
    _fleet = new FleetManager(
      getDocker(),
      getProfileStore(),
      undefined, // no platformDiscovery
      undefined, // no networkPolicy
      undefined, // no proxyManager — routes managed manually
      undefined, // no commandBus (single-node MVP)
      undefined, // no instanceRepo (billing later)
    );
  }
  return _fleet;
}

/**
 * Node registry for multi-node Docker host management.
 *
 * Initialized from FLEET_NODES env var (JSON array of NodeConfig).
 * When FLEET_NODES is empty, registers only the local Docker socket.
 */
export function getNodeRegistry(): NodeRegistry {
  if (!_nodeRegistry) {
    _nodeRegistry = new NodeRegistry();
    const config = getConfig();
    const store = getProfileStore();

    // Parse FLEET_NODES if provided
    let nodeConfigs: NodeConfig[] = [];
    if (config.FLEET_NODES) {
      try {
        nodeConfigs = JSON.parse(config.FLEET_NODES);
      } catch {
        logger.warn("Failed to parse FLEET_NODES — using local node only");
      }
    }

    if (nodeConfigs.length > 0) {
      // Multi-node mode — register all configured nodes
      for (const nodeConfig of nodeConfigs) {
        _nodeRegistry.register(nodeConfig, store);
      }
      logger.info(`Multi-node mode: ${nodeConfigs.length} node(s) registered`);
    } else {
      // Single-node mode — register local Docker socket
      _nodeRegistry.register(
        {
          id: LOCAL_NODE_ID,
          name: "local",
          host: "localhost",
          useContainerNames: true,
        },
        store,
      );
    }
  }
  return _nodeRegistry;
}

/** Placement strategy for distributing containers across nodes. */
export function getPlacementStrategy(): PlacementStrategy {
  if (!_placementStrategy) {
    const config = getConfig();
    _placementStrategy = createPlacementStrategy(config.FLEET_PLACEMENT_STRATEGY);
  }
  return _placementStrategy;
}

/**
 * ProxyManager for tenant subdomain → container routing.
 *
 * In-memory route table synced to Caddy in production.
 * Routes are registered manually after FleetManager.create()
 * with the correct Paperclip container port.
 */
export function getProxyManager(): ProxyManager {
  if (!_proxy) {
    const config = getConfig();
    _proxy = new ProxyManager({
      domain: config.PLATFORM_DOMAIN,
      caddyAdminUrl: config.CADDY_ADMIN_URL,
    });
  }
  return _proxy;
}

/**
 * IOrgMemberRepository for checking tenant membership.
 *
 * Must be set via setOrgMemberRepo() at startup when a database
 * is configured. Without it, tenant ownership checks are skipped
 * (all authenticated users can access any tenant).
 */
export function getOrgMemberRepo(): IOrgMemberRepository | null {
  return _orgMemberRepo;
}

export function setOrgMemberRepo(repo: IOrgMemberRepository): void {
  _orgMemberRepo = repo;
}

/**
 * ICreditLedger for checking tenant credit balance before provisioning.
 *
 * Must be set via setCreditLedger() at startup when a database
 * is configured. Without it, billing checks are skipped.
 */
export function getCreditLedger(): ICreditLedger | null {
  return _creditLedger;
}

export function setCreditLedger(ledger: ICreditLedger): void {
  _creditLedger = ledger;
}

/**
 * IUserRoleRepository for checking platform admin status.
 *
 * Must be set via setUserRoleRepo() at startup when a database
 * is configured. Without it, session-based admin access is unavailable
 * (only ADMIN_API_KEY works for admin routes).
 */
export function getUserRoleRepo(): IUserRoleRepository | null {
  return _userRoleRepo;
}

export function setUserRoleRepo(repo: IUserRoleRepository): void {
  _userRoleRepo = repo;
}

/**
 * IServiceKeyRepository for gateway service key management.
 *
 * Must be set via setServiceKeyRepo() at startup when the inference
 * gateway is enabled. Used by fleet operations to generate/revoke keys.
 */
export function getServiceKeyRepo(): IServiceKeyRepository | null {
  return _serviceKeyRepo;
}

export function setServiceKeyRepo(repo: IServiceKeyRepository): void {
  _serviceKeyRepo = repo;
}

/** Reset all singletons — for testing only. */
export function _resetServicesForTest(): void {
  _docker = null;
  _store = null;
  _fleet = null;
  _proxy = null;
  _orgMemberRepo = null;
  _creditLedger = null;
  _userRoleRepo = null;
  _nodeRegistry = null;
  _placementStrategy = null;
  _serviceKeyRepo = null;
}
