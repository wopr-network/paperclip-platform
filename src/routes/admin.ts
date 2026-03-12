import { checkHealth } from "@wopr-network/provision-client";
import { Hono } from "hono";
import { getNodeRegistry } from "../fleet/services.js";
import { getRoutes, setRouteHealth } from "../proxy/fleet-resolver.js";

/**
 * Admin routes for managing the Paperclip fleet.
 * In production these are gated by admin auth middleware.
 */
export const adminRoutes = new Hono();

/** GET /api/admin/containers — list all registered containers and their status. */
adminRoutes.get("/containers", (c) => {
  const registry = getNodeRegistry();
  const routes = getRoutes();

  // Enrich routes with node info
  const containers = routes.map((route) => ({
    ...route,
    nodeId: registry.getContainerNode(route.instanceId) ?? null,
  }));

  return c.json({ containers });
});

/** POST /api/admin/containers/:instanceId/health-check — trigger a health check. */
adminRoutes.post("/containers/:instanceId/health-check", async (c) => {
  const instanceId = c.req.param("instanceId");
  const routes = getRoutes();
  const route = routes.find((r) => r.instanceId === instanceId);

  if (!route) {
    return c.json({ error: "Container not found" }, 404);
  }

  const containerUrl = `http://${route.upstreamHost}:${route.upstreamPort}`;
  const healthy = await checkHealth(containerUrl);
  setRouteHealth(instanceId, healthy);

  return c.json({ instanceId, healthy, containerUrl });
});

/** GET /api/admin/nodes — list all registered Docker host nodes. */
adminRoutes.get("/nodes", (c) => {
  const registry = getNodeRegistry();
  const nodes = registry.list();
  const containerCounts = registry.getContainerCounts();

  const result = nodes.map((node) => ({
    id: node.config.id,
    name: node.config.name,
    host: node.config.host,
    maxContainers: node.config.maxContainers ?? 0,
    containerCount: containerCounts.get(node.config.id) ?? 0,
    containers: registry.getContainersOnNode(node.config.id),
  }));

  return c.json({ nodes: result, multiNode: registry.isMultiNode });
});
