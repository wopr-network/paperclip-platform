import type { INotificationTemplateRepository } from "@wopr-network/platform-core/email";
import { DrizzleNotificationTemplateRepository } from "@wopr-network/platform-core/email";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { getDb } from "../db/index.js";

let _repo: INotificationTemplateRepository | null = null;

export function getNotificationTemplateRepo(): INotificationTemplateRepository {
  if (!_repo) {
    _repo = new DrizzleNotificationTemplateRepository(getDb() as unknown as PgDatabase<never>);
  }
  return _repo;
}
