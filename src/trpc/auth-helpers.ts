import { TRPCError } from "@trpc/server";
import { logger } from "@wopr-network/platform-core/config/logger";
import { getOrgMemberRepo } from "../fleet/services.js";

/**
 * Assert the caller is an admin or owner of the tenant org.
 * For personal tenants (tenantId === userId), this is a no-op.
 * When org member repo is not wired (dev mode), logs a warning and skips.
 */
export async function assertOrgAdminOrOwner(tenantId: string, userId: string): Promise<void> {
  if (tenantId === userId) return;
  const repo = getOrgMemberRepo();
  if (!repo) {
    logger.warn("assertOrgAdminOrOwner: org member repo not wired, skipping role check", { tenantId, userId });
    return;
  }
  const member = await repo.findMember(tenantId, userId);
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Organization admin access required" });
  }
}
