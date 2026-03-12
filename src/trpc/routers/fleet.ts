/**
 * tRPC fleet router — instance lifecycle, health, logs, metrics.
 *
 * Bridges the dashboard tRPC calls to the FleetManager / NodeRegistry
 * infrastructure. Uses the authenticated user's tenant ID (personal org)
 * to scope all operations.
 */

import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { getUserEmail } from "@wopr-network/platform-core/email";
import { protectedProcedure, router } from "@wopr-network/platform-core/trpc";
import { checkHealth, provisionContainer } from "@wopr-network/provision-client";
import { z } from "zod";
import { getConfig } from "../../config.js";
import { getPool } from "../../db/index.js";
import {
  getCreditLedger,
  getDocker,
  getNodeRegistry,
  getPlacementStrategy,
  getProfileStore,
  getServiceKeyRepo,
} from "../../fleet/services.js";
import { logger } from "../../log.js";
import { registerRoute, removeRoute } from "../../proxy/fleet-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the FleetManager for a given instance (resolves node). */
function getFleetForInstance(instanceId: string) {
  const registry = getNodeRegistry();
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
    const store = getProfileStore();
    const profiles = await store.list();
    const tenantProfiles = profiles.filter((p) => p.tenantId === tenant);

    const registry = getNodeRegistry();
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
    const store = getProfileStore();
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

  /** Create a new Paperclip instance. */
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
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = tenantFromCtx(ctx);
      const config = getConfig();

      // Billing gate
      const ledger = getCreditLedger();
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
      const store = getProfileStore();
      const profiles = await store.list();
      const tenantInstances = profiles.filter((p) => p.tenantId === tenant);
      if (tenantInstances.length >= config.MAX_INSTANCES_PER_TENANT) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Instance limit reached: maximum ${config.MAX_INSTANCES_PER_TENANT} per tenant`,
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
      const tenantFqdn = `${input.name}.${config.PLATFORM_DOMAIN}`;
      const allowedHostnames = [containerName, tenantFqdn];
      // Parse UI_ORIGIN to discover non-standard ports (e.g. http://app.localhost:8080)
      for (const origin of config.UI_ORIGIN.split(",")) {
        try {
          const u = new URL(origin.trim());
          if (u.port) allowedHostnames.push(`${tenantFqdn}:${u.port}`);
        } catch {
          /* skip malformed origins */
        }
      }

      // Generate a per-instance gateway key for metered inference billing.
      // Only when the gateway is enabled (service key repo wired at startup).
      const serviceKeyRepo = getServiceKeyRepo();
      const gatewayKey = serviceKeyRepo ? await serviceKeyRepo.generate(tenant, input.name) : undefined;

      const env: Record<string, string> = {
        PORT: String(config.PAPERCLIP_CONTAINER_PORT),
        HOST: "0.0.0.0",
        NODE_ENV: "production",
        WOPR_PROVISION_SECRET: config.PROVISION_SECRET,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        PAPERCLIP_HOME: "/data",
        PAPERCLIP_HOSTED_MODE: "true",
        PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
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
      const registry = getNodeRegistry();
      const strategy = getPlacementStrategy();
      const nodes = registry.list();
      const containerCounts = registry.getContainerCounts();
      const targetNode = strategy.selectNode(nodes, containerCounts);
      const fleet = targetNode.fleet;

      logger.info(`Creating instance "${input.name}" for tenant ${tenant} on node ${targetNode.config.name}`);

      // Create Docker container with a named volume for persistent data.
      // FleetManager mounts volumeName at /data; PAPERCLIP_HOME=/data above
      // tells the Paperclip app to use that path for embedded PG + instance state.
      const volumeName = `paperclip-${input.name}`;
      const profile = await fleet.create({
        tenantId: tenant,
        name: input.name,
        description: input.description ?? `Paperclip instance: ${input.name}`,
        image: input.image ?? config.PAPERCLIP_IMAGE,
        env,
        volumeName,
        restartPolicy: "unless-stopped",
        releaseChannel: "stable",
        updatePolicy: "manual",
      });

      // Init volume permissions — chown /data to node (uid 1000) so the
      // non-root container can write to it (embedded PG, logs, etc.)
      // Uses alpine (small, usually cached) and cleans up after itself.
      try {
        const docker = getDocker();
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
      await fleet.start(profile.id);

      // Connect container to the compose network so it's DNS-reachable
      if (config.FLEET_DOCKER_NETWORK) {
        try {
          const docker = getDocker();
          const network = docker.getNetwork(config.FLEET_DOCKER_NETWORK);
          await network.connect({ Container: containerName });
          logger.info(`Connected ${containerName} to network ${config.FLEET_DOCKER_NETWORK}`);
        } catch (err) {
          logger.warn(`Failed to connect ${containerName} to network ${config.FLEET_DOCKER_NETWORK}`, { err });
        }
      }

      // Track container → node assignment
      registry.assignContainer(profile.id, targetNode.config.id);
      const upstreamHost = registry.resolveUpstreamHost(profile.id, containerName);
      const containerPort = config.PAPERCLIP_CONTAINER_PORT;
      await registerRoute(profile.id, input.name, upstreamHost, containerPort);

      // Wait for the container to become healthy, then provision it
      const containerUrl = `http://${upstreamHost}:${containerPort}`;
      let healthy = false;
      for (let i = 0; i < 15; i++) {
        if (await checkHealth(containerUrl)) {
          healthy = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      let provisionResult: { tenantEntityId?: string } = {};
      if (healthy) {
        try {
          const pool = getPool();
          const dbEmail = await getUserEmail(pool, ctx.user.id);
          const userEmail = dbEmail ?? `${input.name}@runpaperclip.com`;
          const dbNameRow = await pool.query(`SELECT name FROM "user" WHERE id = $1`, [ctx.user.id]);
          const userName = (dbNameRow.rows[0]?.name as string | undefined) ?? input.name;
          provisionResult = await provisionContainer(containerUrl, config.PROVISION_SECRET, {
            tenantId: tenant,
            tenantName: input.name,
            gatewayUrl: config.GATEWAY_URL,
            apiKey: gatewayKey ?? "",
            budgetCents: 0,
            adminUser: { id: ctx.user.id, email: userEmail, name: userName },
            agents: [{ name: "CEO", role: "ceo", title: "Chief Executive Officer" }],
          });
          logger.info(`Provisioned instance ${input.name}: tenantEntityId=${provisionResult.tenantEntityId}`);
        } catch (err) {
          logger.warn(`Provision call failed for ${input.name} (container is running but unconfigured)`, { err });
        }
      } else {
        logger.warn(`Container ${input.name} failed health check — skipping provision`);
      }

      logger.info(`Created instance: ${input.name} (${profile.id})`);

      return {
        id: profile.id,
        name: profile.name,
        state: healthy ? "running" : "unhealthy",
      };
    }),

  /** Control an instance: start, stop, restart, destroy. */
  controlInstance: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        action: z.enum(["start", "stop", "restart", "destroy"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = tenantFromCtx(ctx);
      const store = getProfileStore();
      const profile = await store.get(input.id);
      if (!profile) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Instance not found" });
      }
      if (profile.tenantId !== tenant) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      const fleet = getFleetForInstance(input.id);
      const registry = getNodeRegistry();

      switch (input.action) {
        case "start":
          await fleet.start(input.id);
          break;
        case "stop":
          await fleet.stop(input.id);
          break;
        case "restart":
          await fleet.restart(input.id);
          break;
        case "destroy": {
          const keyRepo = getServiceKeyRepo();
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
    const store = getProfileStore();
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
      const store = getProfileStore();
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
    const store = getProfileStore();
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
