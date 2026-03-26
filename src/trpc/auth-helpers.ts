import { TRPCError } from "@trpc/server";

import { getOrgMemberRepo } from "../container.js";

/**
 * Assert the caller is an admin or owner of the tenant org.
 * For personal tenants (tenantId === userId), this is a no-op.
 * Throws if org member repo is not wired — fail closed.
 */
export async function assertOrgAdminOrOwner(tenantId: string, userId: string): Promise<void> {
  if (tenantId === userId) return;
  const repo = getOrgMemberRepo();
  if (!repo) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Organization service unavailable",
    });
  }
  const member = await repo.findMember(tenantId, userId);
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Organization admin access required" });
  }
}
