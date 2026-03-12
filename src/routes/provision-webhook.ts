/**
 * Paperclip instance lifecycle routes — the "easy button."
 *
 * POST /api/provision/create  — spin up a new Paperclip container and configure it
 * POST /api/provision/destroy — tear down a Paperclip container
 * PUT  /api/provision/budget  — update a container's spending budget
 *
 * Uses:
 * - platform-core FleetManager for Docker container lifecycle
 * - @wopr-network/provision-client for configuring containers via /internal/provision
 * - NodeRegistry + PlacementStrategy for multi-node container placement
 */

import { checkHealth, deprovisionContainer, provisionContainer, updateBudget } from "@wopr-network/provision-client";
import { Hono } from "hono";
import { getConfig } from "../config.js";
import { getCreditLedger, getNodeRegistry, getPlacementStrategy, getProfileStore } from "../fleet/services.js";
import { removeServiceKey } from "../gateway/service-keys.js";
import { logger } from "../log.js";
import { registerRoute, removeRoute } from "../proxy/fleet-resolver.js";

export const provisionWebhookRoutes = new Hono();

/** Validate the internal provision secret. */
function assertSecret(authHeader: string | undefined): boolean {
  const secret = getConfig().PROVISION_SECRET;
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length).trim();
  return token === secret;
}

/**
 * POST /api/provision/create — create a new Paperclip instance.
 *
 * Flow:
 * 1. Select target node via placement strategy
 * 2. FleetManager.create() → Docker container with the Paperclip image
 * 3. FleetManager.start() → start the container
 * 4. Register proxy route → subdomain.runpaperclip.com → container
 * 5. Wait for health check
 * 6. provision-client → configure the Paperclip instance (company, users, agents)
 */
