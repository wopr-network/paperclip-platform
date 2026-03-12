/**
 * tRPC settings router — tenant config, preferences.
 *
 * Adapted from wopr-platform for Paperclip Platform.
 */

import { TRPCError } from "@trpc/server";
import type { INotificationPreferencesRepository } from "@wopr-network/platform-core/email";
import { publicProcedure, router, tenantProcedure } from "@wopr-network/platform-core/trpc";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SettingsRouterDeps {
  getNotificationPrefsStore: () => INotificationPreferencesRepository;
  testProvider?: (provider: string, tenantId: string) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
}

let _deps: SettingsRouterDeps | null = null;

export function setSettingsRouterDeps(deps: SettingsRouterDeps): void {
  _deps = deps;
}

function deps(): SettingsRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Settings not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const settingsRouter = router({
  /** Health check — publicly accessible. */
  health: publicProcedure.query(() => {
    return { status: "ok" as const, service: "paperclip-platform" };
  }),

  /** Get tenant configuration summary. */
  tenantConfig: tenantProcedure.query(({ ctx }) => {
    return {
      tenantId: ctx.tenantId,
      configured: true,
    };
  }),

  /** Ping — verify auth and tenant context. */
  ping: tenantProcedure.query(({ ctx }) => {
    return {
      ok: true as const,
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      timestamp: Date.now(),
    };
  }),

  /** Get notification preferences for the authenticated tenant. */
  notificationPreferences: tenantProcedure.query(({ ctx }) => {
    const store = deps().getNotificationPrefsStore();
    return store.get(ctx.tenantId);
  }),

  /** Test connectivity to a provider. */
  testProvider: tenantProcedure
    .input(z.object({ provider: z.string().min(1).max(64) }))
    .mutation(async ({ input, ctx }) => {
      const testFn = deps().testProvider;
      if (!testFn) {
        return { ok: false as const, error: "Provider testing not configured" };
      }
      return testFn(input.provider, ctx.tenantId);
    }),

  /** Update notification preferences for the authenticated tenant. */
  updateNotificationPreferences: tenantProcedure
    .input(
      z.object({
        billing_low_balance: z.boolean().optional(),
        billing_receipts: z.boolean().optional(),
        billing_auto_topup: z.boolean().optional(),
        agent_channel_disconnect: z.boolean().optional(),
        agent_status_changes: z.boolean().optional(),
        account_role_changes: z.boolean().optional(),
        account_team_invites: z.boolean().optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const store = deps().getNotificationPrefsStore();
      store.update(ctx.tenantId, input);
      return store.get(ctx.tenantId);
    }),
});
