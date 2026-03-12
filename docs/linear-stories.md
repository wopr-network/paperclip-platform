# Paperclip Platform — Linear Stories

**Project:** Paperclip Platform
**Team:** WOPR

---

## 1. Paperclip Docker Image
**Priority:** Urgent
**Labels:** infra, docker
**State:** Todo

**Repo:** wopr-network/paperclip-platform

Create a production Dockerfile for the Paperclip AI server image (`ghcr.io/paperclipai/server:latest`). This is the image that FleetManager pulls when spinning up new instances.

### Acceptance Criteria
- Dockerfile builds a minimal Node.js image with the Paperclip server
- Exposes port 3100 (configurable via `PORT` env var)
- Includes `/internal/provision` endpoint (provision-server)
- Health check endpoint at `/health` returns `{ ok: true, provisioning: true }`
- Image published to GHCR with CI

---

## 2. Docker Compose for Local Development
**Priority:** High
**Labels:** infra, dx
**State:** Todo

**Repo:** wopr-network/paperclip-platform

Create a `docker-compose.yml` for local development that runs paperclip-platform alongside one or more Paperclip containers on a shared Docker network.

### Acceptance Criteria
- Platform service builds from local source
- At least one Paperclip container for testing
- Shared bridge network so containers can reach each other by DNS name (`wopr-{name}`)
- Volume mounts for fleet data persistence
- `.env.example` with all required variables documented

---

## 3. Route Hydration on Restart
**Priority:** High
**Labels:** reliability, proxy
**State:** Todo

**Repo:** wopr-network/paperclip-platform

On platform startup, hydrate the ProxyManager route table from existing Docker containers. Currently routes are only registered during `/api/provision/create` — if the platform restarts, the route table is empty.

### Acceptance Criteria
- On startup, query Docker for all `wopr-*` containers
- Re-register proxy routes for each running container
- Run health checks and mark unhealthy containers accordingly
- Existing tests continue to pass

---

## 4. Tenant Ownership Check in Proxy
**Priority:** High
**Labels:** security, proxy
**State:** Todo

**Repo:** wopr-network/paperclip-platform

The tenant proxy middleware (`tenant-proxy.ts`) authenticates the user but doesn't verify that the user belongs to the tenant whose subdomain they're accessing. Add ownership verification.

### Acceptance Criteria
- After resolving userId, verify the user has access to the tenant subdomain
- Return 403 if the user doesn't belong to that tenant
- Define a tenant membership model (DB table or API call)
- Add tests for authorized and unauthorized access

---

## 5. Billing / Payment Gate
**Priority:** High
**Labels:** billing, feature
**State:** Todo

**Repo:** wopr-network/paperclip-platform

Gate instance creation behind a payment check. Integrate with Stripe (test mode keys already in wopr-platform `.env`). Prevent provisioning if the org has no active subscription or has exceeded their plan limits.

### Acceptance Criteria
- `/api/provision/create` checks billing status before creating a container
- Stripe subscription lookup by tenantId
- Plan limits: max instances per org, max budget per instance
- Return 402 with clear error when billing blocks creation
- Budget updates via `/api/provision/budget` respect plan limits

---

## 6. Admin Auth Middleware
**Priority:** Medium
**Labels:** security, admin
**State:** Todo

**Repo:** wopr-network/paperclip-platform

The admin routes (`/api/admin/*`) are currently unprotected. Add authentication middleware that restricts access to platform administrators.

### Acceptance Criteria
- Admin routes require a valid admin session or API key
- Non-admin users get 403
- Admin role defined in BetterAuth or a separate admin table
- Tests cover authorized and unauthorized admin access

---

## 7. Periodic Health Checks
**Priority:** Medium
**Labels:** reliability, monitoring
**State:** Todo

**Repo:** wopr-network/paperclip-platform

Run periodic health checks against all registered Paperclip containers and update route health status. Currently health is only checked at provision time.

### Acceptance Criteria
- Background interval (configurable, default 30s) polls all registered containers
- Uses `checkHealth()` from provision-client
- Updates `setRouteHealth()` for each container
- Unhealthy containers are excluded from proxy routing
- Log warnings for containers that become unhealthy
- Graceful shutdown stops the health check interval

