/**
 * tRPC admin router — platform-wide settings for the operator.
 *
 * All endpoints require platform_admin role (via adminProcedure).
 */

import type { ILedger } from "@wopr-network/platform-core/credits";
import type { DrizzleDb } from "@wopr-network/platform-core/db";
import type { IProfileStore } from "@wopr-network/platform-core/fleet/profile-store";
import type { IServiceKeyRepository } from "@wopr-network/platform-core/gateway/service-key-repository";
import { adminProcedure, router } from "@wopr-network/platform-core/trpc";
import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { z } from "zod";
import type { NodeRegistry } from "../../fleet/node-registry.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AdminRouterDeps {
  db: DrizzleDb;
  pool: Pool;
  creditLedger: ILedger;
  profileStore: IProfileStore;
  nodeRegistry: NodeRegistry;
  serviceKeyRepo: IServiceKeyRepository | null;
}

let _deps: AdminRouterDeps | null = null;

export function setAdminRouterDeps(deps: AdminRouterDeps): void {
  _deps = deps;
}

function deps(): AdminRouterDeps {
  if (!_deps) throw new Error("admin router not initialized");
  return _deps;
}

// OpenRouter model list cache
type CachedModel = { id: string; name: string; contextLength: number; promptPrice: string; completionPrice: string };
let modelListCache: CachedModel[] | null = null;
let modelListCacheExpiry = 0;

/** Inline table ref — matches platform-core schema/tenant-model-selection.ts */
const tenantModelSelection = pgTable("tenant_model_selection", {
  tenantId: text("tenant_id").primaryKey(),
  defaultModel: text("default_model").notNull().default("openrouter/auto"),
  updatedAt: text("updated_at")
    .notNull()
    .$default(() => new Date().toISOString()),
});

/** Well-known tenant ID for the global platform model setting. */
const GLOBAL_TENANT_ID = "__platform__";

// ---------------------------------------------------------------------------
// Cached model resolver — called per-request by the gateway proxy.
// Reads from tenant_model_selection with a short TTL so admin changes
// take effect within seconds, not on restart.
// ---------------------------------------------------------------------------

let cachedModel: string | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5_000;

/**
 * Synchronous model resolver for the gateway proxy.
 * Returns the cached DB value, or null to fall back to env var.
 * The cache is refreshed asynchronously every 5 seconds.
 */
export function resolveGatewayModel(): string | null {
  const now = Date.now();
  if (now > cacheExpiry) {
    // Refresh cache in the background — don't block the request
    refreshModelCache().catch(() => {});
  }
  return cachedModel;
}

async function refreshModelCache(): Promise<void> {
  if (!_deps) return;
  try {
    const row = await _deps.db
      .select({ defaultModel: tenantModelSelection.defaultModel })
      .from(tenantModelSelection)
      .where(eq(tenantModelSelection.tenantId, GLOBAL_TENANT_ID))
      .then((rows) => rows[0] ?? null);
    cachedModel = row?.defaultModel ?? null;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
  } catch {
    // DB error — keep stale cache, retry next time
  }
}

/** Seed the cache on startup so the first request doesn't miss. */
export async function warmModelCache(): Promise<void> {
  await refreshModelCache();
}

// ---------------------------------------------------------------------------
// tRPC admin router
// ---------------------------------------------------------------------------

