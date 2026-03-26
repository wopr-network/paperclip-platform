import type { IOrgMemberRepository } from "@wopr-network/platform-core/tenancy/org-member-repository";
import { createAssertOrgAdminOrOwner } from "@wopr-network/platform-core/trpc";

let _assertFn: ((tenantId: string, userId: string) => Promise<void>) | null = null;

export function setAuthHelpersDeps(orgMemberRepo: IOrgMemberRepository): void {
  _assertFn = createAssertOrgAdminOrOwner(orgMemberRepo);
}

/**
 * Assert the caller is an admin or owner of the tenant org.
 * For personal tenants (tenantId === userId), this is a no-op.
 * Throws if org member repo is not wired — fail closed.
 */
export async function assertOrgAdminOrOwner(tenantId: string, userId: string): Promise<void> {
  if (tenantId === userId) return;
  if (!_assertFn) {
    throw new Error("Auth helpers not initialized — call setAuthHelpersDeps first");
  }
  return _assertFn(tenantId, userId);
}
