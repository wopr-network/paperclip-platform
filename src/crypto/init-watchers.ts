import type {
  BtcPaymentEvent,
  DrizzleWatcherCursorStore,
  EthPaymentEvent,
  EvmPaymentEvent,
  ICryptoChargeRepository,
  IPaymentMethodStore,
  PaymentMethodRecord,
} from "@wopr-network/platform-core/billing";
import {
  BtcWatcher,
  ChainlinkOracle,
  createBitcoindRpc,
  createRpcCaller,
  EthWatcher,
  EvmWatcher,
  settleBtcPayment,
  settleEthPayment,
  settleEvmPayment,
} from "@wopr-network/platform-core/billing";
import type { ILedger } from "@wopr-network/platform-core/credits";
import type { DrizzleDb } from "@wopr-network/platform-core/db";
import { logger } from "../log.js";

const log = logger.child({ module: "crypto-watchers" });

export interface CryptoWatcherHandle {
  stop(): void;
}

export interface InitCryptoWatchersOpts {
  paymentMethodStore: IPaymentMethodStore;
  chargeStore: ICryptoChargeRepository;
  creditLedger: ILedger;
  cursorStore: DrizzleWatcherCursorStore;
  db: DrizzleDb;
  evmXpub?: string;
  /** EVM RPC URL for shared Chainlink oracle (reads price feeds for all native coins). */
  evmRpcUrl?: string;
  /** Poll interval for watchers (ms). Default: 15000. */
  pollIntervalMs?: number;
  /** How often to re-read DB for new/changed methods (ms). Default: 60000. */
  refreshIntervalMs?: number;
}

interface ActiveWatcher {
  id: string;
  poll: () => Promise<void>;
  setAddresses: (addresses: string[]) => void | Promise<void>;
  getCursor?: () => number;
}

/**
 * Start crypto watchers that auto-discover payment methods from DB.
 *
 * On each refresh cycle:
 * 1. Read enabled payment methods from DB
 * 2. For each unique (chain, type, token) combo, create a watcher if none exists
 *
 * On each poll cycle:
 * 1. Refresh watched addresses from active (uncredited) charges
 * 2. Poll all watchers for incoming payments
 * 3. On payment detected → settler → credit ledger
 *
 * Supports hot-add: add a payment method via admin panel → watcher appears
 * on next refresh cycle. No restart needed.
 */
