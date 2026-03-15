# paperclip-platform

Hono API server for Paperclip AI. Fleet management, billing, auth, metered inference gateway, crypto payments.

## Commands

```bash
pnpm dev         # tsx watch src/index.ts
pnpm build       # tsc
pnpm test        # vitest
npm run check    # biome check + tsc --noEmit (run before committing)
```

**Linter/formatter is Biome.** Run `npx biome check --write <file>` to fix. Import ordering: external → parent → sibling.

## Architecture

```
src/
  index.ts              # Boot sequence: DB → auth → gateway → tRPC → crypto → serve()
  app.ts                # Hono app (routes, middleware)
  config.ts             # getConfig() — env vars
  log.ts                # pino logger
  crypto/
    init-watchers.ts    # Crypto watcher startup loop (auto-discovers payment methods from DB)
  db/
    index.ts            # Drizzle DB + Pool
    migrate.ts          # Runs platform-core migrations on startup
  fleet/                # Docker fleet management (create/destroy/health)
  middleware/           # Auth, CORS, CSP
  proxy/                # Caddy reverse proxy sync
  routes/
    crypto-webhook.ts   # POST /api/webhooks/crypto (BTCPay webhook)
  trpc/
    index.ts            # Root appRouter (composes all sub-routers)
    routers/
      billing.ts        # Credits, checkout, Stripe, crypto, payment methods
      fleet.ts          # Instance CRUD
      org.ts            # Organizations
      profile.ts        # User profile
      settings.ts       # Notification preferences
      page-context.ts   # Bot page context
```

## Crypto Payment Stack

**Watcher startup loop** (`src/crypto/init-watchers.ts`):
- Reads enabled payment methods from `payment_methods` table every 60s
- Creates EVM/ETH/BTC watchers dynamically, wires `onPayment` → settler
- Refreshes watched deposit addresses from active charges every 15s (poll cycle)
- Supports hot-add: new payment method via admin panel → watcher appears on next refresh

**Payment method config (all in DB, no env vars):**
- `rpc_url` — chain node endpoint
- `oracle_address` — Chainlink price feed
- `xpub` — HD wallet public key
- `contract_address` — ERC-20 contract
- `confirmations` — required block confirmations

**Admin endpoints** use `adminProcedure` (platform_admin role required) + audit logging.

## Boot Sequence (Critical)

All route-adding work MUST happen before `serve()`. Hono builds its route matcher lazily on first request. If you add routes after serve starts, you get: `"Can not add a route since the matcher is already built."`

Order: DB → migrations → auth → gateway → tRPC → crypto webhook → crypto watchers → serve()

## Key Dependencies

- `@wopr-network/platform-core` — shared DB schema, auth, billing, fleet, crypto watchers/settlers
- `@hono/node-server` — HTTP server
- `@trpc/server` — tRPC router
- `stripe` — payment processing
- `@sentry/node` — required by platform-core observability module

## Gotchas

- **Drizzle migrations from platform-core** — `src/db/migrate.ts` resolves migration folder from the npm package. Migrations run on every startup (idempotent).
- **Migration timestamps must be monotonic** — Drizzle uses `max(created_at)` to determine applied migrations. Non-monotonic = skipped migrations.
- **`@sentry/node` required** — platform-core 1.28+ imports it. Missing = crash on startup.
- **Deposit addresses stored lowercase** — `createStablecoinCharge` lowercases. Settlers lookup lowercase. Never store checksummed.
- **BTC `rpc_url` format** — `http://user:pass@host:port`. Credentials parsed from URL.
- **`createFleetUpdateConfigRouter` takes a lazy getter** — pass `() => getTenantUpdateConfigRepo()`, not the called result.
- **`docker compose restart` does NOT rebuild** — use `docker compose up -d --build --no-deps platform` after code changes.

## Sweep Script

`wopr-ops/scripts/sweep-stablecoins.ts` — sweeps deposited funds to treasury.

**3-phase ETH-first protocol:**
1. Sweep ETH deposits → treasury gets ETH (self-funded gas)
2. Fund gas from treasury → each ERC-20 deposit gets ~65k gas worth of ETH
3. Sweep ERC-20s → all tokens swept to treasury

**Why ETH-first:** Empty treasury can't fund gas for ERC-20 sweeps. ETH deposits self-fund their own sweep gas.

**Mnemonic handling:** Piped via stdin from encrypted file. NEVER as CLI arg, NEVER in env vars.

```bash
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -d \
  -pass pass:<passphrase> -in "/mnt/g/My Drive/paperclip-wallet.enc" \
  | EVM_RPC_BASE=http://localhost:8545 SWEEP_DRY_RUN=false npx tsx ~/wopr-ops/scripts/sweep-stablecoins.ts
```

**Adding new ERC-20 to sweep:** Add the token's contract address + decimals to the sweep script's token list.

**BTC sweep:** Manual via wallet software (Electrum). Not automated.

**UTXO sweep is different:** Don't extend the EVM sweep script for BTC/LTC — UTXO chains construct raw transactions, not ERC-20 `transfer()` calls.

## Version Control

Use `git` (no jj in this repo).
