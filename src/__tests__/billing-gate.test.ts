import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stubs
vi.stubEnv("PROVISION_SECRET", "test-secret");
vi.stubEnv("GATEWAY_URL", "https://gateway.test/v1");
vi.stubEnv("PLATFORM_DOMAIN", "runpaperclip.ai");
vi.stubEnv("MAX_INSTANCES_PER_TENANT", "3");

const mockBalance = vi.fn();
const mockProfileStoreList = vi.fn();
const mockFleetCreate = vi.fn();
const mockFleetStart = vi.fn();
let ledgerEnabled = true;

vi.mock("../fleet/services.js", () => ({
  getCreditLedger: () => (ledgerEnabled ? { balance: mockBalance } : null),
  getFleetManager: () => ({ create: mockFleetCreate, start: mockFleetStart }),
  getProfileStore: () => ({ list: mockProfileStoreList }),
  getDocker: () => ({}),
  getProxyManager: () => ({ getRoutes: () => [] }),
}));

vi.mock("../proxy/fleet-resolver.js", () => ({
  registerRoute: vi.fn(),
  removeRoute: vi.fn(),
}));

vi.mock("@wopr-network/provision-client", () => ({
  provisionContainer: vi.fn().mockResolvedValue({ tenantEntityId: "e1", tenantSlug: "TST" }),
  checkHealth: vi.fn().mockResolvedValue(true),
}));

vi.mock("../log.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { provisionWebhookRoutes } = await import("../routes/provision-webhook.js");

function createApp() {
  const app = new Hono();
  app.route("/api/provision", provisionWebhookRoutes);
  return app;
}

function createRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/provision/create", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-secret",
    },
    body: JSON.stringify(body),
  });
}

describe("billing gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfileStoreList.mockResolvedValue([]);
  });

  it("returns 402 when tenant has zero credit balance", async () => {
    mockBalance.mockResolvedValue({ isZero: () => true, isNegative: () => false });

    const app = createApp();
    const res = await app.request(createRequest({ tenantId: "t1", subdomain: "acme" }));

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toContain("Insufficient credits");
  });

  it("returns 402 when tenant has negative credit balance", async () => {
    mockBalance.mockResolvedValue({ isZero: () => false, isNegative: () => true });

    const app = createApp();
    const res = await app.request(createRequest({ tenantId: "t1", subdomain: "acme" }));

    expect(res.status).toBe(402);
  });

  it("returns 403 when tenant has reached instance limit", async () => {
    mockBalance.mockResolvedValue({ isZero: () => false, isNegative: () => false });
    mockProfileStoreList.mockResolvedValue([
      { name: "a", tenantId: "t1" },
      { name: "b", tenantId: "t1" },
      { name: "c", tenantId: "t1" },
    ]);

    const app = createApp();
    const res = await app.request(createRequest({ tenantId: "t1", subdomain: "newone" }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Instance limit reached");
    expect(body.error).toContain("3");
  });

  it("allows creation when balance is positive and under instance limit", async () => {
    mockBalance.mockResolvedValue({ isZero: () => false, isNegative: () => false });
    mockProfileStoreList.mockResolvedValue([{ name: "existing", tenantId: "t1" }]);
    mockFleetCreate.mockResolvedValue({ id: "inst-1" });
    mockFleetStart.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request(createRequest({ tenantId: "t1", subdomain: "acme" }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.instanceId).toBe("inst-1");
  });

  it("does not count other tenants' instances toward limit", async () => {
    mockBalance.mockResolvedValue({ isZero: () => false, isNegative: () => false });
    mockProfileStoreList.mockResolvedValue([
      { name: "a", tenantId: "t1" },
      { name: "b", tenantId: "t1" },
      { name: "c", tenantId: "other-tenant" },
      { name: "d", tenantId: "other-tenant" },
    ]);
    mockFleetCreate.mockResolvedValue({ id: "inst-2" });
    mockFleetStart.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request(createRequest({ tenantId: "t1", subdomain: "newone" }));

    // t1 has 2 instances, limit is 3 — should be allowed
    expect(res.status).toBe(201);
  });
});

describe("billing gate — ledger not configured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ledgerEnabled = false;
  });

  afterEach(() => {
    ledgerEnabled = true;
  });

  it("skips balance check when no credit ledger is set", async () => {
    mockProfileStoreList.mockResolvedValue([]);
    mockFleetCreate.mockResolvedValue({ id: "inst-3" });
    mockFleetStart.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request(createRequest({ tenantId: "t1", subdomain: "acme" }));

    expect(res.status).toBe(201);
    expect(mockBalance).not.toHaveBeenCalled();
  });
});