provisionWebhookRoutes.post("/create", async (c) => {
  if (!assertSecret(c.req.header("authorization"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json();
  const { tenantId, subdomain, adminUser, agents, budgetCents, apiKey } = body;

  if (!tenantId || !subdomain) {
    return c.json({ error: "Missing required fields: tenantId, subdomain" }, 422);
  }

  const config = getConfig();
  const registry = getNodeRegistry();

  // Billing gate — require positive credit balance before provisioning
  const ledger = getCreditLedger();
  if (ledger) {
    const balance = await ledger.balance(tenantId);
    if (balance.isZero() || balance.isNegative()) {
      return c.json({ error: "Insufficient credits: add funds before creating an instance" }, 402);
    }
  }

  // Instance limit gate — cap instances per tenant
  const store = getProfileStore();
  const profiles = await store.list();
  const tenantInstances = profiles.filter((p) => p.tenantId === tenantId);
  if (tenantInstances.length >= config.MAX_INSTANCES_PER_TENANT) {
    return c.json({ error: `Instance limit reached: maximum ${config.MAX_INSTANCES_PER_TENANT} per tenant` }, 403);
  }

  // Select target node via placement strategy
  const strategy = getPlacementStrategy();
  const nodes = registry.list();
  const containerCounts = registry.getContainerCounts();
  const targetNode = strategy.selectNode(nodes, containerCounts);
  const fleet = targetNode.fleet;

  logger.info(`Placing container on node: ${targetNode.config.name} (${targetNode.config.id})`);

  // 1. Create the Docker container via FleetManager on the target node
  const profile = await fleet.create({
    tenantId,
    name: subdomain,
    description: `Paperclip instance for ${subdomain}`,
    image: config.PAPERCLIP_IMAGE,
    env: {
      PORT: String(config.PAPERCLIP_CONTAINER_PORT),
      WOPR_PROVISION_SECRET: config.PROVISION_SECRET,
    },
    restartPolicy: "unless-stopped",
    releaseChannel: "stable",
    updatePolicy: "manual",
  });

  // 2. Start the container
  await fleet.start(profile.id);

  // Track container → node assignment
  registry.assignContainer(profile.id, targetNode.config.id);

  // 3. Register proxy route — use node-appropriate upstream host
  const containerName = `wopr-${subdomain}`;
  const upstreamHost = registry.resolveUpstreamHost(profile.id, containerName);
  const containerPort = config.PAPERCLIP_CONTAINER_PORT;
  await registerRoute(profile.id, subdomain, upstreamHost, containerPort);

  // 4. Wait for container to become healthy
  const containerUrl = `http://${upstreamHost}:${containerPort}`;
  const healthy = await waitForHealth(containerUrl);
  if (!healthy) {
    logger.warn(`Container not healthy after creation: ${subdomain}`);
    // Clean up — remove container, route, and gateway key
    const gwKey = profile.env?.PAPERCLIP_GATEWAY_KEY;
    if (gwKey) removeServiceKey(gwKey);
    try {
      await fleet.remove(profile.id);
    } catch (err) {
      logger.warn("Cleanup after unhealthy container failed", { err });
    }
    registry.unassignContainer(profile.id);
    await removeRoute(profile.id);
    return c.json({ error: "Container failed health check" }, 503);
  }

  // 5. Configure via provision-client (company, admin user, starter agents)
  const tenantName = body.tenantName ?? subdomain;
  const result = await provisionContainer(containerUrl, config.PROVISION_SECRET, {
    tenantId,
    tenantName,
    gatewayUrl: config.GATEWAY_URL,
    apiKey: apiKey ?? "",
    budgetCents: budgetCents ?? 0,
    adminUser: adminUser ?? {
      id: tenantId,
      email: `${subdomain}@runpaperclip.com`,
      name: subdomain,
    },
    agents,
  });

  logger.info(`Created Paperclip instance: ${subdomain} (${profile.id}) on node ${targetNode.config.name}`);

  return c.json(
    {
      ok: true,
      instanceId: profile.id,
      subdomain,
      containerUrl,
      nodeId: targetNode.config.id,
      ...result,
    },
    201,
  );
});

/**
 * POST /api/provision/destroy — tear down a Paperclip instance.
 */
provisionWebhookRoutes.post("/destroy", async (c) => {
  if (!assertSecret(c.req.header("authorization"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json();
  const { instanceId, tenantEntityId } = body;

  if (!instanceId) {
    return c.json({ error: "Missing required field: instanceId" }, 422);
  }

  const config = getConfig();
  const registry = getNodeRegistry();

  // Resolve which node this container is on
  const nodeId = registry.getContainerNode(instanceId);
  const fleet = nodeId ? registry.getFleetManager(nodeId) : registry.list()[0].fleet;

  // Deprovision the Paperclip instance first (graceful teardown)
  if (tenantEntityId) {
    try {
      const status = await fleet.status(instanceId);
      if (status.state === "running") {
        const containerName = `wopr-${status.name}`;
        const upstreamHost = registry.resolveUpstreamHost(instanceId, containerName);
        const containerUrl = `http://${upstreamHost}:${config.PAPERCLIP_CONTAINER_PORT}`;
        await deprovisionContainer(containerUrl, config.PROVISION_SECRET, tenantEntityId);
      }
    } catch (err) {
      logger.warn(`Deprovision call failed for ${instanceId}`, { err });
      // Continue — container may already be gone
    }
  }

  // Remove the instance's gateway service key (if any)
  const store = getProfileStore();
  const destroyProfile = await store.get(instanceId);
  const gwKey = destroyProfile?.env?.PAPERCLIP_GATEWAY_KEY;
  if (gwKey) removeServiceKey(gwKey);

  // Remove the Docker container
  try {
    await fleet.remove(instanceId);
  } catch (err) {
    logger.warn(`Fleet remove failed for ${instanceId}`, { err });
  }

  // Remove from tracking and proxy route table
  registry.unassignContainer(instanceId);
  await removeRoute(instanceId);

  logger.info(`Destroyed Paperclip instance: ${instanceId}`);
  return c.json({ ok: true });
});

/**
 * PUT /api/provision/budget — update a container's spending budget.
 */
provisionWebhookRoutes.put("/budget", async (c) => {
  if (!assertSecret(c.req.header("authorization"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json();
  const { instanceId, tenantEntityId, budgetCents, perAgentCents } = body;

  if (!instanceId || !tenantEntityId || budgetCents === undefined) {
    return c.json({ error: "Missing required fields: instanceId, tenantEntityId, budgetCents" }, 422);
  }

  const config = getConfig();
  const registry = getNodeRegistry();

  // Resolve which node this container is on
  const nodeId = registry.getContainerNode(instanceId);
  const fleet = nodeId ? registry.getFleetManager(nodeId) : registry.list()[0].fleet;

  const status = await fleet.status(instanceId);
  if (status.state !== "running") {
    return c.json({ error: "Instance not running" }, 503);
  }

  const containerName = `wopr-${status.name}`;
  const upstreamHost = registry.resolveUpstreamHost(instanceId, containerName);
  const containerUrl = `http://${upstreamHost}:${config.PAPERCLIP_CONTAINER_PORT}`;

  await updateBudget(containerUrl, config.PROVISION_SECRET, tenantEntityId, budgetCents, perAgentCents);

  return c.json({ ok: true });
});

/**
 * Wait for a container to pass its health check.
 * Retries up to 10 times with 2-second intervals.
 */
async function waitForHealth(containerUrl: string, retries = 10, intervalMs = 2000): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    if (await checkHealth(containerUrl)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
