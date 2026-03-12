/**
 * Admin auth middleware for /api/admin/* routes.
 *
 * Supports two authentication methods:
 * 1. ADMIN_API_KEY env var — simple bearer token for automation/monitoring
 * 2. BetterAuth session + isPlatformAdmin() — for browser-based admin access
 *
 * Method 1 is always available (MVP). Method 2 requires a configured
 * IUserRoleRepository (set via setUserRoleRepo at startup).
 */

import type { Context, Next } from "hono";
import { getConfig } from "../config.js";
import { getUserRoleRepo } from "../fleet/services.js";
import { logger } from "../log.js";

/**
 * Middleware that restricts access to platform administrators.
 *
 * Checks in order:
 * 1. Bearer token matching ADMIN_API_KEY env var
 * 2. BetterAuth session with platform admin role (via IUserRoleRepository)
 *
 * Returns 401 if no auth provided, 403 if authenticated but not admin.
 */
export async function adminAuth(c: Context, next: Next) {
  const authHeader = c.req.header("authorization");

  // 1. Check ADMIN_API_KEY bearer token
  const config = getConfig();
  if (config.ADMIN_API_KEY && authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token === config.ADMIN_API_KEY) {
      return next();
    }
  }

  // 2. Check BetterAuth session + platform admin role
  try {
    const { getAuth } = await import("@wopr-network/platform-core/auth/better-auth");
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (session?.user) {
      const userId = (session.user as { id: string }).id;
      const roleRepo = getUserRoleRepo();

      if (roleRepo) {
        const isAdmin = await roleRepo.isPlatformAdmin(userId);
        if (isAdmin) {
          return next();
        }
        // Authenticated but not admin
        return c.json({ error: "Forbidden: admin access required" }, 403);
      }

      // No role repo configured — session auth alone is insufficient for admin
      logger.warn("Admin access attempted via session but no IUserRoleRepository configured");
      return c.json({ error: "Forbidden: admin access required" }, 403);
    }
  } catch {
    // BetterAuth not initialized — skip session check
  }

  // No valid auth found
  if (authHeader) {
    return c.json({ error: "Forbidden: invalid credentials" }, 403);
  }
  return c.json({ error: "Unauthorized: admin authentication required" }, 401);
}
