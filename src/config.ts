import { z } from "zod";

const envSchema = z.object({
  /** Port for the HTTP server. */
  PORT: z.coerce.number().default(3200),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  /**
   * Domain that tenant subdomains live under.
   * e.g. "runpaperclip.ai" → alice.runpaperclip.ai
   */
  PLATFORM_DOMAIN: z.string().default("runpaperclip.ai"),

  /**
   * Comma-separated list of allowed origins for CORS.
   * In production this is the dashboard origin (e.g. https://runpaperclip.ai).
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
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | undefined;

export function getConfig(): Config {
  if (!_config) {
    _config = envSchema.parse(process.env);
  }
  return _config;
}
