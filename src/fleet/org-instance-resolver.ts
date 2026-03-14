/**
 * Resolves a platform org to its Paperclip container instance.
 *
 * Looks up the BotProfile by tenantId, then resolves the upstream
 * container URL from the ProxyManager route table and the Paperclip
 * companyId from the profile's PAPERCLIP_COMPANY_ID env var.
 */

import { logger } from "../log.js";
import { getProfileStore, getProxyManager } from "./services.js";

export interface OrgInstance {
  instanceUrl: string;
  companyId: string;
}

/**
 * Find the running Paperclip instance for an org.
 * Returns null if no instance exists or the container is unhealthy.
 */
export async function resolveOrgInstance(orgId: string): Promise<OrgInstance | null> {
  const store = getProfileStore();
  const profiles = await store.list();
  const profile = profiles.find((p) => p.tenantId === orgId);
  if (!profile) {
    logger.debug("No fleet profile found for org", { orgId });
    return null;
  }

  const companyId = profile.env?.PAPERCLIP_COMPANY_ID;
  if (!companyId) {
    logger.debug("Fleet profile missing PAPERCLIP_COMPANY_ID", { orgId, profileId: profile.id });
    return null;
  }

  const routes = getProxyManager().getRoutes();
  const route = routes.find((r) => r.instanceId === profile.id);
  if (!route || !route.healthy) {
    logger.debug("No healthy route for fleet profile", { orgId, profileId: profile.id });
    return null;
  }

  return {
    instanceUrl: `http://${route.upstreamHost}:${route.upstreamPort}`,
    companyId,
  };
}
