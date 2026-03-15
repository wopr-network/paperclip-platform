import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

export interface IEmailResolver {
  resolveEmail(tenantId: string): Promise<string | null>;
}

/**
 * Resolves a tenant ID to an email address by querying better-auth tables.
 * Tries direct user lookup first, then falls back to org owner.
 */
export class DrizzleBetterAuthEmailResolver implements IEmailResolver {
  constructor(private readonly db: PgDatabase<never>) {}

  async resolveEmail(tenantId: string): Promise<string | null> {
    type EmailRow = { email: string };
    type QueryResult = { rows: EmailRow[] };
    try {
      // Try direct user lookup first
      const result = (await this.db.execute(
        sql`SELECT email FROM "user" WHERE id = ${tenantId} LIMIT 1`,
      )) as QueryResult;
      if (result.rows.length > 0) return result.rows[0].email;

      // Fall back to org owner
      const orgResult = (await this.db.execute(
        sql`SELECT u.email FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = ${tenantId} AND m.role = 'owner' LIMIT 1`,
      )) as QueryResult;
      return orgResult.rows.length > 0 ? orgResult.rows[0].email : null;
    } catch {
      return null;
    }
  }
}