export const adminRouter = router({
  /** Get the current gateway model setting. */
  getGatewayModel: adminProcedure.query(async () => {
    const d = deps().db;
    const row = await d
      .select({ defaultModel: tenantModelSelection.defaultModel, updatedAt: tenantModelSelection.updatedAt })
      .from(tenantModelSelection)
      .where(eq(tenantModelSelection.tenantId, GLOBAL_TENANT_ID))
      .then((rows) => rows[0] ?? null);
    return {
      model: row?.defaultModel ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }),

  /** Set the gateway model. Takes effect within 5 seconds. */
  setGatewayModel: adminProcedure.input(z.object({ model: z.string().min(1).max(200) })).mutation(async ({ input }) => {
    const d = deps().db;
    const now = new Date().toISOString();
    await d
      .insert(tenantModelSelection)
      .values({
        tenantId: GLOBAL_TENANT_ID,
        defaultModel: input.model,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tenantModelSelection.tenantId,
        set: { defaultModel: input.model, updatedAt: now },
      });
    // Immediately update the cache so the next gateway request uses the new model.
    cachedModel = input.model;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return { ok: true, model: input.model };
  }),

  /** List available OpenRouter models for the gateway model dropdown. */
  listAvailableModels: adminProcedure.query(async () => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return { models: [] };

    // Cache for 60s to avoid hammering OpenRouter
    const now = Date.now();
    if (modelListCache && modelListCacheExpiry > now) return { models: modelListCache };

    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { models: modelListCache ?? [] };
      const json = (await res.json()) as {
        data: Array<{
          id: string;
          name: string;
          context_length?: number;
          pricing?: { prompt?: string; completion?: string };
        }>;
      };
      const models = json.data
        .map((m) => ({
          id: m.id,
          name: m.name,
          contextLength: m.context_length ?? 0,
          promptPrice: m.pricing?.prompt ?? "0",
          completionPrice: m.pricing?.completion ?? "0",
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      modelListCache = models;
      modelListCacheExpiry = now + 60_000;
      return { models };
    } catch {
      return { models: modelListCache ?? [] };
    }
  }),

  // -------------------------------------------------------------------------
  // Platform-wide instance overview (all tenants)
  // -------------------------------------------------------------------------

  /** List ALL instances across all tenants with health status. */
  listAllInstances: adminProcedure.query(async () => {
    const store = deps().profileStore;
    const profiles = await store.list();
    const registry = deps().nodeRegistry;

    const instances = await Promise.all(
      profiles.map(async (profile) => {
        try {
          const nodeId = registry.getContainerNode(profile.id);
          const fleet = nodeId ? registry.getFleetManager(nodeId) : registry.list()[0].fleet;
          const status = await fleet.status(profile.id);
          return {
            id: profile.id,
            name: profile.name,
            tenantId: profile.tenantId,
            image: profile.image,
            state: status.state,
            health: status.health,
            uptime: status.uptime,
            containerId: status.containerId ?? null,
            startedAt: status.startedAt ?? null,
          };
        } catch {
          return {
            id: profile.id,
            name: profile.name,
            tenantId: profile.tenantId,
            image: profile.image,
            state: "error" as const,
            health: null,
            uptime: null,
            containerId: null,
            startedAt: null,
          };
        }
      }),
    );

    return { instances };
  }),

  // -------------------------------------------------------------------------
  // Platform-wide tenant/org overview
  // -------------------------------------------------------------------------

  /** List all organizations with member counts and instance counts. */
  listAllOrgs: adminProcedure.query(async () => {
    // Query orgs with member counts
    const pool = deps().pool;
    const orgs = await pool.query<{
      id: string;
      name: string;
      slug: string | null;
      createdAt: string;
      memberCount: string;
    }>(`
      SELECT
        o.id,
        o.name,
        o.slug,
        o.created_at as "createdAt",
        (SELECT COUNT(*) FROM org_member om WHERE om.org_id = o.id) as "memberCount"
      FROM organization o
      ORDER BY o.created_at DESC
    `);

    // Count instances per tenant from fleet profiles
    const store = deps().profileStore;
    const profiles = await store.list();
    const instanceCountByTenant = new Map<string, number>();
    for (const p of profiles) {
      instanceCountByTenant.set(p.tenantId, (instanceCountByTenant.get(p.tenantId) ?? 0) + 1);
    }

    // Get credit balances per org
    const ledger = deps().creditLedger;

    const result = await Promise.all(
      orgs.rows.map(async (org) => {
        let balanceCents = 0;
        if (ledger) {
          try {
            const balance = await ledger.balance(org.id);
            balanceCents = balance.toCentsRounded();
          } catch {
            // Ledger may not have an entry for this org
          }
        }
        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          createdAt: org.createdAt,
          memberCount: Number(org.memberCount),
          instanceCount: instanceCountByTenant.get(org.id) ?? 0,
          balanceCents,
        };
      }),
    );

    return { orgs: result };
  }),

  // -------------------------------------------------------------------------
  // Platform-wide billing summary
  // -------------------------------------------------------------------------

  /** Get platform billing summary: total credits, active service keys, payment method count. */
  billingOverview: adminProcedure.query(async () => {
    const pool = deps().pool;

    // Total credit balance across all tenants
    let totalBalanceCents = 0;
    const ledger = deps().creditLedger;
    if (ledger) {
      try {
        const balanceResult = await pool.query<{ totalRaw: string }>(`
          SELECT COALESCE(SUM(amount), 0) as "totalRaw"
          FROM credit_entry
        `);
        const rawTotal = Number(balanceResult.rows[0]?.totalRaw ?? 0);
        // credit_entry.amount is in microdollars (10^-6), convert to cents
        totalBalanceCents = Math.round(rawTotal / 10_000);
      } catch {
        // Table may not exist yet
      }
    }

    // Count active service keys (proxy for active subscriptions)
    let activeKeyCount = 0;
    const keyRepo = deps().serviceKeyRepo;
    if (keyRepo) {
      try {
        const keyResult = await pool.query<{ count: string }>(
          `SELECT COUNT(*) as "count" FROM service_keys WHERE revoked_at IS NULL`,
        );
        activeKeyCount = Number(keyResult.rows[0]?.count ?? 0);
      } catch {
        // Service key repo may not support listAll
      }
    }

    // Count payment methods across all tenants
    let paymentMethodCount = 0;
    try {
      const pmResult = await pool.query<{ count: string }>(`
        SELECT COUNT(*) as "count" FROM payment_methods WHERE enabled = true
      `);
      paymentMethodCount = Number(pmResult.rows[0]?.count ?? 0);
    } catch {
      // Table may not exist
    }

    // Count total orgs
    let orgCount = 0;
    try {
      const orgCountResult = await pool.query<{ count: string }>(`SELECT COUNT(*) as "count" FROM organization`);
      orgCount = Number(orgCountResult.rows[0]?.count ?? 0);
    } catch {
      // Table may not exist
    }

    return {
      totalBalanceCents,
      activeKeyCount,
      paymentMethodCount,
      orgCount,
    };
  }),
});
