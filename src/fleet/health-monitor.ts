/**
 * Periodic health monitor — polls all registered Paperclip containers
 * and updates proxy route health status.
 *
 * Unhealthy containers are excluded from proxy routing until they recover.
 */

import { checkHealth } from "@wopr-network/provision-client";
import { logger } from "../log.js";
import { getRoutes, setRouteHealth } from "../proxy/fleet-resolver.js";

const DEFAULT_INTERVAL_MS = 30_000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Run one health check cycle across all registered routes.
 */
export async function runHealthChecks(): Promise<void> {
  const routes = getRoutes();
  if (routes.length === 0) return;

  for (const route of routes) {
    const url = `http://${route.upstreamHost}:${route.upstreamPort}`;
    try {
      const healthy = await checkHealth(url);
      if (healthy !== route.healthy) {
        setRouteHealth(route.instanceId, healthy);
        if (healthy) {
          logger.info(`Health restored: ${route.subdomain} (${route.instanceId})`);
        } else {
          logger.warn(`Unhealthy: ${route.subdomain} (${route.instanceId})`);
        }
      }
    } catch {
      if (route.healthy) {
        setRouteHealth(route.instanceId, false);
        logger.warn(`Health check failed: ${route.subdomain} (${route.instanceId})`);
      }
    }
  }
}

/**
 * Start the periodic health monitor.
 * No-op if already running.
 */
export function startHealthMonitor(intervalMs?: number): void {
  if (intervalHandle) return;

  const ms = intervalMs ?? (Number(process.env.HEALTH_CHECK_INTERVAL_MS) || DEFAULT_INTERVAL_MS);

  logger.info(`Health monitor started (interval: ${ms}ms)`);
  intervalHandle = setInterval(() => {
    runHealthChecks().catch((err) => {
      logger.error("Health check cycle failed", { error: (err as Error).message });
    });
  }, ms);
}

/**
 * Stop the periodic health monitor.
 */
export function stopHealthMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info("Health monitor stopped");
  }
}
