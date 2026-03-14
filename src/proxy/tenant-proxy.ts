import { validateTenantAccess } from "@wopr-network/platform-core/auth";
import type { MiddlewareHandler } from "hono";
import { getConfig } from "../config.js";
import { getOrgMemberRepo, getProfileStore } from "../fleet/services.js";
import { logger } from "../log.js";
import { resolveContainerUrl } from "./fleet-resolver.js";

/** Reserved subdomains that should never resolve to a tenant. */
const RESERVED_SUBDOMAINS = new Set(["app", "api", "staging", "www", "mail", "admin", "dashboard", "status", "docs"]);

/** DNS label rules (RFC 1123). */
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Headers safe to forward to upstream Paperclip containers. */
const FORWARDED_HEADERS = [
  "content-type",
  "accept",
  "accept-language",
  "accept-encoding",
  "content-length",
  "x-request-id",
  "user-agent",
  "origin",
  "referer",
  "cookie",
];

/**
 * Extract the tenant subdomain from a Host header value.
 *
 * "alice.runpaperclip.com" → "alice"
 * "runpaperclip.com"       → null (root domain)
 * "app.runpaperclip.com"   → null (reserved)
 */
export function extractTenantSubdomain(host: string): string | null {
  const hostname = host.split(":")[0].toLowerCase();
  const domain = getConfig().PLATFORM_DOMAIN;
  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) return null;

  const subdomain = hostname.slice(0, -suffix.length);
  if (!subdomain || subdomain.includes(".")) return null;
  if (RESERVED_SUBDOMAINS.has(subdomain)) return null;
  if (!SUBDOMAIN_RE.test(subdomain)) return null;

  return subdomain;
}

/** Build sanitized headers for upstream requests. */
export function buildUpstreamHeaders(incoming: Headers, userId: string, tenantSubdomain: string): Headers {
  const headers = new Headers();
  for (const key of FORWARDED_HEADERS) {
    const val = incoming.get(key);
    if (val) headers.set(key, val);
  }
  // Forward original Host so Paperclip's hostname allowlist doesn't reject the request
  const host = incoming.get("host");
  if (host) headers.set("host", host);
  headers.set("x-paperclip-user-id", userId);
  headers.set("x-paperclip-tenant", tenantSubdomain);
  return headers;
}

/**
 * Resolve the authenticated user ID from the Hono context.
 * Falls back to BetterAuth session cookie resolution.
 */
async function resolveUserId(c: Parameters<MiddlewareHandler>[0]): Promise<string | undefined> {
  try {
    const contextUser = (c.get("user") as { id: string } | undefined)?.id;
    if (contextUser) return contextUser;
  } catch {
    // Variable not set — fall through
  }

  try {
    const { getAuth } = await import("@wopr-network/platform-core/auth/better-auth");
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user) return (session.user as { id: string }).id;
  } catch (err) {
    logger.warn("Session resolution failed for tenant proxy request", { err });
  }
  return undefined;
}

/**
 * Tenant subdomain proxy middleware.
 *
 * If the request Host identifies a tenant subdomain (e.g. alice.runpaperclip.com),
 * authenticates the user, resolves the fleet container URL, and proxies the request.
 *
 * If the host is absent, the root domain, or a reserved subdomain,
 * the middleware calls next() so the platform routes handle it.
 */
export const tenantProxyMiddleware: MiddlewareHandler = async (c, next) => {
  const host = c.req.header("host");
  if (!host) return next();

  const subdomain = extractTenantSubdomain(host);
  if (!subdomain) return next();

  // Authenticate — reject unauthenticated requests
  const userId = await resolveUserId(c);
  if (!userId) {
    return c.json({ error: "Authentication required" }, 401);
  }

  // Verify tenant ownership — user must belong to the org that owns this subdomain
  const orgMemberRepo = getOrgMemberRepo();
  if (orgMemberRepo) {
    const store = getProfileStore();
    const profiles = await store.list();
    const profile = profiles.find((p) => p.name === subdomain);
    if (profile) {
      const hasAccess = await validateTenantAccess(userId, profile.tenantId, orgMemberRepo);
      if (!hasAccess) {
        return c.json({ error: "Forbidden: not a member of this tenant" }, 403);
      }
    }
  }

  // Resolve fleet container URL via ProxyManager-backed route table
  const upstream = resolveContainerUrl(subdomain);
  if (!upstream) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  const url = new URL(c.req.url);
  const targetUrl = `${upstream}${url.pathname}${url.search}`;
  const upstreamHeaders = buildUpstreamHeaders(c.req.raw.headers, userId, subdomain);

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method: c.req.method,
      headers: upstreamHeaders,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
      // @ts-expect-error duplex needed for streaming request bodies
      duplex: "half",
    });
  } catch (err) {
    logger.warn(`Upstream fetch failed for subdomain "${subdomain}"`, { err });
    return c.json({ error: "Bad Gateway: Paperclip container unavailable" }, 502);
  }

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
};
