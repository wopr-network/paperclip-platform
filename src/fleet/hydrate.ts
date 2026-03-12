/**
 * Route hydration — restore ProxyManager routes from running Docker containers.
 *
 * On platform startup, queries Docker for all containers whose name starts
 * with "wopr-" and re-registers proxy routes for running ones.
 * Containers that fail health checks are registered as unhealthy.
 */

import { checkHealth } from "@wopr-network/provision-client";
import { getConfig } from "../config.js";
import { getDocker } from "./services.js";
import { registerRoute, setRouteHealth } from "../proxy/fleet-resolver.js";
import { logger } from "../log.js";

export async function hydrateRoutes(): Promise<void> {
  const docker = getDocker();
  const config = getConfig();

  const containers = await docker.listContainers({ all: true });

  const woprContainers = containers.filter(
    (c) => c.Names?.some((n) => n.replace(/^\//, "").startsWith("wopr-")),
  );

  if (woprContainers.length === 0) {
    logger.info("Route hydration: no wopr-* containers found");
    return;
  }

  logger.info(`Route hydration: found ${woprContainers.length} wopr-* container(s)`);

  for (const container of woprContainers) {
    const name = container.Names[0].replace(/^\//, "");
    const subdomain = name.replace(/^wopr-/, "");
    const isRunning = container.State === "running";

    if (!isRunning) {
      logger.info(`Route hydration: skipping ${name} (state: ${container.State})`);
      continue;
    }

    const upstreamHost = name;
    const upstreamPort = config.PAPERCLIP_CONTAINER_PORT;
    const instanceId = container.Id;

    await registerRoute(instanceId, subdomain, upstreamHost, upstreamPort);

    // Check health and update route accordingly
    const containerUrl = `http://${upstreamHost}:${upstreamPort}`;
    const healthy = await checkHealth(containerUrl);
    if (!healthy) {
      setRouteHealth(instanceId, false);
      logger.warn(`Route hydration: ${name} registered as unhealthy`);
    } else {
      logger.info(`Route hydration: ${name} → ${containerUrl} (healthy)`);
    }
  }
}
