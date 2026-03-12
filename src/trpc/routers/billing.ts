/**
 * tRPC billing router — credits balance, history, checkout, spending limits.
 *
 * Adapted from wopr-platform for Paperclip Platform.
 * Paperclip plan: $5/mo per bot (credit-based, same as WOPR).
 */

import { TRPCError } from "@trpc/server";
import type { AuditLogger } from "@wopr-network/platform-core/audit/logger";
import type { IPaymentProcessor, PayRamChargeRepository } from "@wopr-network/platform-core/billing";
import { createPayRamCheckout, MIN_PAYMENT_USD } from "@wopr-network/platform-core/billing";
import { logger } from "@wopr-network/platform-core/config/logger";
import type { ICreditLedger } from "@wopr-network/platform-core/credits";
import {
  ALLOWED_SCHEDULE_INTERVALS,
  ALLOWED_THRESHOLDS,
  ALLOWED_TOPUP_AMOUNTS,
  Credit,
  computeNextScheduleAt,
  type IAutoTopupSettingsRepository,
} from "@wopr-network/platform-core/credits";
import type { IMeterAggregator } from "@wopr-network/platform-core/metering";
import type { IAffiliateRepository } from "@wopr-network/platform-core/monetization/affiliate/drizzle-affiliate-repository";
import type { IDividendRepository } from "@wopr-network/platform-core/monetization/credits/dividend-repository";
import type { ISpendingLimitsRepository } from "@wopr-network/platform-core/monetization/drizzle-spending-limits-repository";
import type { CreditPriceMap, ITenantCustomerRepository } from "@wopr-network/platform-core/monetization/index";
import type { PromotionEngine } from "@wopr-network/platform-core/monetization/promotions/engine";
import { assertSafeRedirectUrl } from "@wopr-network/platform-core/security";
import { protectedProcedure, publicProcedure, router, tenantProcedure } from "@wopr-network/platform-core/trpc";
import type { Payram } from "payram";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schedule interval → hours mapping
// ---------------------------------------------------------------------------

const SCHEDULE_INTERVAL_HOURS: Record<"daily" | "weekly" | "monthly", number> = {
  daily: 24,
  weekly: 168,
  monthly: 720,
};

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const tenantIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const urlSchema = z.string().url().max(2048);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_-]+$/i);

// ---------------------------------------------------------------------------
// Static plan data — Paperclip is credit-based like WOPR
// ---------------------------------------------------------------------------

