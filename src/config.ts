import { z } from "zod";

const envSchema = z.object({
  /** Port for the HTTP server. */
  PORT: z.coerce.number().default(3200),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  /**
   * Domain that tenant subdomains live under.
   * e.g. "runpaperclip.com" → alice.runpaperclip.com
   */
  PLATFORM_DOMAIN: z.string().default("runpaperclip.com"),

  /**
   * Comma-separated list of allowed origins for CORS.
   * In production this is the dashboard origin (e.g. https://runpaperclip.com).
   */
  UI_ORIGIN: z.string().default("http://localhost:3200"),

  /**
   * Secret shared with Paperclip fleet containers.
   * Used to authenticate /internal/provision calls.
   */
  PROVISION_SECRET: z.string().min(1),

  /**
   * URL for the platform-core inference gateway.
   * Passed to Paperclip containers during provisioning.
   */
  GATEWAY_URL: z.string().url(),

  /**
   * API key for the platform's metered inference gateway.
   * All hosted instances use this key — the platform bills tenants via credit ledger.
   * No BYOK: users don't bring their own keys on runpaperclip.com.
   */
  GATEWAY_API_KEY: z.string().default(""),

  /** Database URL for platform state (Postgres). */
  DATABASE_URL: z.string().optional(),

  /**
   * Docker image to use for Paperclip containers.
   * e.g. "ghcr.io/paperclipai/server:latest"
   */
  PAPERCLIP_IMAGE: z.string().default("ghcr.io/paperclipai/server:latest"),

  /**
   * Port that Paperclip containers listen on internally.
   * This is the PORT env var set inside each container.
   */
  PAPERCLIP_CONTAINER_PORT: z.coerce.number().default(3100),

  /** Directory for fleet profile data (file-based ProfileStore). */
  FLEET_DATA_DIR: z.string().default("/data/fleet"),

  /** Maximum Paperclip instances a single tenant can provision. */
  MAX_INSTANCES_PER_TENANT: z.coerce.number().default(5),

  /** API key for admin access (automation/monitoring). Required for MVP before DB-backed roles. */
  ADMIN_API_KEY: z.string().optional(),

  /** Caddy admin API URL for pushing route config. Empty string disables sync. */
  CADDY_ADMIN_URL: z.string().default("http://localhost:2019"),

  /** Cloudflare API token for DNS-01 challenge (wildcard TLS). */
  CLOUDFLARE_API_TOKEN: z.string().optional(),

  /**
   * JSON array of Docker host nodes for multi-node scaling.
   * Each entry: { id, name, host, dockerUrl?, maxContainers? }
   * When empty or unset, uses local Docker socket only (single-node mode).
   */
  FLEET_NODES: z.string().default(""),

  /**
   * Container placement strategy: "least-loaded" or "round-robin".
   * Only relevant when multiple nodes are configured.
   */
  FLEET_PLACEMENT_STRATEGY: z.string().default("least-loaded"),

  /**
   * Docker network to connect provisioned containers to.
   * Required when the platform runs inside a compose network so containers
   * are DNS-reachable by name. Empty string disables.
   */
  FLEET_DOCKER_NETWORK: z.string().default(""),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | undefined;

export function getConfig(): Config {
  if (!_config) {
    _config = envSchema.parse(process.env);
  }
  return _config;
}
