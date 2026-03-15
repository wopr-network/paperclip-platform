/**
 * Root tRPC app router — composes all domain sub-routers.
 *
 * Adapted from wopr-platform for Paperclip Platform.
 * Only includes routers that the platform-ui-core dashboard actually consumes.
 */

import { DrizzleNotificationTemplateRepository } from "@wopr-network/platform-core/email";
import { getTenantUpdateConfigRepo } from "@wopr-network/platform-core/fleet";
import {
  createFleetUpdateConfigRouter,
  createNotificationTemplateRouter,
  router,
} from "@wopr-network/platform-core/trpc";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { getDb } from "../db/index.js";
import { billingRouter } from "./routers/billing.js";
import { fleetRouter } from "./routers/fleet.js";
import { orgRouter } from "./routers/org.js";
import { pageContextRouter } from "./routers/page-context.js";
import { profileRouter } from "./routers/profile.js";
import { settingsRouter } from "./routers/settings.js";

export const appRouter = router({
  billing: billingRouter,
  fleet: fleetRouter,
  fleetUpdateConfig: createFleetUpdateConfigRouter(() => getTenantUpdateConfigRepo()),
  // TODO: Add getNotificationTemplateRepo() to platform-core/fleet/services.ts
  // and use it here instead of inline DrizzleNotificationTemplateRepository construction.
  notificationTemplates: createNotificationTemplateRouter(() => {
    return new DrizzleNotificationTemplateRepository(getDb() as unknown as PgDatabase<never>);
  }),
  org: orgRouter,
  profile: profileRouter,
  settings: settingsRouter,
  pageContext: pageContextRouter,
});

/** The root router type — import this in the UI repo for full type inference. */
export type AppRouter = typeof appRouter;

// Re-export context type for adapter usage
export type { TRPCContext } from "@wopr-network/platform-core/trpc";
export { setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc";

// Re-export dep setters for initialization
export { setBillingRouterDeps } from "./routers/billing.js";
export { setOrgRouterDeps } from "./routers/org.js";
export { setPageContextRouterDeps } from "./routers/page-context.js";
export { setProfileRouterDeps } from "./routers/profile.js";
export { setSettingsRouterDeps } from "./routers/settings.js";
