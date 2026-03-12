import { checkHealth } from "@wopr-network/provision-client";
import { Hono } from "hono";
import { getRoutes, setRouteHealth } from "../proxy/fleet-resolver.js";

/**
 * Admin routes for managing the Paperclip fleet.
 * In production these are gated by admin auth middleware.
 */
export const adminRoutes = new Hono();

/** GET /api/admin/containers — list all registered containers and their status. */
adminRoutes.get("/containers", (c) => {
  return c.json({ containers: getRoutes() });
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
