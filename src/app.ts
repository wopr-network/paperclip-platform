import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { AuthUser } from "@wopr-network/platform-core/auth";
import type { TRPCContext } from "@wopr-network/platform-core/trpc";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getConfig } from "./config.js";
import { logger } from "./log.js";
import { adminAuth } from "./middleware/admin-auth.js";
import { tenantProxyMiddleware } from "./proxy/tenant-proxy.js";
import { adminRoutes } from "./routes/admin.js";
import { cryptoWebhookRoutes } from "./routes/crypto-webhook.js";
import { healthRoutes } from "./routes/health.js";
import { provisionWebhookRoutes } from "./routes/provision-webhook.js";
import { appRouter } from "./trpc/index.js";

export const app = new Hono();

// Tenant subdomain proxy — catch-all for *.runpaperclip.com requests.
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
    allowHeaders: ["Content-Type", "Authorization", "x-tenant-id"],
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
app.route("/api/webhooks/crypto", cryptoWebhookRoutes);
app.use("/api/admin/*", adminAuth);
app.route("/api/admin", adminRoutes);

// ---------------------------------------------------------------------------
// tRPC — mounted at /trpc/* alongside existing routes
// ---------------------------------------------------------------------------

/**
 * Create tRPC context from an incoming request.
 * Resolves the user from better-auth session cookies.
 */
async function createTRPCContext(req: Request): Promise<TRPCContext> {
  let user: AuthUser | undefined;
  let tenantId: string | undefined;

  // Resolve user from better-auth session cookie
  try {
    const { getAuth } = await import("@wopr-network/platform-core/auth/better-auth");
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: req.headers });
    if (session?.user) {
      const sessionUser = session.user as { id: string; role?: string };
      const roles: string[] = [];
      if (sessionUser.role) roles.push(sessionUser.role);
      user = { id: sessionUser.id, roles };
      // Read x-tenant-id header for org tenant switching.
      // Default to user's personal tenant if missing or empty.
      const requestedTenantId = req.headers.get("x-tenant-id") || sessionUser.id;
      tenantId = requestedTenantId;
    }
  } catch {
    // Session resolution failed — user stays undefined
  }

  return { user, tenantId };
}

app.all("/trpc/*", async (c) => {
  const response = await fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: () => createTRPCContext(c.req.raw),
  });
  return response;
});

// Global error handler
app.onError((err, c) => {
  logger.error("Unhandled error", {
    error: err.message,
    path: c.req.path,
    method: c.req.method,
  });
  return c.json({ error: "Internal server error" }, 500);
});
