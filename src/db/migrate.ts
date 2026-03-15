/**
 * Run platform-core Drizzle migrations against the Postgres database.
 * Uses the migration files shipped with @wopr-network/platform-core,
 * followed by local paperclip-platform migrations (drizzle/migrations/).
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@wopr-network/platform-core/db/schema/index";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

const require = createRequire(import.meta.url);

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const db = drizzle(pool, { schema });
  // Resolve migrations folder from platform-core package.
  // Use the main export (which is in dist/) to find the package root,
  // since the exports map doesn't expose ./package.json.
  const coreMain = require.resolve("@wopr-network/platform-core");
  const coreRoot = path.resolve(path.dirname(coreMain), "..");
  const migrationsFolder = path.resolve(coreRoot, "drizzle/migrations");
  await migrate(db, { migrationsFolder });

  // Run local paperclip-platform migrations (notification_queue, notification_preferences, etc.)
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(thisFile), "../..");
  const localMigrations = path.resolve(projectRoot, "drizzle/migrations");
  if (existsSync(localMigrations)) {
    await migrate(db, { migrationsFolder: localMigrations });
  }
}
