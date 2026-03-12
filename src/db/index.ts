/**
 * Database setup for paperclip-platform.
 *
 * Uses platform-core's Drizzle schema with a Postgres pool.
 * Pool is created lazily from DATABASE_URL env var.
 */

import { createDb, type PlatformDb } from "@wopr-network/platform-core/db";
import pg from "pg";
import { logger } from "../log.js";

const { Pool } = pg;

let _pool: pg.Pool | null = null;
let _db: PlatformDb | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL not set — cannot initialize database");
    }
    _pool = new Pool({ connectionString: url });
    _pool.on("error", (err) => {
      logger.error("Postgres pool error", { error: err.message });
    });
  }
  return _pool;
}

export function getDb(): PlatformDb {
  if (!_db) {
    _db = createDb(getPool());
  }
  return _db;
}

export function hasDatabase(): boolean {
  return !!process.env.DATABASE_URL;
}
