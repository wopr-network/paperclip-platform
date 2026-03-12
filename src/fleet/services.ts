/**
 * Fleet service singletons for paperclip-platform.
 *
 * Wraps platform-core's fleet management infrastructure:
 * - FleetManager for Docker container lifecycle
 * - ProxyManager for tenant subdomain routing
 * - ProfileStore for bot profile persistence
 *
 * All initialization is lazy — nothing runs at import time.
 */

import Docker from "dockerode";
import { FleetManager } from "@wopr-network/platform-core/fleet/fleet-manager";
import { ProfileStore } from "@wopr-network/platform-core/fleet/profile-store";
import { ProxyManager } from "@wopr-network/platform-core/proxy/manager";
import type { IOrgMemberRepository } from "@wopr-network/platform-core/tenancy/org-member-repository";
import { getConfig } from "../config.js";

let _docker: Docker | null = null;
let _store: ProfileStore | null = null;
let _fleet: FleetManager | null = null;
let _proxy: ProxyManager | null = null;
let _orgMemberRepo: IOrgMemberRepository | null = null;

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
 * FleetManager for Paperclip container lifecycle.
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
 * ProxyManager for tenant subdomain → container routing.
 *
 * In-memory route table synced to Caddy in production.
 * Routes are registered manually after FleetManager.create()
 * with the correct Paperclip container port.
 */
export function getProxyManager(): ProxyManager {
  if (!_proxy) {
    const config = getConfig();
    _proxy = new ProxyManager({ domain: config.PLATFORM_DOMAIN });
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

/** Reset all singletons — for testing only. */
export function _resetServicesForTest(): void {
  _docker = null;
  _store = null;
  _fleet = null;
  _proxy = null;
  _orgMemberRepo = null;
}
