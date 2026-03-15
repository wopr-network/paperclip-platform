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
  setAddresses: (addresses: string[]) => void;
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

  // Shared Chainlink oracle for all native-coin watchers (ETH, BTC, LTC, etc.)
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
      };
    }

    if (method.type === "native" && method.token.toUpperCase() === "ETH") {
      if (!sharedOracle) {
        log.warn(`No EVM RPC for Chainlink oracle — skipping ETH watcher`);
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

    // UTXO chains: BTC, LTC (same bitcoind-compatible RPC API)
    const UTXO_COINS = ["BTC", "LTC"];
    if (method.type === "native" && UTXO_COINS.includes(method.token.toUpperCase())) {
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
        network: (method.chain === "bitcoin" || method.chain === "litecoin" ? "mainnet" : method.chain) as
          | "mainnet"
          | "testnet"
          | "regtest",
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
      log.info(`Created ${method.token} watcher: ${watcherId}`);
      return {
        id: watcherId,
        poll: () => watcher.poll(),
        setAddresses: (a) => watcher.setWatchedAddresses(a),
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
      for (const [id, watcher] of watchers) {
        // Extract chain from watcher id (format: type:chain:token)
        const chain = id.split(":")[1];
        const addresses = byChain.get(chain ?? "") ?? [];
        watcher.setAddresses(addresses);
      }
    } catch (err) {
      log.error("Failed to refresh deposit addresses", { error: (err as Error).message });
    }
  }

  async function pollAll(): Promise<void> {
    if (stopped) return;
    await refreshAddresses();
    for (const [id, watcher] of watchers) {
      try {
        await watcher.poll();
      } catch (err) {
        log.error(`Watcher poll failed: ${id}`, { error: (err as Error).message });
      }
    }
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
