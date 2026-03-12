import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getConfig } from "./config.js";
import { logger } from "./log.js";
import { adminAuth } from "./middleware/admin-auth.js";
import { tenantProxyMiddleware } from "./proxy/tenant-proxy.js";
import { adminRoutes } from "./routes/admin.js";
import { healthRoutes } from "./routes/health.js";
import { provisionWebhookRoutes } from "./routes/provision-webhook.js";

export const app = new Hono();

// Tenant subdomain proxy — catch-all for *.runpaperclip.ai requests.
// Mounted BEFORE CORS/auth so proxied traffic goes straight to the container.
app.use("/*", tenantProxyMiddleware);

app.use(
  "/*",
  cors({
    origin: (origin) => {
      try {
        const allowed = getConfig()
          .UI_ORIGIN.split(",")
          .map((s) => s.trim());
        return allowed.includes(origin) ? origin : null;
      } catch {
        return origin === "http://localhost:3200" ? origin : null;
      }
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use("/*", secureHeaders());

// BetterAuth handler — serves /api/auth/* (signup, login, session, etc.)
// Lazily initialized to avoid DB access at import time.
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  const { getAuth } = await import("@wopr-network/platform-core/auth/better-auth");
  let req: Request;
  if (c.req.method === "POST") {
    const body = await c.req.arrayBuffer();
    req = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body,
    });
  } else {
    req = c.req.raw;
  }
  return getAuth().handler(req);
});

// Platform routes
app.route("/health", healthRoutes);
app.route("/api/provision", provisionWebhookRoutes);
app.use("/api/admin/*", adminAuth);
app.route("/api/admin", adminRoutes);

// Global error handler
app.onError((err, c) => {
  logger.error("Unhandled error", {
    error: err.message,
    path: c.req.path,
    method: c.req.method,
  });
  return c.json({ error: "Internal server error" }, 500);
});
