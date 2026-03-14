/**
 * Client for calling Paperclip instance /internal/members/* endpoints.
 *
 * These endpoints are authenticated with the PROVISION_SECRET bearer token
 * and allow the platform to sync org membership changes into running
 * Paperclip containers.
 */

import { logger } from "../log.js";

export class MemberProvisionClient {
  constructor(private readonly provisionSecret: string) {}

  async addMember(
    instanceUrl: string,
    params: {
      companyId: string;
      user: { id: string; email: string; name: string };
      role: string;
    },
  ): Promise<void> {
    const res = await fetch(`${instanceUrl}/internal/members/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.provisionSecret}`,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("Provision addMember failed", { instanceUrl, status: res.status, body });
      throw new Error(`Provision addMember failed: ${res.status}`);
    }
  }

  async removeMember(
    instanceUrl: string,
    params: {
      companyId: string;
      userId: string;
    },
  ): Promise<void> {
    const res = await fetch(`${instanceUrl}/internal/members/remove`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.provisionSecret}`,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("Provision removeMember failed", { instanceUrl, status: res.status, body });
      throw new Error(`Provision removeMember failed: ${res.status}`);
    }
  }

  async changeRole(
    instanceUrl: string,
    params: {
      companyId: string;
      userId: string;
      role: string;
    },
  ): Promise<void> {
    const res = await fetch(`${instanceUrl}/internal/members/change-role`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.provisionSecret}`,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("Provision changeRole failed", { instanceUrl, status: res.status, body });
      throw new Error(`Provision changeRole failed: ${res.status}`);
    }
  }
}