export function initCryptoWatchers(opts: InitCryptoWatchersOpts): CryptoWatcherHandle {
  const {
    paymentMethodStore,
    chargeStore,
    creditLedger,
    cursorStore,
    db,
    pollIntervalMs = 15_000,
    refreshIntervalMs = 60_000,
  } = opts;

  // Shared Chainlink oracle for all native-coin watchers (ETH, BTC, LTC, DOGE, etc.)
  // Reads price feeds from Base/Ethereum — not from the coin's native chain.
  const sharedOracle = opts.evmRpcUrl ? new ChainlinkOracle({ rpcCall: createRpcCaller(opts.evmRpcUrl) }) : null;

  const watchers = new Map<string, ActiveWatcher>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const settlerDeps = { chargeStore, creditLedger };

  function makeWatcherId(method: PaymentMethodRecord): string {
    return `${method.type}:${method.chain}:${method.token}`;
  }

  async function createWatcher(method: PaymentMethodRecord): Promise<ActiveWatcher | null> {
    const rpcUrl = method.rpcUrl;
    if (!rpcUrl) {
      log.warn(`No rpc_url for ${method.id} — skipping watcher`);
      return null;
    }

    const rpcCall = createRpcCaller(rpcUrl);
    const watcherId = makeWatcherId(method);
    const chain = method.chain as import("@wopr-network/platform-core/billing").EvmChain;

    if (method.type === "erc20" && method.contractAddress) {
      const token = method.token as import("@wopr-network/platform-core/billing").StablecoinToken;
      const watcher = new EvmWatcher({
        chain,
        token,
        rpcCall,
        fromBlock: 0,
        cursorStore,
        onPayment: async (event: EvmPaymentEvent) => {
          log.info(`ERC-20 payment detected: ${event.token} ${event.txHash}`);
          const result = await settleEvmPayment(settlerDeps, event);
          log.info(`Settled ERC-20: ${result.status} (${result.creditedCents ?? 0}c)`);
        },
      });
      await watcher.init();
      log.info(`Created EVM watcher: ${watcherId} (cursor: ${watcher.cursor})`);
      return {
        id: watcherId,
        poll: () => watcher.poll(),
        setAddresses: (a) => watcher.setWatchedAddresses(a),
        getCursor: () => watcher.cursor,
      };
    }

    if (method.type === "native" && method.token.toUpperCase() === "ETH") {
      if (!sharedOracle) {
        log.warn("No EVM RPC for Chainlink oracle — skipping ETH watcher");
        return null;
      }
      const watcher = new EthWatcher({
        chain,
        rpcCall,
        oracle: sharedOracle,
        fromBlock: 0,
        cursorStore,
        onPayment: async (event: EthPaymentEvent) => {
          log.info(`ETH payment detected: ${event.txHash}`);
          const result = await settleEthPayment(settlerDeps, event);
          log.info(`Settled ETH: ${result.status} (${result.creditedCents ?? 0}c)`);
        },
      });
      await watcher.init();
      log.info(`Created ETH watcher: ${watcherId} (cursor: ${watcher.cursor})`);
      return {
        id: watcherId,
        poll: () => watcher.poll(),
        setAddresses: (a) => watcher.setWatchedAddresses(a),
      };
    }

    // UTXO chains: BTC, LTC, DOGE (all use bitcoind-compatible RPC API)
    const UTXO_CHAINS = ["bitcoin", "litecoin", "dogecoin"];
    if (method.type === "native" && UTXO_CHAINS.includes(method.chain)) {
      if (!sharedOracle) {
        log.warn(`No EVM RPC for Chainlink oracle — skipping ${method.token} watcher`);
        return null;
      }
      // Parse rpcUser:rpcPassword from URL: http://user:pass@host:port
      const parsed = new URL(rpcUrl);
      const rpcUser = decodeURIComponent(parsed.username);
      const rpcPassword = decodeURIComponent(parsed.password);
      if (!rpcUser || !rpcPassword) {
        log.warn(
          `${method.token} rpc_url must include credentials (http://user:pass@host:port) — skipping ${method.id}`,
        );
        return null;
      }
      parsed.username = "";
      parsed.password = "";
      const cleanUrl = parsed.toString().replace(/\/$/, "");

      const utxoConfig = {
        rpcUrl: cleanUrl,
        rpcUser,
        rpcPassword,
        network: "mainnet" as "mainnet" | "testnet" | "regtest",
        confirmations: method.confirmations,
      };
      const utxoRpc = createBitcoindRpc(utxoConfig);

      const watcher = new BtcWatcher({
        config: utxoConfig,
        rpcCall: utxoRpc,
        watchedAddresses: [],
        oracle: sharedOracle,
        cursorStore,
        onPayment: async (event: BtcPaymentEvent) => {
          log.info(`${method.token} payment detected: ${event.txid} (${event.amountSats} sats)`);
          const result = await settleBtcPayment(settlerDeps, event);
          log.info(`Settled ${method.token}: ${result.status} (${result.creditedCents ?? 0}c)`);
        },
      });
      // Track imported addresses so we only import new ones (importAddress is slow)
      const importedAddresses = new Set<string>();
      log.info(`Created ${method.token} watcher: ${watcherId}`);
      return {
        id: watcherId,
        poll: () => watcher.poll(),
        setAddresses: async (addresses) => {
          watcher.setWatchedAddresses(addresses);
          // Import new addresses into the UTXO wallet (watch-only, no rescan)
          for (const addr of addresses) {
            if (!importedAddresses.has(addr)) {
              try {
                await watcher.importAddress(addr);
                importedAddresses.add(addr);
              } catch (err) {
                log.error(`Failed to import address ${addr} into ${method.token} wallet`, {
                  error: (err as Error).message,
                });
              }
            }
          }
        },
      };
    }

    log.warn(`Unknown method type ${method.type}/${method.token} — skipping`);
    return null;
  }

  async function refreshMethods(): Promise<void> {
    if (stopped) return;
    try {
      const methods = await paymentMethodStore.listEnabled();
      const seenIds = new Set<string>();

      for (const method of methods) {
        const id = makeWatcherId(method);
        seenIds.add(id);
        if (!watchers.has(id)) {
          const w = await createWatcher(method);
          if (w) watchers.set(id, w);
        }
      }

      for (const [id] of watchers) {
        if (!seenIds.has(id)) {
          log.info(`Removing watcher: ${id} (method disabled)`);
          watchers.delete(id);
        }
      }
    } catch (err) {
      log.error("Failed to refresh payment methods", { error: (err as Error).message });
    }
  }

  async function refreshAddresses(): Promise<void> {
    try {
      // Query active (uncredited) deposit addresses directly
      const { cryptoCharges } = await import("@wopr-network/platform-core/db/schema/crypto");
      const { isNull, isNotNull, and } = await import("drizzle-orm");
      const rows = await db
        .selectDistinct({
          chain: cryptoCharges.chain,
          address: cryptoCharges.depositAddress,
        })
        .from(cryptoCharges)
        .where(
          and(
            isNull(cryptoCharges.creditedAt),
            isNotNull(cryptoCharges.depositAddress),
            isNotNull(cryptoCharges.chain),
          ),
        );

      // Group by chain
      const byChain = new Map<string, string[]>();
      for (const row of rows) {
        if (!row.chain || !row.address) continue;
        const arr = byChain.get(row.chain) ?? [];
        arr.push(row.address);
        byChain.set(row.chain, arr);
      }

      // Update each watcher with its chain's addresses
      let totalAddresses = 0;
      for (const [id, watcher] of watchers) {
        const chain = id.split(":")[1];
        const addresses = byChain.get(chain ?? "") ?? [];
        totalAddresses += addresses.length;
        if (addresses.length > 0) {
          log.info(`Setting ${addresses.length} address(es) on ${id}: ${addresses.join(", ")}`);
        }
        await watcher.setAddresses(addresses);
      }
      log.info(
        `Address refresh: ${rows.length} active charges, ${totalAddresses} addresses across ${watchers.size} watchers`,
      );
    } catch (err) {
      log.error("Failed to refresh deposit addresses", { error: err });
    }
  }

  async function pollAll(): Promise<void> {
    if (stopped) {
      log.warn("pollAll skipped — stopped flag is set");
      return;
    }
    log.info(`Poll cycle starting (${watchers.size} watchers)`);
    await refreshAddresses();
    for (const [id, watcher] of watchers) {
      try {
        log.info(`Polling: ${id}`);
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("poll timeout (10s)")), 10_000),
        );
        await Promise.race([watcher.poll(), timeout]);
        log.info(`Polled: ${id} OK (cursor now: ${watcher.getCursor?.() ?? "?"})`);
      } catch (err) {
        log.error(`Watcher poll failed: ${id}`, { error: (err as Error).message });
      }
    }
    log.info("Poll cycle complete");
  }

  // Startup
  (async () => {
    await refreshMethods();
    log.info(
      `Crypto watchers started (${watchers.size} active, poll=${pollIntervalMs}ms, refresh=${refreshIntervalMs}ms)`,
    );

    pollTimer = setInterval(() => {
      pollAll().catch((err) => log.error("Poll error", { error: (err as Error).message }));
    }, pollIntervalMs);

    refreshTimer = setInterval(() => {
      refreshMethods().catch((err) => log.error("Refresh error", { error: (err as Error).message }));
    }, refreshIntervalMs);
  })();

  return {
    stop() {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      if (refreshTimer) clearInterval(refreshTimer);
      watchers.clear();
      log.info("Crypto watchers stopped");
    },
  };
}
