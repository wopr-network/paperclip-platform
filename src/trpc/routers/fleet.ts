/**
 * tRPC fleet router — instance lifecycle, health, logs, metrics.
 *
 * Bridges the dashboard tRPC calls to the FleetManager / NodeRegistry
 * infrastructure. Uses the authenticated user's tenant ID (personal org)
 * to scope all operations.
 */

import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { logger } from "@wopr-network/platform-core/config/logger";
import type { ILedger } from "@wopr-network/platform-core/credits";
import { getUserEmail } from "@wopr-network/platform-core/email";
import type { IProfileStore } from "@wopr-network/platform-core/fleet/profile-store";
import type { IServiceKeyRepository } from "@wopr-network/platform-core/gateway/service-key-repository";
import type { ProductConfig } from "@wopr-network/platform-core/product-config";
import { protectedProcedure, router } from "@wopr-network/platform-core/trpc";
import { checkHealth, provisionContainer } from "@wopr-network/provision-client";
import type Docker from "dockerode";
import type { Pool } from "pg";
import { z } from "zod";
import type { NodeRegistry } from "../../fleet/node-registry.js";
import type { PlacementStrategy } from "../../fleet/placement.js";
import { registerRoute, removeRoute } from "../../proxy/fleet-resolver.js";
import { assertOrgAdminOrOwner } from "../auth-helpers.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface FleetRouterDeps {
  pool: Pool;
  docker: Docker;
  creditLedger: ILedger;
  profileStore: IProfileStore;
  productConfig: ProductConfig;
  nodeRegistry: NodeRegistry;
  placementStrategy: PlacementStrategy;
  serviceKeyRepo: IServiceKeyRepository | null;
}

let _deps: FleetRouterDeps | null = null;

export function setFleetRouterDeps(deps: FleetRouterDeps): void {
  _deps = deps;
}

function deps(): FleetRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Fleet router not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the FleetManager for a given instance (resolves node). */
function getFleetForInstance(instanceId: string) {
  const registry = deps().nodeRegistry;
  const nodeId = registry.getContainerNode(instanceId);
  return nodeId ? registry.getFleetManager(nodeId) : registry.list()[0].fleet;
}

