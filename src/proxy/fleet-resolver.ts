/**
 * Fleet route resolution — backed by platform-core's ProxyManager.
 *
 * Translates tenant subdomains to container upstream URLs using the
 * in-memory route table managed by ProxyManager. Routes are registered
 * when FleetManager creates a container and removed on teardown.
 */

import type { ProxyRoute } from "@wopr-network/platform-core/proxy/types";
import { getProxyManager } from "../fleet/services.js";

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
  await getProxyManager().addRoute({
    instanceId,
    subdomain,
    upstreamHost,
    upstreamPort,
    healthy: true,
  });
}

/** Remove a fleet container route. */
export function removeRoute(instanceId: string): void {
  getProxyManager().removeRoute(instanceId);
}

/** Mark a container as healthy or unhealthy. */
export function setRouteHealth(instanceId: string, healthy: boolean): void {
  getProxyManager().updateHealth(instanceId, healthy);
}

/**
 * Resolve the upstream container URL for a tenant subdomain.
 * Returns null if no route exists or the container is unhealthy.
 */
export function resolveContainerUrl(subdomain: string): string | null {
  const routes = getProxyManager().getRoutes();
  const route = routes.find((r) => r.subdomain === subdomain);
  if (!route || !route.healthy) return null;
  return `http://${route.upstreamHost}:${route.upstreamPort}`;
}

/** Get all registered routes. */
export function getRoutes(): ProxyRoute[] {
  return getProxyManager().getRoutes();
}
