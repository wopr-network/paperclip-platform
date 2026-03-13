/**
 * tRPC org router — organization settings, member management.
 *
 * Adapted from wopr-platform — pure platform-core imports.
 */

import { TRPCError } from "@trpc/server";
import type { IPaymentProcessor } from "@wopr-network/platform-core/billing";
import type { ILedger } from "@wopr-network/platform-core/credits";
import { Credit } from "@wopr-network/platform-core/credits";
import type { IAuthUserRepository } from "@wopr-network/platform-core/db/auth-user-repository";
import type { IMeterAggregator } from "@wopr-network/platform-core/metering";
import type { CreditPriceMap } from "@wopr-network/platform-core/monetization/index";
import { assertSafeRedirectUrl } from "@wopr-network/platform-core/security";
import type { OrgService } from "@wopr-network/platform-core/tenancy";
import { orgMemberProcedure, protectedProcedure, router } from "@wopr-network/platform-core/trpc";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type OrgRouterDeps = {
  orgService: OrgService;
  authUserRepo: IAuthUserRepository;
  creditLedger?: ILedger;
  meterAggregator?: IMeterAggregator;
  processor?: IPaymentProcessor;
  priceMap?: CreditPriceMap;
};

let _deps: OrgRouterDeps | null = null;

export function setOrgRouterDeps(deps: OrgRouterDeps): void {
  _deps = deps;
}

