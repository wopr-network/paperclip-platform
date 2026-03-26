/**
 * Fleet route resolution — backed by platform-core's ProxyManager.
 *
 * Translates tenant subdomains to container upstream URLs using the
 * in-memory route table managed by ProxyManager. Routes are registered
 * when FleetManager creates a container and removed on teardown.
 */

import { logger } from "@wopr-network/platform-core/config/logger";
import type { ProxyManagerInterface, ProxyRoute } from "@wopr-network/platform-core/proxy/types";

let _proxy: ProxyManagerInterface | null = null;

export function setFleetResolverProxy(proxy: ProxyManagerInterface): void {
  _proxy = proxy;
}

function getProxy(): ProxyManagerInterface {
  if (!_proxy) throw new Error("Fleet resolver not initialized — call setFleetResolverProxy first");
  return _proxy;
}

/** Push route table to Caddy. Logs but does not throw on failure. */
async function syncToCaddy(): Promise<void> {
  try {
    const p = getProxy();
    await p.reload();
  } catch (err) {
    logger.warn("Caddy sync failed", { error: (err as Error).message });
  }
}

/**
 * Register a fleet container route for a tenant subdomain.
 * Called after FleetManager.create() + fleet.start().
 */
export async function registerRoute(
  instanceId: string,
  subdomain: string,
  upstreamHost: string,
  upstreamPort: number,
): Promise<void> {
  await getProxy().addRoute({
    instanceId,
    subdomain,
    upstreamHost,
    upstreamPort,
    healthy: true,
  });
  await syncToCaddy();
}

/** Remove a fleet container route. */
export async function removeRoute(instanceId: string): Promise<void> {
  getProxy().removeRoute(instanceId);
  await syncToCaddy();
}

/** Mark a container as healthy or unhealthy. */
export function setRouteHealth(instanceId: string, healthy: boolean): void {
  getProxy().updateHealth(instanceId, healthy);
}

/**
 * Resolve the upstream container URL for a tenant subdomain.
 * Returns null if no route exists or the container is unhealthy.
 */
export function resolveContainerUrl(subdomain: string): string | null {
  const routes = getProxy().getRoutes();
  const route = routes.find((r) => r.subdomain === subdomain);
  if (!route || !route.healthy) return null;
  return `http://${route.upstreamHost}:${route.upstreamPort}`;
}

/** Get all registered routes. */
export function getRoutes(): ProxyRoute[] {
  return getProxy().getRoutes();
}