const PLAN_TIERS = [
  {
    id: "free",
    tier: "free" as const,
    name: "Free",
    price: 0,
    priceLabel: "$0/mo",
    features: {
      instanceCap: 1,
      channels: "1 channel",
      plugins: "Community",
      support: "Community",
      extras: [] as string[],
    },
    recommended: false,
  },
  {
    id: "starter",
    tier: "starter" as const,
    name: "Starter",
    price: 5,
    priceLabel: "$5/mo per bot",
    features: {
      instanceCap: 3,
      channels: "Unlimited",
      plugins: "All plugins",
      support: "Email",
      extras: ["Usage-based credits"],
    },
    recommended: true,
  },
  {
    id: "pro",
    tier: "pro" as const,
    name: "Pro",
    price: 19,
    priceLabel: "$19/mo",
    features: {
      instanceCap: 10,
      channels: "Unlimited",
      plugins: "All plugins",
      support: "Priority",
      extras: ["Team management", "Priority queue"],
    },
    recommended: false,
  },
  {
    id: "enterprise",
    tier: "enterprise" as const,
    name: "Enterprise",
    price: null as number | null,
    priceLabel: "Custom",
    features: {
      instanceCap: null as number | null,
      channels: "Unlimited",
      plugins: "All + custom",
      support: "Dedicated",
      extras: ["SLA", "Custom integrations", "On-prem option"],
    },
    recommended: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Deps — injected at startup
// ---------------------------------------------------------------------------

export interface BillingRouterDeps {
  processor: IPaymentProcessor;
  tenantRepo: ITenantCustomerRepository;
  creditLedger: ICreditLedger;
  meterAggregator: IMeterAggregator;
  priceMap: CreditPriceMap | undefined;
  autoTopupSettingsStore: IAutoTopupSettingsRepository;
  dividendRepo: IDividendRepository;
  spendingLimitsRepo: ISpendingLimitsRepository;
  affiliateRepo: IAffiliateRepository;
  payramClient?: Payram;
  payramChargeRepo?: PayRamChargeRepository;
  auditLogger?: AuditLogger;
  promotionEngine?: PromotionEngine;
}

let _deps: BillingRouterDeps | null = null;

export function setBillingRouterDeps(deps: BillingRouterDeps): void {
  _deps = deps;
}

function deps(): BillingRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Billing not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const billingRouter = router({
  /** Get credits balance for a tenant. Uses validated ctx.tenantId. */
  creditsBalance: tenantProcedure
    .input(z.object({ tenant: tenantIdSchema.optional() }).optional())
    .query(async ({ input, ctx }) => {
      if (input?.tenant && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const tenant = input?.tenant ?? ctx.tenantId;
      const { creditLedger, meterAggregator } = deps();
      const balance = await creditLedger.balance(tenant);

      // Compute 7-day average daily burn from usage summaries.
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const { totalCharge } = await meterAggregator.getTenantTotal(tenant, sevenDaysAgo);
      const daily_burn_credits = Credit.fromRaw(Math.round(totalCharge / 7)).toCentsRounded();
      const runway_days = daily_burn_credits > 0 ? Math.floor(balance.toCentsRounded() / daily_burn_credits) : null;

      return { tenant, balance_credits: balance.toCentsRounded(), daily_burn_credits, runway_days };
    }),

  /** Get credit transaction history for a tenant. Uses validated ctx.tenantId. */
  creditsHistory: tenantProcedure
    .input(
      z.object({
        tenant: tenantIdSchema.optional(),
        type: z.enum(["grant", "refund", "correction"]).optional(),
        from: z.number().int().optional(),
        to: z.number().int().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      if (input.tenant && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const tenant = input.tenant ?? ctx.tenantId;
      const { creditLedger } = deps();
      const entries = await creditLedger.history(tenant, input);
      return { entries, total: entries.length };
    }),

  /** Get available credit purchase tiers with real Stripe price IDs. */
  creditOptions: publicProcedure.query(() => {
    const { priceMap } = deps();
    if (!priceMap || priceMap.size === 0) return [];
    const options: Array<{
      priceId: string;
      label: string;
      amountCents: number;
      creditCents: number;
      bonusPercent: number;
    }> = [];
    for (const [priceId, point] of priceMap) {
      options.push({
        priceId,
        label: point.label,
        amountCents: point.amountCents,
        creditCents: point.creditCents,
        bonusPercent: point.bonusPercent,
      });
    }
    // Sort by amountCents ascending for consistent ordering
    options.sort((a, b) => a.amountCents - b.amountCents);
    return options;
  }),

  /** Create a Stripe Checkout session for credit purchase. */
  creditsCheckout: tenantProcedure
    .input(
      z.object({
        tenant: tenantIdSchema.optional(),
        priceId: z.string().min(1).max(256),
        successUrl: urlSchema,
        cancelUrl: urlSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = input.tenant ?? ctx.tenantId;
      if (input.tenant && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      try {
        assertSafeRedirectUrl(input.successUrl);
        assertSafeRedirectUrl(input.cancelUrl);
      } catch {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid redirect URL" });
      }
      const { processor } = deps();
      const session = await processor.createCheckoutSession({
        tenant,
        priceId: input.priceId,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      });
      return { url: session.url, sessionId: session.id };
    }),

  /** Create a PayRam crypto payment session. */
  cryptoCheckout: tenantProcedure
    .input(
      z.object({
        amountUsd: z.number().min(MIN_PAYMENT_USD).max(10000),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId;
      const { payramClient, payramChargeRepo } = deps();
      if (!payramClient || !payramChargeRepo) {
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: "Crypto payments not configured",
        });
      }
      const result = await createPayRamCheckout(payramClient, payramChargeRepo, {
        tenant,
        amountUsd: input.amountUsd,
      });
      return { url: result.url, referenceId: result.referenceId };
    }),

  /** Create a Stripe Customer Portal session. */
  portalSession: tenantProcedure
    .input(z.object({ tenant: tenantIdSchema.optional(), returnUrl: urlSchema }))
    .mutation(async ({ input, ctx }) => {
      const tenant = input.tenant ?? ctx.tenantId;
      if (input.tenant && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      try {
        assertSafeRedirectUrl(input.returnUrl);
      } catch {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid redirect URL" });
      }
      const { processor } = deps();
      if (!processor.supportsPortal()) {
        return { url: null };
      }
      const session = await processor.createPortalSession({ tenant, returnUrl: input.returnUrl });
      return { url: session.url };
    }),

  /** Query current-period usage summaries. */
  usage: tenantProcedure
    .input(
      z.object({
        tenant: tenantIdSchema.optional(),
        capability: identifierSchema.optional(),
        provider: identifierSchema.optional(),
        startDate: z.number().int().positive().optional(),
        endDate: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const { meterAggregator } = deps();
      const tenant = input.tenant ?? ctx.tenantId;
      if (input.tenant && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }

      let summaries = await meterAggregator.querySummaries(tenant, {
        since: input.startDate,
        until: input.endDate,
        limit: input.limit,
      });

      if (input.capability) {
        summaries = summaries.filter((s) => s.capability === input.capability);
      }
      if (input.provider) {
        summaries = summaries.filter((s) => s.provider === input.provider);
      }

      return { tenant, usage: summaries };
    }),

  /** Get total spend for current or specified period. */
  usageSummary: tenantProcedure
    .input(
      z.object({
        tenant: tenantIdSchema.optional(),
        startDate: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const { meterAggregator } = deps();
      const tenant = input.tenant ?? ctx.tenantId;
      if (input.tenant && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }

      const since = input.startDate ?? Math.floor(Date.now() / 3_600_000) * 3_600_000;
      const total = await meterAggregator.getTenantTotal(tenant, since);

      return {
        tenant,
        period_start: since,
        total_cost: total.totalCost,
        total_charge: total.totalCharge,
        event_count: total.eventCount,
      };
    }),

  /** Get available subscription plans. */
  plans: protectedProcedure.query(() => {
    return [...PLAN_TIERS];
  }),

  /** Get current plan tier for the authenticated user. */
  currentPlan: tenantProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId;
    const { tenantRepo } = deps();
    const mapping = await tenantRepo.getByTenant(tenant);
    return { tier: (mapping?.tier ?? "free") as "free" | "starter" | "pro" | "enterprise" };
  }),

  /** Change subscription plan. */
  changePlan: tenantProcedure
    .input(z.object({ tier: z.enum(["free", "starter", "pro", "enterprise"]) }))
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId;
      const { tenantRepo } = deps();
      await tenantRepo.setTier(tenant, input.tier);
      return { tier: input.tier };
    }),

  /** Get inference mode (byok or hosted). */
  inferenceMode: tenantProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId;
    const { tenantRepo } = deps();
    const mode = await tenantRepo.getInferenceMode(tenant);
    return { mode: mode as "byok" | "hosted" };
  }),

  /** Set inference mode (byok or hosted). */
  setInferenceMode: tenantProcedure
    .input(z.object({ mode: z.enum(["byok", "hosted"]) }))
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId;
      const { tenantRepo } = deps();
      await tenantRepo.setInferenceMode(tenant, input.mode);
      return { mode: input.mode };
    }),

  /** Get provider cost estimates (BYOK users). */
  providerCosts: tenantProcedure.query(() => {
    return [] as Array<{
      provider: string;
      estimatedCost: number;
      inputTokens: number;
      outputTokens: number;
    }>;
  }),

  /** Get hosted usage summary for current billing period. */
  hostedUsageSummary: tenantProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId;
    const { meterAggregator, creditLedger } = deps();

    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);
    const since = periodStart.getTime();

    const summaries = await meterAggregator.querySummaries(tenant, { since, limit: 1000 });

    const capMap = new Map<string, { units: number; cost: number }>();
    for (const s of summaries) {
      const existing = capMap.get(s.capability) ?? { units: 0, cost: 0 };
      existing.units += s.event_count;
      existing.cost += s.total_charge;
      capMap.set(s.capability, existing);
    }

    const capabilities = Array.from(capMap.entries()).map(([capability, data]) => ({
      capability,
      label: capability.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      units: data.units,
      unitLabel: "events",
      cost: data.cost,
    }));

    const totalCost = capabilities.reduce((sum, c) => sum + c.cost, 0);
    const balance = await creditLedger.balance(tenant);

    return {
      periodStart: periodStart.toISOString(),
      periodEnd: new Date().toISOString(),
      capabilities,
      totalCost,
      includedCredit: balance.toCentsFloor(),
      amountDue: Math.max(0, totalCost - balance.toCentsFloor()),
    };
  }),

  /** Get hosted usage events (detailed breakdown). */
  hostedUsageEvents: tenantProcedure
    .input(
      z
        .object({
          capability: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const tenant = ctx.tenantId;
      const { meterAggregator } = deps();

      const since = input?.from ? new Date(input.from).getTime() : undefined;
      const until = input?.to ? new Date(input.to).getTime() : undefined;

      let summaries = await meterAggregator.querySummaries(tenant, {
        since,
        until,
        limit: 500,
      });

      if (input?.capability) {
        summaries = summaries.filter((s) => s.capability === input.capability);
      }

      return summaries.map((s) => ({
        id: `${s.tenant}-${s.capability}-${s.window_start}`,
        date: new Date(s.window_start).toISOString(),
        capability: s.capability,
        provider: s.provider,
        units: s.event_count,
        unitLabel: "events",
        cost: s.total_charge,
      }));
    }),

  /** Get spending limits configuration. */
  spendingLimits: tenantProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId;
    const { spendingLimitsRepo } = deps();
    return await spendingLimitsRepo.get(tenant);
  }),

  /** Update spending limits. */
  updateSpendingLimits: tenantProcedure
    .input(
      z.object({
        global: z.object({
          alertAt: z.number().nonnegative().nullable(),
          hardCap: z.number().nonnegative().nullable(),
        }),
        perCapability: z.record(
          z.string(),
          z.object({
            alertAt: z.number().nonnegative().nullable(),
            hardCap: z.number().nonnegative().nullable(),
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId;
      const { spendingLimitsRepo } = deps();
      await spendingLimitsRepo.upsert(tenant, input);
      return await spendingLimitsRepo.get(tenant);
    }),

  /** Get billing info (payment methods, invoices, email). */
  billingInfo: tenantProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId;
    const { processor } = deps();

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
        email: await processor.getCustomerEmail(tenant),
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
      return {
        email: "",
        paymentMethods: [],
        invoices: [],
      };
    }
  }),

  /** Update billing email. */
  updateBillingEmail: tenantProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId;
      const { tenantRepo, processor } = deps();
      const mapping = await tenantRepo.getByTenant(tenant);

      if (!mapping) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No billing account found" });
      }

      await processor.updateCustomerEmail(tenant, input.email);
      return { email: input.email };
    }),

  /** Remove a payment method. */
  removePaymentMethod: tenantProcedure.input(z.object({ id: z.string().min(1) })).mutation(async ({ input, ctx }) => {
    const tenant = ctx.tenantId;
    const { processor, creditLedger, tenantRepo } = deps();

    const { PaymentMethodOwnershipError } = await import("@wopr-network/platform-core/billing");

    const mapping = await tenantRepo.getByTenant(tenant);
    if (mapping) {
      const paymentMethods = await processor.listPaymentMethods(tenant);
      if (paymentMethods.length <= 1) {
        const hasBillingHold = mapping.billing_hold === 1;
        const hasOutstandingBalance = (await creditLedger.balance(tenant)).isNegative();
        if (hasBillingHold || hasOutstandingBalance) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cannot remove last payment method with active billing hold or outstanding balance",
          });
        }
      }
    }

    try {
      await processor.detachPaymentMethod(tenant, input.id);
      return { removed: true };
    } catch (err) {
      if (err instanceof PaymentMethodOwnershipError) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Payment method does not belong to this account" });
      }
      logger.error("billing.removePaymentMethod failed", {
        error: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to remove payment method. Please try again.",
      });
    }
  }),

  /** Get auto-topup settings for the authenticated tenant. */
  autoTopupSettings: tenantProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId;
    const { autoTopupSettingsStore, processor } = deps();

    const settings = await autoTopupSettingsStore.getByTenant(tenant);

    let paymentMethodLast4: string | null = null;
    try {
      const methods = await processor.listPaymentMethods(tenant);
      const first = methods[0];
      if (first) {
        paymentMethodLast4 = first.label.match(/\d{4}$/)?.[0] ?? null;
      }
    } catch {
      // Processor call failed — return null for last4
    }

    return {
      usage_enabled: settings?.usageEnabled ?? false,
      usage_threshold_cents: settings?.usageThreshold.toCents() ?? 500,
      usage_topup_cents: settings?.usageTopup.toCents() ?? 2000,
      schedule_enabled: settings?.scheduleEnabled ?? false,
      schedule_amount_cents: settings?.scheduleAmount?.toCents() ?? null,
      schedule_next_at: settings?.scheduleNextAt ?? null,
      schedule_interval_hours: settings?.scheduleIntervalHours ?? 168,
      payment_method_last4: paymentMethodLast4,
    };
  }),

  /** Update auto-topup settings. */
  updateAutoTopupSettings: tenantProcedure
    .input(
      z.object({
        usage_enabled: z.boolean().optional(),
        usage_threshold_cents: z
          .number()
          .int()
          .refine((v) => (ALLOWED_THRESHOLDS as readonly number[]).includes(v), {
            message: `Must be one of: ${ALLOWED_THRESHOLDS.join(", ")}`,
          })
          .optional(),
        usage_topup_cents: z
          .number()
          .int()
          .refine((v) => (ALLOWED_TOPUP_AMOUNTS as readonly number[]).includes(v), {
            message: `Must be one of: ${ALLOWED_TOPUP_AMOUNTS.join(", ")}`,
          })
          .optional(),
        schedule_enabled: z.boolean().optional(),
        schedule_interval: z.enum(ALLOWED_SCHEDULE_INTERVALS).nullable().optional(),
        schedule_amount_cents: z
          .number()
          .int()
          .refine((v) => (ALLOWED_TOPUP_AMOUNTS as readonly number[]).includes(v), {
            message: `Must be one of: ${ALLOWED_TOPUP_AMOUNTS.join(", ")}`,
          })
          .nullable()
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId;
      const { autoTopupSettingsStore, processor, auditLogger } = deps();

      const enablingUsage = input.usage_enabled === true;
      const enablingSchedule = input.schedule_enabled === true;

      if (enablingUsage || enablingSchedule) {
        const methods = await processor.listPaymentMethods(tenant);
        if (methods.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "No payment method on file. Please add a payment method first.",
          });
        }
      }

      const previous = await autoTopupSettingsStore.getByTenant(tenant);

      let scheduleNextAt: string | null | undefined;
      if (input.schedule_enabled === true && input.schedule_interval) {
        scheduleNextAt = computeNextScheduleAt(input.schedule_interval);
      } else if (input.schedule_interval === null) {
        scheduleNextAt = null;
      } else if (input.schedule_enabled === false) {
        scheduleNextAt = null;
      }

      await autoTopupSettingsStore.upsert(tenant, {
        usageEnabled: input.usage_enabled,
        usageThreshold: input.usage_threshold_cents != null ? Credit.fromCents(input.usage_threshold_cents) : undefined,
        usageTopup: input.usage_topup_cents != null ? Credit.fromCents(input.usage_topup_cents) : undefined,
        scheduleEnabled: input.schedule_enabled,
        scheduleAmount: input.schedule_amount_cents != null ? Credit.fromCents(input.schedule_amount_cents) : undefined,
        scheduleIntervalHours: input.schedule_interval ? SCHEDULE_INTERVAL_HOURS[input.schedule_interval] : undefined,
        scheduleNextAt: scheduleNextAt,
      });

      const updated = await autoTopupSettingsStore.getByTenant(tenant);

      if (auditLogger) {
        try {
          const snapshotSettings = (s: typeof previous) =>
            s
              ? {
                  usage_enabled: s.usageEnabled,
                  usage_threshold_cents: s.usageThreshold.toCents(),
                  usage_topup_cents: s.usageTopup.toCents(),
                  schedule_enabled: s.scheduleEnabled,
                  schedule_amount_cents: s.scheduleAmount.toCents(),
                  schedule_interval_hours: s.scheduleIntervalHours,
                  schedule_next_at: s.scheduleNextAt,
                }
              : null;

          await auditLogger.log({
            userId: ctx.user.id,
            authMethod: "session",
            action: "billing.auto_topup_update",
            resourceType: "billing",
            resourceId: tenant,
            details: {
              previous: snapshotSettings(previous),
              new: snapshotSettings(updated),
            },
          });
        } catch {
          // Audit logging must never break billing operations
        }
      }

      return {
        usage_enabled: updated?.usageEnabled ?? false,
        usage_threshold_cents: updated?.usageThreshold.toCents() ?? 500,
        usage_topup_cents: updated?.usageTopup.toCents() ?? 2000,
        schedule_enabled: updated?.scheduleEnabled ?? false,
        schedule_amount_cents: updated?.scheduleAmount?.toCents() ?? null,
        schedule_next_at: updated?.scheduleNextAt ?? null,
        schedule_interval_hours: updated?.scheduleIntervalHours ?? 168,
        payment_method_last4: null,
      };
    }),

  /** Get current dividend pool stats and user eligibility. */
  dividendStats: tenantProcedure
    .input(z.object({ tenant: tenantIdSchema.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const tenant = input?.tenant ?? ctx.tenantId;
      if (input?.tenant && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { dividendRepo } = deps();
      const stats = await dividendRepo.getStats(tenant);
      return {
        pool_cents: stats.pool.toCents(),
        active_users: stats.activeUsers,
        per_user_cents: stats.perUser.toCents(),
        next_distribution_at: stats.nextDistributionAt,
        user_eligible: stats.userEligible,
        user_last_purchase_at: stats.userLastPurchaseAt,
        user_window_expires_at: stats.userWindowExpiresAt,
      };
    }),

  /** Get paginated dividend history for the authenticated user. */
  dividendHistory: tenantProcedure
    .input(
      z
        .object({
          tenant: tenantIdSchema.optional(),
          limit: z.number().int().positive().max(250).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const tenant = input?.tenant ?? ctx.tenantId;
      if (input?.tenant && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { dividendRepo } = deps();
      const dividends = await dividendRepo.getHistory(tenant, input?.limit ?? 50, input?.offset ?? 0);
      return { dividends };
    }),

  /** Get lifetime total dividend credits for the authenticated user. */
  dividendLifetime: tenantProcedure
    .input(z.object({ tenant: tenantIdSchema.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const tenant = input?.tenant ?? ctx.tenantId;
      if (input?.tenant && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { dividendRepo } = deps();
      const total = await dividendRepo.getLifetimeTotal(tenant);
      return { total_cents: total.toCents(), tenant };
    }),

  /** Get affiliate code, link, and stats for the authenticated user. */
  affiliateInfo: tenantProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId;
    const { affiliateRepo } = deps();
    return await affiliateRepo.getStats(tenant);
  }),

  /** Record a referral attribution. */
  affiliateRecordReferral: tenantProcedure
    .input(
      z.object({
        code: z
          .string()
          .min(1)
          .max(10)
          .regex(/^[a-z0-9]+$/),
        referredTenantId: tenantIdSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const callerTenant = ctx.tenantId;
      if (input.referredTenantId !== callerTenant) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot record referral for another tenant",
        });
      }
      const { affiliateRepo } = deps();
      const codeRecord = await affiliateRepo.getByCode(input.code);
      if (!codeRecord) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invalid referral code" });
      }

      if (codeRecord.tenantId === input.referredTenantId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Self-referral is not allowed" });
      }

      const isNew = await affiliateRepo.recordReferral(codeRecord.tenantId, input.referredTenantId, input.code, {});
      return { recorded: isNew, referrer: codeRecord.tenantId };
    }),

  /** Get per-member credit usage breakdown for an org. */
  memberUsage: tenantProcedure
    .input(z.object({ tenant: tenantIdSchema.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const tenant = input?.tenant ?? ctx.tenantId;
      if (input?.tenant && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { creditLedger } = deps();
      const members = await creditLedger.memberUsage(tenant);
      return { tenant, members };
    }),

  /** Apply a coupon code to grant promotion credits. */
  applyCoupon: tenantProcedure.input(z.object({ code: z.string().min(1).max(50) })).mutation(async ({ input, ctx }) => {
    const { promotionEngine } = deps();
    if (!promotionEngine) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Promotion engine not initialized" });
    }
    const tenantId = ctx.tenantId;
    let results: Awaited<ReturnType<typeof promotionEngine.evaluateAndGrant>>;
    try {
      results = await promotionEngine.evaluateAndGrant({
        tenantId,
        trigger: "coupon_redeem",
        couponCode: input.code.toUpperCase().trim(),
      });
    } catch (err) {
      logger.error("billing.applyCoupon failed", {
        error: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired coupon code" });
    }
    if (results.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid, expired, or already-used coupon code" });
    }
    const totalCredits = results.reduce((sum, r) => sum + r.creditsGranted.toCents(), 0);
    return {
      creditsGranted: totalCredits,
      message: `${totalCredits} credits granted`,
    };
  }),
});
