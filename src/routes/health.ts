import { Hono } from "hono";
import { getRoutes } from "../proxy/fleet-resolver.js";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  const routes = getRoutes();
  const healthy = routes.filter((r) => r.healthy).length;
  return c.json({
    ok: true,
    service: "paperclip-platform",
    containers: {
      total: routes.length,
      healthy,
    },
  });
});
