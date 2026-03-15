/**
 * Client for calling Paperclip instance /internal/members/* endpoints.
 *
 * These endpoints are authenticated with the PROVISION_SECRET bearer token
 * and allow the platform to sync org membership changes into running
 * Paperclip containers.
 */

import { logger } from "../log.js";

export interface MemberProvisionResult {
  success: boolean;
  error?: string;
}

export class MemberProvisionClient {
  constructor(private readonly provisionSecret: string) {}

  async addMember(
    instanceUrl: string,
    companyId: string,
    user: { id: string; email: string; name?: string },
    role: string,
  ): Promise<MemberProvisionResult> {
    return this.call(instanceUrl, "/internal/members/add", {
      companyId,
      user,
      role,
    });
  }

  async removeMember(instanceUrl: string, companyId: string, userId: string): Promise<MemberProvisionResult> {
    return this.call(instanceUrl, "/internal/members/remove", {
      companyId,
      userId,
    });
  }

  async changeRole(
    instanceUrl: string,
    companyId: string,
    userId: string,
    newRole: string,
  ): Promise<MemberProvisionResult> {
    return this.call(instanceUrl, "/internal/members/change-role", {
      companyId,
      userId,
      role: newRole,
    });
  }

  private async call(instanceUrl: string, path: string, body: Record<string, unknown>): Promise<MemberProvisionResult> {
    try {
      const res = await fetch(`${instanceUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.provisionSecret}`,
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.warn("Member provision call failed", {
          path,
          status: res.status,
          text,
        });
        return { success: false, error: `HTTP ${res.status}: ${text}` };
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Member provision call error", { path, error: message });
      return { success: false, error: message };
    }
  }
}
