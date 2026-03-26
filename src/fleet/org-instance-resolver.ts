/**
 * Resolves a platform org to its Paperclip container instance.
 *
 * Looks up the BotProfile by tenantId, then resolves the upstream
 * container URL from the ProxyManager route table and the Paperclip
 * companyId from the profile's PAPERCLIP_COMPANY_ID env var.
 */

import { logger } from "@wopr-network/platform-core/config/logger";
import type { IProfileStore } from "@wopr-network/platform-core/fleet/profile-store";
import type { ProxyManagerInterface } from "@wopr-network/platform-core/proxy/types";

let _profileStore: IProfileStore | null = null;
let _proxyManager: ProxyManagerInterface | null = null;

export function setOrgInstanceResolverDeps(profileStore: IProfileStore, proxyManager: ProxyManagerInterface): void {
  _profileStore = profileStore;
  _proxyManager = proxyManager;
}

export interface OrgInstance {
  instanceUrl: string;
  companyId: string;
}

/**
 * Find the running Paperclip instance for an org.
 * Returns null if no instance exists or the container is unhealthy.
 *
 * @deprecated Use {@link resolveOrgInstances} — an org can own multiple instances.
 */
export async function resolveOrgInstance(orgId: string): Promise<OrgInstance | null> {
  const instances = await resolveOrgInstances(orgId);
  return instances[0] ?? null;
}

/**
 * Find ALL running Paperclip instances for an org.
 * An org can own multiple instances — member changes must sync to every one.
 */
export async function resolveOrgInstances(orgId: string): Promise<OrgInstance[]> {
  if (!_profileStore || !_proxyManager) throw new Error("OrgInstanceResolver not initialized");
  const store = _profileStore;
  const profiles = await store.list();
  const orgProfiles = profiles.filter((p) => p.tenantId === orgId);
  if (orgProfiles.length === 0) {
    logger.debug("No fleet profiles found for org", { orgId });
    return [];
  }

  const routes = _proxyManager.getRoutes();
  const instances: OrgInstance[] = [];

  for (const profile of orgProfiles) {
    const companyId = profile.env?.PAPERCLIP_COMPANY_ID;
    if (!companyId) {
      logger.debug("Fleet profile missing PAPERCLIP_COMPANY_ID", { orgId, profileId: profile.id });
      continue;
    }

    const route = routes.find((r) => r.instanceId === profile.id);
    if (!route || !route.healthy) {
      logger.debug("No healthy route for fleet profile", { orgId, profileId: profile.id });
      continue;
    }

    instances.push({
      instanceUrl: `http://${route.upstreamHost}:${route.upstreamPort}`,
      companyId,
    });
  }

  return instances;
}
