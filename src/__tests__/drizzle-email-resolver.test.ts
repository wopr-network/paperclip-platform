import type { PgDatabase } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleBetterAuthEmailResolver } from "../services/drizzle-email-resolver.js";

function createMockDb() {
  return { execute: vi.fn() } as unknown as PgDatabase<never> & { execute: ReturnType<typeof vi.fn> };
}

describe("DrizzleBetterAuthEmailResolver", () => {
  let db: ReturnType<typeof createMockDb>;
  let resolver: DrizzleBetterAuthEmailResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    resolver = new DrizzleBetterAuthEmailResolver(db);
  });

  it("returns email when user found by direct ID lookup", async () => {
    db.execute.mockResolvedValueOnce({ rows: [{ email: "alice@acme.com" }] });

    const email = await resolver.resolveEmail("user-1");

    expect(email).toBe("alice@acme.com");
    // Should only call once — no fallback needed
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("falls back to org owner when direct lookup returns no rows", async () => {
    // First call: direct user lookup — no rows
    db.execute.mockResolvedValueOnce({ rows: [] });
    // Second call: org owner lookup — found
    db.execute.mockResolvedValueOnce({ rows: [{ email: "owner@acme.com" }] });

    const email = await resolver.resolveEmail("org-1");

    expect(email).toBe("owner@acme.com");
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("returns null when neither lookup finds a match", async () => {
    db.execute.mockResolvedValueOnce({ rows: [] });
    db.execute.mockResolvedValueOnce({ rows: [] });

    const email = await resolver.resolveEmail("unknown-id");

    expect(email).toBeNull();
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("returns null on DB error (catch block)", async () => {
    db.execute.mockRejectedValueOnce(new Error("connection refused"));

    const email = await resolver.resolveEmail("user-1");

    expect(email).toBeNull();
  });

  it("returns null when first query succeeds empty and second throws", async () => {
    db.execute.mockResolvedValueOnce({ rows: [] });
    db.execute.mockRejectedValueOnce(new Error("query timeout"));

    const email = await resolver.resolveEmail("org-1");

    expect(email).toBeNull();
  });
});
