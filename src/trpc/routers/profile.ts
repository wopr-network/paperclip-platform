/**
 * tRPC profile router — get/update user profile and change password.
 *
 * Copied from wopr-platform — no changes needed, pure platform-core imports.
 */

import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "@wopr-network/platform-core/trpc";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface ProfileRouterDeps {
  getUser: (
    userId: string,
  ) => Promise<{ id: string; name: string; email: string; image: string | null; twoFactorEnabled: boolean } | null>;
  updateUser: (
    userId: string,
    data: { name?: string; image?: string | null },
  ) => Promise<{ id: string; name: string; email: string; image: string | null; twoFactorEnabled: boolean }>;
  changePassword: (userId: string, currentPassword: string, newPassword: string) => Promise<boolean>;
}

let _deps: ProfileRouterDeps | null = null;

export function setProfileRouterDeps(deps: ProfileRouterDeps): void {
  _deps = deps;
}

function deps(): ProfileRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Profile router not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const profileRouter = router({
  /** Get the authenticated user's profile. */
  getProfile: protectedProcedure.query(async ({ ctx }) => {
    const user = await deps().getUser(ctx.user.id);
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    }
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      twoFactorEnabled: user.twoFactorEnabled,
    };
  }),

  /** Update the authenticated user's display name and/or avatar. */
  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(128).optional(),
        image: z.string().url().max(2048).nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const updated = await deps().updateUser(ctx.user.id, {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.image !== undefined && { image: input.image }),
      });
      return {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        image: updated.image,
        twoFactorEnabled: updated.twoFactorEnabled,
      };
    }),

  /** Change the authenticated user's password. */
  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8, "Password must be at least 8 characters"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const ok = await deps().changePassword(ctx.user.id, input.currentPassword, input.newPassword);
      if (!ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Current password is incorrect" });
      }
      return { ok: true as const };
    }),
});
