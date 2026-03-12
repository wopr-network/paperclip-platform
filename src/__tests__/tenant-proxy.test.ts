import { afterAll, describe, expect, it, vi } from "vitest";

// Stub env before importing modules that read config
vi.stubEnv("PROVISION_SECRET", "test-secret");
vi.stubEnv("GATEWAY_URL", "https://gateway.test/v1");
vi.stubEnv("PLATFORM_DOMAIN", "runpaperclip.com");

import { buildUpstreamHeaders, extractTenantSubdomain } from "../proxy/tenant-proxy.js";

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("extractTenantSubdomain", () => {
  it("extracts valid subdomain", () => {
    expect(extractTenantSubdomain("alice.runpaperclip.com")).toBe("alice");
  });

  it("returns null for root domain", () => {
    expect(extractTenantSubdomain("runpaperclip.com")).toBeNull();
  });

  it("returns null for reserved subdomains", () => {
    expect(extractTenantSubdomain("app.runpaperclip.com")).toBeNull();
    expect(extractTenantSubdomain("admin.runpaperclip.com")).toBeNull();
    expect(extractTenantSubdomain("www.runpaperclip.com")).toBeNull();
  });

  it("returns null for wrong domain", () => {
    expect(extractTenantSubdomain("alice.evil.com")).toBeNull();
  });

  it("returns null for sub-sub-domains", () => {
    expect(extractTenantSubdomain("a.b.runpaperclip.com")).toBeNull();
  });

  it("strips port", () => {
    expect(extractTenantSubdomain("alice.runpaperclip.com:3200")).toBe("alice");
  });

  it("rejects invalid DNS labels", () => {
    expect(extractTenantSubdomain("-bad.runpaperclip.com")).toBeNull();
    expect(extractTenantSubdomain("bad-.runpaperclip.com")).toBeNull();
  });
});

describe("buildUpstreamHeaders", () => {
  it("forwards allowlisted headers and injects platform headers", () => {
    const incoming = new Headers({
      "content-type": "application/json",
      authorization: "Bearer secret-that-should-not-leak",
      "x-request-id": "req-123",
    });

    const result = buildUpstreamHeaders(incoming, "user-1", "alice");

    expect(result.get("content-type")).toBe("application/json");
    expect(result.get("x-request-id")).toBe("req-123");
    expect(result.get("x-paperclip-user-id")).toBe("user-1");
    expect(result.get("x-paperclip-tenant")).toBe("alice");
    // Authorization must NOT be forwarded
    expect(result.get("authorization")).toBeNull();
  });
});