/** Derive tenantId from context — personal org uses userId as tenantId. */
function tenantFromCtx(ctx: { user: { id: string }; tenantId: string | undefined }): string {
  return ctx.tenantId ?? ctx.user.id;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const fleetRouter = router({
  /** List all instances for the authenticated user's tenant. */
  listInstances: protectedProcedure.query(async ({ ctx }) => {
    const tenant = tenantFromCtx(ctx);
    const store = deps().profileStore;
    const profiles = await store.list();
    const tenantProfiles = profiles.filter((p) => p.tenantId === tenant);

    const registry = deps().nodeRegistry;
    const bots = await Promise.all(
      tenantProfiles.map(async (profile) => {
        try {
          const nodeId = registry.getContainerNode(profile.id);
          const fleet = nodeId ? registry.getFleetManager(nodeId) : registry.list()[0].fleet;
          return await fleet.status(profile.id);
        } catch {
          // Container may have been removed externally
          return {
            id: profile.id,
            name: profile.name,
            description: profile.description,
            image: profile.image,
            containerId: null,
            state: "error" as const,
            health: null,
            uptime: null,
            startedAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            stats: null,
            applicationMetrics: null,
          };
        }
      }),
    );

    return { bots };
  }),

  /** Get a single instance by ID. */
  getInstance: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ input, ctx }) => {
    const tenant = tenantFromCtx(ctx);
    const store = deps().profileStore;
    const profile = await store.get(input.id);
    if (!profile) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Instance not found" });
    }
    if (profile.tenantId !== tenant) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
    }
    const fleet = getFleetForInstance(input.id);
    const status = await fleet.status(input.id);
    // Filter secrets from env before returning to the client
    const { WOPR_PROVISION_SECRET, BETTER_AUTH_SECRET, DATABASE_URL, PAPERCLIP_GATEWAY_KEY, ...safeEnv } = profile.env;
    return { ...status, env: safeEnv };
  }),

  /** Create a new Paperclip instance. Requires admin role when orgId is provided. */
  createInstance: protectedProcedure
    .input(
      z.object({
        name: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
        template: z.string().optional(),
        provider: z.string().optional(),
        channels: z.array(z.string()).optional(),
        plugins: z.array(z.string()).optional(),
        image: z.string().optional(),
        description: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        orgId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = input.orgId ?? tenantFromCtx(ctx);
      await assertOrgAdminOrOwner(tenant, ctx.user.id);
      const pc = deps().productConfig;
      const maxInstances = pc.fleet?.maxInstances ?? Number(process.env.MAX_INSTANCES_PER_TENANT ?? 5);
      const containerPort = pc.fleet?.containerPort ?? Number(process.env.PAPERCLIP_CONTAINER_PORT ?? 3100);
      const containerImage =
        pc.fleet?.containerImage ?? process.env.PAPERCLIP_IMAGE ?? "ghcr.io/wopr-network/paperclip:managed";
      const platformDomain = pc.product.domain ?? process.env.PLATFORM_DOMAIN ?? "runpaperclip.com";
      const provisionSecret = process.env.PROVISION_SECRET ?? "";
      const uiOrigin = process.env.UI_ORIGIN ?? "http://localhost:3200";
      const gatewayUrl = process.env.GATEWAY_URL ?? "";
      const fleetDockerNetwork = process.env.FLEET_DOCKER_NETWORK ?? "";

      // Billing gate
      const ledger = deps().creditLedger;
      if (ledger) {
        const balance = await ledger.balance(tenant);
        if (balance.isZero() || balance.isNegative()) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Insufficient credits: add funds before creating an instance",
          });
        }
      }

      // Instance limit gate
      const store = deps().profileStore;
      const profiles = await store.list();
      const tenantInstances = profiles.filter((p) => p.tenantId === tenant);
      if (tenantInstances.length >= maxInstances) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Instance limit reached: maximum ${maxInstances} per tenant`,
        });
      }

      // Build env vars for the Paperclip container.
      // PAPERCLIP_HOME=/data — FleetManager mounts the volume at /data.
      // DATABASE_URL — each instance gets its own database on the shared Postgres.
      // (Embedded PG won't work because platform-core's ReadonlyRootfs + noexec tmpfs.)
      const instanceDbName = `paperclip_${input.name.replace(/-/g, "_")}`;
      const platformDbUrl = process.env.DATABASE_URL;
      let instanceDbUrl = "";
      if (platformDbUrl) {
        // Create a per-instance database on the shared Postgres
        try {
          const baseUrl = new URL(platformDbUrl);
          baseUrl.pathname = `/${instanceDbName}`;
          instanceDbUrl = baseUrl.toString();

          // Create the database if it doesn't exist (connect to default db)
          const pg = await import("pg");
          const adminClient = new pg.default.Client({ connectionString: platformDbUrl });
          await adminClient.connect();
          try {
            await adminClient.query(`CREATE DATABASE "${instanceDbName}"`);
            logger.info(`Created database ${instanceDbName}`);
          } catch (err: unknown) {
            // 42P04 = database already exists — that's fine
            if ((err as { code?: string }).code !== "42P04") throw err;
          } finally {
            await adminClient.end();
          }
        } catch (err) {
          logger.warn(`Failed to create instance database ${instanceDbName}`, { err });
        }
      }

      // The container name doubles as a Docker DNS hostname reachable by the platform proxy.
      // Paperclip's hostname allowlist must include it, plus the tenant subdomain.
      // In dev, Caddy serves on :8080, so include the port-qualified hostname too.
      const containerName = `wopr-${input.name}`;
      const tenantFqdn = `${input.name}.${platformDomain}`;
      const allowedHostnames = [containerName, tenantFqdn];
      // Parse UI_ORIGIN to discover non-standard ports (e.g. http://app.localhost:8080)
      for (const origin of uiOrigin.split(",")) {
        try {
          const u = new URL(origin.trim());
          if (u.port) allowedHostnames.push(`${tenantFqdn}:${u.port}`);
        } catch {
          /* skip malformed origins */
        }
      }

      // Generate a per-instance gateway key for metered inference billing.
      // Only when the gateway is enabled (service key repo wired at startup).
      const serviceKeyRepo = deps().serviceKeyRepo;
      const gatewayKey = serviceKeyRepo ? await serviceKeyRepo.generate(tenant, input.name) : undefined;

      const env: Record<string, string> = {
        PORT: String(containerPort),
        HOST: "0.0.0.0",
        NODE_ENV: "production",
        HOME: "/data",
        WOPR_PROVISION_SECRET: provisionSecret,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        PAPERCLIP_HOME: "/data",
        PAPERCLIP_HOSTED_MODE: "true",
        PAPERCLIP_DEPLOYMENT_MODE: "hosted_proxy",
        PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
        PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
        PAPERCLIP_ALLOWED_HOSTNAMES: allowedHostnames.join(","),
        ...(gatewayKey ? { PAPERCLIP_GATEWAY_KEY: gatewayKey } : {}),
        ...(instanceDbUrl ? { DATABASE_URL: instanceDbUrl } : {}),
        ...(input.env ?? {}),
      };
      if (input.provider) env.WOPR_PROVIDER = input.provider;
      if (input.channels?.length) env.WOPR_CHANNELS = input.channels.join(",");
      if (input.plugins?.length) env.WOPR_PLUGINS = input.plugins.join(",");

      // Select target node
      const registry = deps().nodeRegistry;
      const strategy = deps().placementStrategy;
      const nodes = registry.list();
      const containerCounts = registry.getContainerCounts();
      const targetNode = strategy.selectNode(nodes, containerCounts);
      const fleet = targetNode.fleet;

      logger.info(`Creating instance "${input.name}" for tenant ${tenant} on node ${targetNode.config.name}`);

      // Remove any stale container with the same name (e.g. from a previous
      // failed creation). Docker returns 409 Conflict if the name is taken.
      try {
        const docker = deps().docker;
        const stale = docker.getContainer(containerName);
        const info = await stale.inspect();
        logger.info(`Removing stale container ${containerName} (state: ${info.State?.Status})`);
        try {
          await stale.stop({ t: 5 });
        } catch {
          /* may already be stopped */
        }
        await stale.remove({ force: true });
      } catch {
        // Container doesn't exist — expected path
      }

      // Also clean up stale fleet profile YAML if one exists from a prior attempt
      try {
        const store = deps().profileStore;
        const profiles = await store.list();
        const existing = profiles.find((p: { name: string }) => `wopr-${p.name.replace(/_/g, "-")}` === containerName);
        if (existing) {
          logger.info(`Removing stale fleet profile for ${existing.name}`);
          await store.delete(existing.id);
        }
      } catch {
        // Profile store may not have a stale entry
      }

      // Create Docker container with a named volume for persistent data.
      // FleetManager mounts volumeName at /data; PAPERCLIP_HOME=/data above
      // tells the Paperclip app to use that path for embedded PG + instance state.
      const volumeName = `paperclip-${input.name}`;
      const createdInstance = await fleet.create({
        tenantId: tenant,
        name: input.name,
        description: input.description ?? `Paperclip instance: ${input.name}`,
        image: input.image ?? containerImage,
        env,
        volumeName,
        restartPolicy: "unless-stopped",
        releaseChannel: "stable",
        updatePolicy: "manual",
      });
      const profile = createdInstance.profile;

      // Init volume permissions — chown /data to node (uid 1000) so the
      // non-root container can write to it (embedded PG, logs, etc.)
      // Uses alpine (small, usually cached) and cleans up after itself.
      try {
        const docker = deps().docker;
        const init = await docker.createContainer({
          Image: "alpine:latest",
          Cmd: ["chown", "-R", "1000:1000", "/data"],
          HostConfig: { Binds: [`${volumeName}:/data`] },
        });
        await init.start();
        await init.wait();
        await init.remove();
      } catch (err) {
        logger.warn(`Volume init for ${volumeName} failed (non-fatal)`, { err });
      }

      // Start the container
      const inst = await fleet.getInstance(profile.id);
      await inst.start();

      // Connect container to the compose network so it's DNS-reachable
      if (fleetDockerNetwork) {
        try {
          const docker = deps().docker;
          const network = docker.getNetwork(fleetDockerNetwork);
          await network.connect({ Container: containerName });
          logger.info(`Connected ${containerName} to network ${fleetDockerNetwork}`);
        } catch (err) {
          logger.warn(`Failed to connect ${containerName} to network ${fleetDockerNetwork}`, { err });
        }
      }

      // Track container → node assignment
      registry.assignContainer(profile.id, targetNode.config.id);
      const upstreamHost = registry.resolveUpstreamHost(profile.id, containerName);
      await registerRoute(profile.id, input.name, upstreamHost, containerPort);

      // Wait for the container to become healthy, then provision it
      const containerUrl = `http://${upstreamHost}:${containerPort}`;

      // Helper: provision the container once healthy
      const doProvision = async () => {
        const pool = deps().pool;
        const dbEmail = await getUserEmail(pool, ctx.user.id);
        const userEmail = dbEmail ?? `${input.name}@runpaperclip.com`;
        const dbNameRow = await pool.query(`SELECT name FROM "user" WHERE id = $1`, [ctx.user.id]);
        const userName = (dbNameRow.rows[0]?.name as string | undefined) ?? input.name;
        const result = await provisionContainer(containerUrl, provisionSecret, {
          tenantId: tenant,
          tenantName: input.name,
          gatewayUrl: gatewayUrl,
          apiKey: gatewayKey ?? "",
          budgetCents: 0,
          adminUser: { id: ctx.user.id, email: userEmail, name: userName },
          agents: [{ name: "CEO", role: "ceo", title: "Chief Executive Officer" }],
        });
        logger.info(`Provisioned instance ${input.name}: tenantEntityId=${result.tenantEntityId}`);

        // Persist Paperclip company ID in profile so member provisioning can resolve it
        if (result.tenantEntityId) {
          const currentProfile = await store.get(profile.id);
          if (currentProfile) {
            currentProfile.env = { ...currentProfile.env, PAPERCLIP_COMPANY_ID: result.tenantEntityId };
            await store.save(currentProfile);
          }
        }
        return result;
      };

      // Wait up to 90s for the container to become healthy (containers can take 60s+ to boot)
      let healthy = false;
      for (let i = 0; i < 45; i++) {
        if (await checkHealth(containerUrl)) {
          healthy = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (healthy) {
        try {
          await doProvision();
        } catch (err) {
          logger.warn(`Provision call failed for ${input.name} (container is running but unconfigured)`, { err });
        }
      } else {
        logger.warn(`Container ${input.name} not healthy after 90s — retrying provision in background`);
        // Fire-and-forget background retry: keep checking for up to 3 more minutes
        (async () => {
          for (let i = 0; i < 36; i++) {
            await new Promise((r) => setTimeout(r, 5000));
            if (await checkHealth(containerUrl)) {
              try {
                await doProvision();
              } catch (err) {
                logger.warn(`Background provision retry failed for ${input.name}`, { err });
              }
              return;
            }
          }
          logger.error(`Container ${input.name} never became healthy — provision abandoned`);
        })();
      }

      logger.info(`Created instance: ${input.name} (${profile.id})`);

      return {
        id: profile.id,
        name: profile.name,
        state: healthy ? "running" : "unhealthy",
      };
    }),

  /** Control an instance: start, stop, restart, destroy. Requires admin role when orgId is provided. */
  controlInstance: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        action: z.enum(["start", "stop", "restart", "destroy"]),
        orgId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = input.orgId ?? tenantFromCtx(ctx);
      await assertOrgAdminOrOwner(tenant, ctx.user.id);
      const store = deps().profileStore;
      const profile = await store.get(input.id);
      if (!profile) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Instance not found" });
      }
      if (profile.tenantId !== tenant) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      const fleet = getFleetForInstance(input.id);
      const registry = deps().nodeRegistry;

      switch (input.action) {
        case "start": {
          const instance = await fleet.getInstance(input.id);
          await instance.start();
          break;
        }
        case "stop": {
          const instance = await fleet.getInstance(input.id);
          await instance.stop();
          break;
        }
        case "restart": {
          const instance = await fleet.getInstance(input.id);
          await instance.stop();
          await instance.start();
          break;
        }
        case "destroy": {
          const keyRepo = deps().serviceKeyRepo;
          if (keyRepo) await keyRepo.revokeByInstance(input.id);
          try {
            await fleet.remove(input.id);
          } catch (err) {
            logger.warn(`Fleet remove failed for ${input.id}`, { err });
          }
          registry.unassignContainer(input.id);
          await removeRoute(input.id);
          break;
        }
      }

      return { ok: true };
    }),

  /** Get health status for an instance. */
  getInstanceHealth: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ input, ctx }) => {
    const tenant = tenantFromCtx(ctx);
    const store = deps().profileStore;
    const profile = await store.get(input.id);
    if (!profile) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Instance not found" });
    }
    if (profile.tenantId !== tenant) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
    }

    const fleet = getFleetForInstance(input.id);
    const status = await fleet.status(input.id);

    return {
      id: status.id,
      state: status.state,
      health: status.health,
      uptime: status.uptime,
      stats: status.stats,
    };
  }),

  /** Get container logs for an instance. */
  getInstanceLogs: protectedProcedure
    .input(z.object({ id: z.string().min(1), tail: z.number().int().positive().max(1000).optional() }))
    .query(async ({ input, ctx }) => {
      const tenant = tenantFromCtx(ctx);
      const store = deps().profileStore;
      const profile = await store.get(input.id);
      if (!profile) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Instance not found" });
      }
      if (profile.tenantId !== tenant) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      const fleet = getFleetForInstance(input.id);
      const rawLogs = await fleet.logs(input.id, input.tail ?? 100);
      const logs = rawLogs.split("\n").filter((line) => line.trim().length > 0);

      return { logs };
    }),

  /** Get resource metrics for an instance. */
  getInstanceMetrics: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ input, ctx }) => {
    const tenant = tenantFromCtx(ctx);
    const store = deps().profileStore;
    const profile = await store.get(input.id);
    if (!profile) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Instance not found" });
    }
    if (profile.tenantId !== tenant) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
    }

    const fleet = getFleetForInstance(input.id);
    const status = await fleet.status(input.id);

    return {
      id: status.id,
      stats: status.stats,
    };
  }),

  /** Extract changelog from an instance's Docker image. */
  getChangelog: protectedProcedure.input(z.object({ instanceId: z.string().min(1) })).query(async ({ input, ctx }) => {
    const tenant = tenantFromCtx(ctx);
    const store = deps().profileStore;
    const profile = await store.get(input.instanceId);
    if (!profile) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Instance not found" });
    }
    if (profile.tenantId !== tenant) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
    }

    try {
      const docker = deps().docker;
      const container = await docker.createContainer({
        Image: profile.image,
        Cmd: ["cat", "/app/changelogs/latest.json"],
      });
      await container.start();
      await container.wait();
      const logs = await container.logs({ stdout: true });
      await container.remove();

      // Strip Docker stream header bytes (8-byte prefix per frame)
      const raw = logs
        .toString("utf8")
        .split("")
        .filter((ch) => ch.charCodeAt(0) > 8)
        .join("");
      const changelog: {
        version: string;
        date: string;
        sections: Array<{ title: string; items: string[] }>;
      } = JSON.parse(raw);
      return changelog;
    } catch (err) {
      logger.warn(`Changelog extraction failed for instance ${input.instanceId}`, { err });
      return null;
    }
  }),

  /** List available templates for instance creation. */
  listTemplates: protectedProcedure.query(() => {
    return [
      { id: "discord-bot", name: "Discord AI Bot", description: "AI assistant for Discord servers" },
      { id: "slack-assistant", name: "Slack Assistant", description: "AI assistant for Slack workspaces" },
      { id: "multi-channel", name: "Multi-channel", description: "Bot connected to multiple channels" },
      { id: "api-only", name: "API Only", description: "Headless bot with API access only" },
    ];
  }),
});