---

## 8. Publish provision-server and provision-client Packages
**Priority:** Medium
**Labels:** packages, npm
**State:** Todo

**Repo:** wopr-network/provision-server, wopr-network/provision-client

Publish `@wopr-network/provision-server` and `@wopr-network/provision-client` to npm. Currently they're consumed via `file:` references. Publishing enables other platforms beyond Paperclip to use them.

### Acceptance Criteria
- Both packages published to npm under `@wopr-network` scope
- CI pipeline for build + publish on tag
- README with usage examples
- paperclip-platform updated to use npm versions instead of `file:` refs
- Semantic versioning starting at 1.0.0

---

## 9. Paperclip Fork Cleanup
**Priority:** Medium
**Labels:** paperclip, cleanup
**State:** Todo

**Repo:** paperclipai/server (fork)

The hosted Paperclip instances don't need the onboarding wizard or self-setup flows — provisioning handles all of that. Strip the Paperclip fork to the minimum needed for hosted operation.

### Acceptance Criteria
- Remove onboarding wizard UI
- Remove self-setup / first-run flows
- Ensure `/internal/provision` endpoint works with provision-server adapter
- Health endpoint returns `{ ok: true, provisioning: true }` when ready
- All Paperclip core functionality preserved (agents, chat, API)

---

## 10. DNS + Caddy Wildcard Configuration
**Priority:** Medium
**Labels:** infra, dns, proxy
**State:** Todo

**Repo:** wopr-network/paperclip-platform

Configure wildcard DNS (`*.runpaperclip.ai`) and Caddy reverse proxy so that `{subdomain}.runpaperclip.ai` routes to the correct Paperclip container via ProxyManager.

### Acceptance Criteria
- Wildcard DNS record for `*.runpaperclip.ai`
- Caddy configured with wildcard TLS (Let's Encrypt or Cloudflare DNS challenge)
- ProxyManager syncs route table to Caddy upstream config
- New subdomains work automatically after `registerRoute()`
- Document the DNS and Caddy setup

---

## 11. Dashboard UI for runpaperclip.ai
**Priority:** Low
**Labels:** frontend, feature
**State:** Todo

**Repo:** wopr-network/paperclip-platform-ui (new)

Build the management dashboard at `app.runpaperclip.ai` where users can create, manage, and monitor their Paperclip instances.

### Acceptance Criteria
- Next.js app with BetterAuth login
- Instance list showing status, subdomain, health
- "Create Instance" flow (calls `/api/provision/create`)
- "Destroy Instance" confirmation (calls `/api/provision/destroy`)
- Budget management per instance
- Links to `{subdomain}.runpaperclip.ai` for each instance

---

## 12. Multi-Node Scaling
**Priority:** Low
**Labels:** infra, scaling
**State:** Todo

**Repo:** wopr-network/paperclip-platform

Scale beyond a single Docker host. FleetManager currently manages containers on one machine. Add support for distributing containers across multiple nodes.

### Acceptance Criteria
- Node registry (list of Docker hosts)
- Placement strategy (round-robin, least-loaded, etc.)
- FleetManager routes create/start/stop to the correct node
- ProxyManager routes include the node's hostname
- Health checks work across nodes
- Migration path from single-node to multi-node

---

## Dependency Graph

```
1 (Docker Image) ← 2 (Docker Compose) ← 3 (Route Hydration)
1 ← 9 (Fork Cleanup)
1 ← 10 (DNS + Caddy)
4 (Tenant Ownership) ← 5 (Billing Gate)
6 (Admin Auth) — independent
7 (Health Checks) — depends on 1
8 (Publish Packages) — independent
10 ← 11 (Dashboard UI)
3 ← 12 (Multi-Node)
```

**Critical path:** 1 → 2 → 3 → 7 (get containers running and resilient first)
**Security path:** 4 → 5 → 6 (lock down access before going live)
**Ship path:** 8 + 9 + 10 → 11 (publish, clean up, DNS, then dashboard)
