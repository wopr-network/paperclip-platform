/**
 * Run platform-core Drizzle migrations against the Postgres database.
 * Uses the migration files shipped with @wopr-network/platform-core.
 */

import { createRequire } from "node:module";
import path from "node:path";
import * as schema from "@wopr-network/platform-core/db/schema/index";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

const require = createRequire(import.meta.url);

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const db = drizzle(pool, { schema });
  // Resolve migrations folder from platform-core package
  const corePkg = require.resolve("@wopr-network/platform-core/package.json");
  const migrationsFolder = path.resolve(path.dirname(corePkg), "drizzle/migrations");
  await migrate(db, { migrationsFolder });
}
