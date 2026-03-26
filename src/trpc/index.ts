/**
 * Root tRPC app router — composes all domain sub-routers.
 *
 * Adapted from wopr-platform for Paperclip Platform.
 * Only includes routers that the platform-ui-core dashboard actually consumes.
 */

import { getRolloutOrchestrator, getTenantUpdateConfigRepo } from "@wopr-network/platform-core/fleet";
import {
  authSocialRouter,
  createAdminFleetUpdateRouter,
  createFleetUpdateConfigRouter,
  createNotificationTemplateRouter,
  createProductConfigRouter,
  router,
} from "@wopr-network/platform-core/trpc";

// Extract the service type from createProductConfigRouter's first parameter.
// Avoids importing from @wopr-network/platform-core/product-config which has no
// package.json exports entry.
type ProductConfigService = Parameters<typeof createProductConfigRouter>[0] extends () => infer S ? S : never;

import type { DrizzleDb } from "@wopr-network/platform-core/db";
import { DrizzleNotificationTemplateRepository } from "@wopr-network/platform-core/email";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { adminRouter } from "./routers/admin.js";
import { billingRouter } from "./routers/billing.js";
import { fleetRouter } from "./routers/fleet.js";
import { orgRouter } from "./routers/org.js";
import { pageContextRouter } from "./routers/page-context.js";
import { profileRouter } from "./routers/profile.js";
import { settingsRouter } from "./routers/settings.js";

// Late-bound deps — set after container construction.
let _productConfigServiceRef: ProductConfigService | null = null;
let _productSlug = "paperclip";
let _db: DrizzleDb | null = null;

export function setProductConfigRouterDeps(service: ProductConfigService, slug: string): void {
  _productConfigServiceRef = service;
  _productSlug = slug;
}

export function setTrpcDb(db: DrizzleDb): void {
  _db = db;
}

export const appRouter = router({
  admin: adminRouter,
  authSocial: authSocialRouter,
  adminFleetUpdate: createAdminFleetUpdateRouter(
    () => getRolloutOrchestrator(),
    () => getTenantUpdateConfigRepo(),
  ),
  billing: billingRouter,
  fleet: fleetRouter,
  fleetUpdateConfig: createFleetUpdateConfigRouter(() => getTenantUpdateConfigRepo()),
  notificationTemplates: createNotificationTemplateRouter(() => {
    if (!_db) throw new Error("tRPC db not initialized — call setTrpcDb() before using notification templates");
    return new DrizzleNotificationTemplateRepository(_db as unknown as PgDatabase<never>);
  }),
  org: orgRouter,
  pageContext: pageContextRouter,
  product: createProductConfigRouter(() => {
    if (!_productConfigServiceRef) throw new Error("ProductConfigService not initialized");
    return _productConfigServiceRef;
  }, _productSlug),
  profile: profileRouter,
  settings: settingsRouter,
});

/** The root router type — import this in the UI repo for full type inference. */
export type AppRouter = typeof appRouter;

// Re-export context type for adapter usage
export type { TRPCContext } from "@wopr-network/platform-core/trpc";
export { setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc";

// Re-export dep setters for initialization
export { setAdminRouterDeps } from "./routers/admin.js";
export { setBillingRouterDeps } from "./routers/billing.js";
export { setFleetRouterDeps } from "./routers/fleet.js";
export { setOrgRouterDeps } from "./routers/org.js";
export { setPageContextRouterDeps } from "./routers/page-context.js";
export { setProfileRouterDeps } from "./routers/profile.js";
export { setSettingsRouterDeps } from "./routers/settings.js";