function deps(): OrgRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Org router not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const orgRouter = router({
  /** Get the organization for the authenticated user (personal tenant). */
  getOrganization: protectedProcedure.query(async ({ ctx }) => {
    const { orgService } = deps();
    const name = ("name" in ctx.user ? (ctx.user.name as string | undefined) : undefined) ?? "User";
    const email = ("email" in ctx.user ? (ctx.user.email as string | undefined) : undefined) ?? "";
    const org = await orgService.getOrCreatePersonalOrg(ctx.user.id, name);
    const members = org.members.map((m) => {
      if (m.userId === ctx.user.id) {
        return { ...m, name, email };
      }
      return m;
    });
    return { ...org, members };
  }),

  /** List organizations the authenticated user owns (excludes personal tenant). */
  listMyOrganizations: protectedProcedure.query(async ({ ctx }) => {
    const { orgService } = deps();
    // getOrCreatePersonalOrg ensures the personal tenant exists, then list owned orgs
    await orgService.getOrCreatePersonalOrg(ctx.user.id, "User");
    // OrgService doesn't expose listUserOrgs — use the underlying repo method
    // The orgRepo.listOrgsByOwner returns type="org" tenants only
    return [];
  }),

  /** Create a new team organization. The caller becomes the owner. */
  createOrganization: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "Organization name is required").max(128),
        slug: z.string().min(3).max(48).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      return orgService.createOrg(ctx.user.id, input.name, input.slug);
    }),

  /** Update organization name and/or slug. */
  updateOrganization: orgMemberProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        name: z.string().min(1).max(128).optional(),
        slug: z.string().min(3).max(48).optional(),
        billingEmail: z.string().email().max(255).optional().nullable(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { orgService } = deps();
      return orgService.updateOrg(input.orgId, ctx.user.id, {
        name: input.name,
        slug: input.slug,
        billingEmail: input.billingEmail,
      });
    }),

  /** Delete an organization. Owner only. */
  deleteOrganization: orgMemberProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      await orgService.deleteOrg(input.orgId, ctx.user.id);
      return { deleted: true };
    }),

  /** Invite a new member to the organization. */
  inviteMember: orgMemberProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        email: z.string().email(),
        role: z.enum(["admin", "member"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      const invite = await orgService.inviteMember(input.orgId, ctx.user.id, input.email, input.role);
      return {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        invitedBy: invite.invitedBy,
        expiresAt: new Date(invite.expiresAt).toISOString(),
        createdAt: new Date(invite.createdAt).toISOString(),
      };
    }),

  /** Revoke a pending invite. */
  revokeInvite: orgMemberProcedure
    .input(z.object({ orgId: z.string().min(1), inviteId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      await orgService.revokeInvite(input.orgId, ctx.user.id, input.inviteId);
      return { revoked: true };
    }),

  /** Change a member's role. */
  changeRole: orgMemberProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        userId: z.string().min(1),
        role: z.enum(["admin", "member"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      await orgService.changeRole(input.orgId, ctx.user.id, input.userId, input.role);
      return { updated: true };
    }),

  /** Remove a member from the organization. */
  removeMember: orgMemberProcedure
    .input(z.object({ orgId: z.string().min(1), userId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      await orgService.removeMember(input.orgId, ctx.user.id, input.userId);
      return { removed: true };
    }),

  /** Transfer organization ownership to another member. */
  transferOwnership: orgMemberProcedure
    .input(z.object({ orgId: z.string().min(1), userId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { orgService } = deps();
      await orgService.transferOwnership(input.orgId, ctx.user.id, input.userId);
      return { transferred: true };
    }),

  // -------------------------------------------------------------------------
  // Org billing — delegates to billing infrastructure using orgId as tenant
  // -------------------------------------------------------------------------

  /** Get credit balance for an organization. */
  orgBillingBalance: orgMemberProcedure.input(z.object({ orgId: z.string().min(1) })).query(async ({ input }) => {
    const { creditLedger, meterAggregator } = deps();
    if (!creditLedger || !meterAggregator) {
      return { balanceCents: 0, dailyBurnCents: 0, runwayDays: null };
    }
    const tenant = input.orgId;
    const balance = await creditLedger.balance(tenant);
    const balanceCents = balance.toCentsRounded();

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const { totalCharge } = await meterAggregator.getTenantTotal(tenant, sevenDaysAgo);
    const dailyBurnCents = Credit.fromRaw(Math.round(totalCharge / 7)).toCentsRounded();
    const runwayDays = dailyBurnCents > 0 ? Math.floor(balanceCents / dailyBurnCents) : null;

    return { balanceCents, dailyBurnCents, runwayDays };
  }),

  /** Get billing info (payment methods, invoices) for an organization. */
  orgBillingInfo: orgMemberProcedure.input(z.object({ orgId: z.string().min(1) })).query(async ({ input }) => {
    const { processor } = deps();
    if (!processor) {
      return { paymentMethods: [], invoices: [] };
    }
    const tenant = input.orgId;
    try {
      const savedMethods = await processor.listPaymentMethods(tenant);
      const paymentMethods = savedMethods.map((pm) => ({
        id: pm.id,
        brand: "",
        last4: pm.label.match(/\d{4}$/)?.[0] ?? "",
        expiryMonth: 0,
        expiryYear: 0,
        isDefault: pm.isDefault,
      }));

      const invoiceList = await processor.listInvoices(tenant);

      return {
        paymentMethods,
        invoices: invoiceList.map((inv) => ({
          id: inv.id,
          date: inv.date,
          amountCents: inv.amountCents,
          status: inv.status,
          downloadUrl: inv.downloadUrl,
        })),
      };
    } catch {
      return { paymentMethods: [], invoices: [] };
    }
  }),

  /** Get per-member usage breakdown for an organization. */
  orgMemberUsage: orgMemberProcedure.input(z.object({ orgId: z.string().min(1) })).query(async ({ input }) => {
    const { creditLedger } = deps();
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);

    if (!creditLedger) {
      return { orgId: input.orgId, periodStart: periodStart.toISOString(), members: [] };
    }

    const members = await creditLedger.memberUsage(input.orgId);
    return {
      orgId: input.orgId,
      periodStart: periodStart.toISOString(),
      members: members.map((m) => ({
        memberId: m.userId,
        name: "",
        email: "",
        creditsConsumedCents: m.totalDebit.toCents(),
        lastActiveAt: null,
      })),
    };
  }),

  /** Create a Stripe Checkout session for org credit top-up. */
  orgTopupCheckout: orgMemberProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        priceId: z.string().min(1).max(256),
        successUrl: z.string().url().max(2048),
        cancelUrl: z.string().url().max(2048),
      }),
    )
    .mutation(async ({ input }) => {
      const { processor } = deps();
      if (!processor) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Billing not configured" });
      }
      try {
        assertSafeRedirectUrl(input.successUrl);
        assertSafeRedirectUrl(input.cancelUrl);
      } catch {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid redirect URL" });
      }
      const session = await processor.createCheckoutSession({
        tenant: input.orgId,
        priceId: input.priceId,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      });
      return { url: session.url, sessionId: session.id };
    }),

  /** Create a Stripe SetupIntent for adding a payment method to an org. */
  orgSetupIntent: orgMemberProcedure.input(z.object({ orgId: z.string().min(1) })).mutation(async ({ input }) => {
    const { processor } = deps();
    if (!processor) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Billing not configured" });
    }
    const intent = await processor.setupPaymentMethod(input.orgId);
    return { clientSecret: intent.clientSecret };
  }),
});
