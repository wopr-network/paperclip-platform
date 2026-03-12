/**
 * tRPC page-context router — stores and retrieves per-user page context.
 *
 * Copied from wopr-platform — pure platform-core imports.
 */

import { TRPCError } from "@trpc/server";
import type { IPageContextRepository } from "@wopr-network/platform-core/fleet/page-context-repository";
import { protectedProcedure, router } from "@wopr-network/platform-core/trpc";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface PageContextRouterDeps {
  repo: IPageContextRepository;
}

let _deps: PageContextRouterDeps | null = null;

export function setPageContextRouterDeps(deps: PageContextRouterDeps): void {
  _deps = deps;
}

function deps(): PageContextRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Page context not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const updatePageContextSchema = z.object({
  currentPage: z.string().min(1).max(500),
  pagePrompt: z.string().max(2000).nullable(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const pageContextRouter = router({
  /** Update the page context for the current user. Called on route change. */
  update: protectedProcedure.input(updatePageContextSchema).mutation(async ({ ctx, input }) => {
    await deps().repo.set(ctx.user.id, input.currentPage, input.pagePrompt);
    return { ok: true as const };
  }),

  /** Get the current page context for the authenticated user. */
  current: protectedProcedure.query(async ({ ctx }) => {
    const pc = await deps().repo.get(ctx.user.id);
    if (!pc) return null;
    return { currentPage: pc.currentPage, pagePrompt: pc.pagePrompt };
  }),
});
