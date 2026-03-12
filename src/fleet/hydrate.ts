/**
 * Route hydration — restore ProxyManager routes from running Docker containers.
 *
 * On platform startup, queries Docker on all registered nodes for containers
 * whose name starts with "wopr-" and re-registers proxy routes for running ones.
 * Containers that fail health checks are registered as unhealthy.
 */

import { checkHealth } from "@wopr-network/provision-client";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { registerRoute, setRouteHealth } from "../proxy/fleet-resolver.js";
import { getNodeRegistry } from "./services.js";

export async function hydrateRoutes(): Promise<void> {
  const config = getConfig();
  const registry = getNodeRegistry();
  const nodes = registry.list();

  let totalFound = 0;

  for (const node of nodes) {
    try {
      const containers = await node.docker.listContainers({ all: true });
      const woprContainers = containers.filter((c) => c.Names?.some((n) => n.replace(/^\//, "").startsWith("wopr-")));

      if (woprContainers.length === 0) {
        logger.info(`Route hydration [${node.config.name}]: no wopr-* containers found`);
        continue;
      }

      logger.info(`Route hydration [${node.config.name}]: found ${woprContainers.length} wopr-* container(s)`);
      totalFound += woprContainers.length;

      for (const container of woprContainers) {
        const name = container.Names[0].replace(/^\//, "");
        const subdomain = name.replace(/^wopr-/, "");
        const isRunning = container.State === "running";

        if (!isRunning) {
          logger.info(`Route hydration [${node.config.name}]: skipping ${name} (state: ${container.State})`);
          continue;
        }

        const instanceId = container.Id;
        const upstreamHost = registry.resolveUpstreamHost(instanceId, name);
        const upstreamPort = config.PAPERCLIP_CONTAINER_PORT;

        // Track container → node assignment
        registry.assignContainer(instanceId, node.config.id);

        await registerRoute(instanceId, subdomain, upstreamHost, upstreamPort);

        // Check health and update route accordingly
        const containerUrl = `http://${upstreamHost}:${upstreamPort}`;
        const healthy = await checkHealth(containerUrl);
        if (!healthy) {
          setRouteHealth(instanceId, false);
          logger.warn(`Route hydration [${node.config.name}]: ${name} registered as unhealthy`);
        } else {
          logger.info(`Route hydration [${node.config.name}]: ${name} → ${containerUrl} (healthy)`);
        }
      }
    } catch (err) {
      logger.error(`Route hydration failed for node ${node.config.name}`, {
        error: (err as Error).message,
      });
    }
  }

  if (totalFound === 0) {
    logger.info("Route hydration: no wopr-* containers found across any node");
  }
}
