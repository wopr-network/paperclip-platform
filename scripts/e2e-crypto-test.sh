#!/usr/bin/env bash
##
## E2E Crypto Payment Test — All Chains
##
## Tests the full flow: auth → checkout → simulate payment → watcher detects → settler credits
##
## Chains tested:
##   1. USDC (ERC-20 on Base fork via Anvil)
##   2. ETH  (native on Base fork via Anvil)
##   3. BTC  (native on regtest via bitcoind)
##
## Prerequisites:
##   docker compose -f docker-compose.local.yml up --build
##
## Usage:
##   bash scripts/e2e-crypto-test.sh
##   bash scripts/e2e-crypto-test.sh --chain usdc   # test only USDC
##   bash scripts/e2e-crypto-test.sh --chain eth     # test only ETH
##   bash scripts/e2e-crypto-test.sh --chain btc     # test only BTC
##

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────
API="http://api.runpaperclip.com:8080"
ANVIL="http://localhost:8545"
BITCOIND="http://localhost:18443"
BTC_AUTH="btcpay:btcpay-local"
USDC_CONTRACT="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
POLL_WAIT=20  # seconds to wait for watcher poll cycle
CHAIN_FILTER="${2:-all}"  # --chain arg

# ── Colors ──────────────────────────────────────────────────────────
G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; C='\033[0;36m'; B='\033[1m'; N='\033[0m'
log()    { echo -e "${G}[✓]${N} $*"; }
warn()   { echo -e "${Y}[!]${N} $*"; }
fail()   { echo -e "${R}[✗]${N} $*"; return 1; }
header() { echo -e "\n${C}${B}═══ $* ═══${N}"; }
step()   { echo -e "${B}--- $* ---${N}"; }

# ── Helpers ─────────────────────────────────────────────────────────
anvil_rpc() {
  local result
  result=$(curl -sf -X POST "$ANVIL" -H 'Content-Type: application/json' -d "$1")
  echo "$result" | jq -r '.result // empty'
}

anvil_rpc_full() {
  curl -sf -X POST "$ANVIL" -H 'Content-Type: application/json' -d "$1"
}

btc_rpc() {
  curl -sf -u "$BTC_AUTH" -X POST "$BITCOIND" -H 'Content-Type: application/json' -d "$1"
}

trpc_query() {
  local proc="$1" input="$2"
  local encoded
  encoded=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$input")
  curl -sf -b "$COOKIE" "$API/trpc/$proc?input=$encoded"
}

trpc_mutation() {
  local proc="$1" input="$2"
  curl -sf -b "$COOKIE" -X POST "$API/trpc/$proc" \
    -H 'Content-Type: application/json' \
    -d "$input"
}

check_charge() {
  local ref="$1" label="$2"
  local status credited
  status=$(trpc_query "billing.chargeStatus" "{\"referenceId\":\"$ref\"}")
  credited=$(echo "$status" | jq -r '.result.data.credited // empty')
  local charge_status
  charge_status=$(echo "$status" | jq -r '.result.data.status // empty')
  if [ "$credited" = "true" ]; then
    log "$label: PASS — credited! (status: $charge_status)"
    return 0
  else
    warn "$label: not yet credited (status: $charge_status)"
    return 1
  fi
}

pad_address() {
  local addr="${1#0x}"
  addr=$(echo "$addr" | tr '[:upper:]' '[:lower:]')
  printf "%064s" "$addr" | tr ' ' '0'
}

hex_to_dec() {
  python3 -c "print(int('${1:-0x0}', 16))"
}

COOKIE=$(mktemp)
RESULTS=()
trap "rm -f $COOKIE" EXIT

# ── Preflight ───────────────────────────────────────────────────────
header "Preflight Checks"

# Check services
curl -sf "http://localhost:3200/health" > /dev/null && log "Platform API: healthy" || fail "Platform API down"
anvil_rpc '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null && log "Anvil: up" || fail "Anvil down"
btc_rpc '{"jsonrpc":"2.0","method":"getblockcount","params":[],"id":1}' > /dev/null 2>&1 && log "Bitcoind: up" || warn "Bitcoind: down (BTC test will be skipped)"

# ── Step 1: Auth ────────────────────────────────────────────────────
header "Step 1: Authentication"

# Fresh signup each run (avoids rate limits on signin)
E2E_TS=$(date +%s)
E2E_EMAIL="e2e-${E2E_TS}@test.local"
SIGNUP_RESP=$(curl -s -c "$COOKIE" -X POST "$API/api/auth/sign-up/email" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"E2E Crypto ${E2E_TS}\",\"email\":\"${E2E_EMAIL}\",\"password\":\"TestCrypt0Pass!\"}")
SIGNUP_TOKEN=$(echo "$SIGNUP_RESP" | jq -r '.token // empty')
if [ -z "$SIGNUP_TOKEN" ]; then
  echo "Signup failed: $SIGNUP_RESP"
fi

# Verify session
USER_ID=$(curl -s -b "$COOKIE" "$API/api/auth/get-session" | jq -r '.user.id // empty')
if [ -z "$USER_ID" ]; then
  fail "Authentication failed — no session"
  exit 1
fi
log "Authenticated as: $USER_ID"

# ── Step 2: Payment Methods ────────────────────────────────────────
header "Step 2: Available Payment Methods"
METHODS_RAW=$(curl -sf "$API/trpc/billing.supportedPaymentMethods")
METHODS=$(echo "$METHODS_RAW" | jq '.result.data // []')
echo "$METHODS" | jq -r '.[] | "  \(.id) — \(.displayName) (\(.type)/\(.token) on \(.chain))"'
METHOD_COUNT=$(echo "$METHODS" | jq length)
log "$METHOD_COUNT payment methods available"


# ════════════════════════════════════════════════════════════════════
# TEST 1: USDC (ERC-20 on Base fork via Anvil)
# ════════════════════════════════════════════════════════════════════
if [ "$CHAIN_FILTER" = "all" ] || [ "$CHAIN_FILTER" = "usdc" ]; then
header "TEST 1: USDC (ERC-20 on Base)"

step "1a. Create checkout"
CHECKOUT_RAW=$(trpc_mutation "billing.checkout" '{"methodId":"USDC:base","amountUsd":10}')
CHECKOUT=$(echo "$CHECKOUT_RAW" | jq '.result.data // empty')
if [ "$CHECKOUT" = "empty" ] || [ -z "$CHECKOUT" ]; then
  echo "$CHECKOUT_RAW" | jq .
  fail "USDC checkout failed"
  RESULTS+=("USDC: FAIL (checkout)")
else
  USDC_ADDR=$(echo "$CHECKOUT" | jq -r '.depositAddress')
  USDC_REF=$(echo "$CHECKOUT" | jq -r '.referenceId')
  USDC_DISPLAY=$(echo "$CHECKOUT" | jq -r '.displayAmount')
  log "Deposit address: $USDC_ADDR"
  log "Send: $USDC_DISPLAY USDC  |  Ref: $USDC_REF"

  step "1b. Mint USDC to test account via storage slot"
  # Anvil default account 0 (has 10000 ETH for gas)
  SENDER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  # USDC on Base: balances mapping — auto-discover storage slot
  USDC_SLOT=""
  for TRY_SLOT in 9 3 0 1 2 5 51; do
    TRY_KEY=$(docker exec paperclip-platform-anvil-1 cast index address "$SENDER" "$TRY_SLOT" 2>/dev/null)
    [ -z "$TRY_KEY" ] && continue
    anvil_rpc '{"jsonrpc":"2.0","method":"anvil_setStorageAt","params":["'"$USDC_CONTRACT"'","'"$TRY_KEY"'","0x0000000000000000000000000000000000000000000000000000000005f5e100"],"id":100}' > /dev/null
    CHECK_PAD=$(pad_address "$SENDER")
    CHECK_BAL=$(hex_to_dec "$(anvil_rpc '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"'"$USDC_CONTRACT"'","data":"0x70a08231'"$CHECK_PAD"'"},"latest"],"id":101}')")
    if [ "$CHECK_BAL" -eq 100000000 ]; then
      USDC_SLOT="$TRY_SLOT"
      # Reset test balance
      anvil_rpc '{"jsonrpc":"2.0","method":"anvil_setStorageAt","params":["'"$USDC_CONTRACT"'","'"$TRY_KEY"'","0x0000000000000000000000000000000000000000000000000000000000000000"],"id":102}' > /dev/null
      break
    fi
    anvil_rpc '{"jsonrpc":"2.0","method":"anvil_setStorageAt","params":["'"$USDC_CONTRACT"'","'"$TRY_KEY"'","0x0000000000000000000000000000000000000000000000000000000000000000"],"id":102}' > /dev/null
  done
  [ -z "$USDC_SLOT" ] && { fail "Could not find USDC balance storage slot"; RESULTS+=("USDC: FAIL (no slot)"); }
  USDC_STORAGE_KEY=$(docker exec paperclip-platform-anvil-1 cast index address "$SENDER" "$USDC_SLOT" 2>/dev/null)
  # Set balance to 1000 USDC = 1_000_000_000 = 0x3B9ACA00
  anvil_rpc '{"jsonrpc":"2.0","method":"anvil_setStorageAt","params":["'"$USDC_CONTRACT"'","'"$USDC_STORAGE_KEY"'","0x000000000000000000000000000000000000000000000000000000003b9aca00"],"id":10}' > /dev/null
  # Verify
  SENDER_PAD=$(pad_address "$SENDER")
  SENDER_BAL_HEX=$(anvil_rpc '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"'"$USDC_CONTRACT"'","data":"0x70a08231'"$SENDER_PAD"'"},"latest"],"id":11}')
  SENDER_BAL=$(hex_to_dec "${SENDER_BAL_HEX:-0x0}")
  log "Test account USDC balance: $(python3 -c "print($SENDER_BAL / 1e6)") USDC"

  step "1c. Transfer USDC to deposit address"
  # transfer(address,uint256): 0xa9059cbb
  ADDR_PAD=$(pad_address "$USDC_ADDR")
  AMT_HEX=$(printf "%064x" 10000000)  # 10 USDC = 10_000_000 (6 decimals)
  CALLDATA="0xa9059cbb${ADDR_PAD}${AMT_HEX}"

  TX_RAW=$(anvil_rpc_full '{"jsonrpc":"2.0","method":"eth_sendTransaction","params":[{"from":"'"$SENDER"'","to":"'"$USDC_CONTRACT"'","data":"'"$CALLDATA"'","gas":"0x30000"}],"id":12}')
  TX_HASH=$(echo "$TX_RAW" | jq -r '.result // empty')
  TX_ERR=$(echo "$TX_RAW" | jq -r '.error.message // empty')

  if [ -n "$TX_HASH" ] && [ "$TX_HASH" != "null" ]; then
    log "Transfer TX: $TX_HASH"
  else
    warn "Transfer may have failed: $TX_ERR"
    echo "$TX_RAW" | jq .
  fi

    # Mine block
    anvil_rpc '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":13}' > /dev/null
    log "Mined Anvil block"

    # Stop impersonation
    # No impersonation cleanup needed — used direct storage mint

    # Verify USDC arrived
    DEST_PAD=$(pad_address "$USDC_ADDR")
    DEST_BAL_HEX=$(anvil_rpc '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"'"$USDC_CONTRACT"'","data":"0x70a08231'"$DEST_PAD"'"},"latest"],"id":15}')
    DEST_BAL=$(hex_to_dec "${DEST_BAL_HEX:-0x0}")
    log "Deposit address USDC balance: $(python3 -c "print($DEST_BAL / 1e6)") USDC"

    step "1d. Wait for watcher poll"
    echo "Waiting ${POLL_WAIT}s for watcher to detect payment..."
    sleep "$POLL_WAIT"

    step "1e. Check charge status"
    if check_charge "$USDC_REF" "USDC"; then
      RESULTS+=("USDC: PASS")
    else
      # Wait one more cycle
      echo "Waiting another ${POLL_WAIT}s..."
      sleep "$POLL_WAIT"
      if check_charge "$USDC_REF" "USDC"; then
        RESULTS+=("USDC: PASS")
      else
        RESULTS+=("USDC: FAIL (not credited)")
      fi
    fi

fi
fi


# ════════════════════════════════════════════════════════════════════
# TEST 2: ETH (native on Base fork via Anvil)
# ════════════════════════════════════════════════════════════════════
if [ "$CHAIN_FILTER" = "all" ] || [ "$CHAIN_FILTER" = "eth" ]; then
header "TEST 2: ETH (Native on Base)"

step "2a. Create checkout"
ETH_CHECKOUT_RAW=$(trpc_mutation "billing.checkout" '{"methodId":"ETH:base","amountUsd":10}')
ETH_CHECKOUT=$(echo "$ETH_CHECKOUT_RAW" | jq '.result.data // empty')
if [ "$ETH_CHECKOUT" = "empty" ] || [ -z "$ETH_CHECKOUT" ]; then
  echo "$ETH_CHECKOUT_RAW" | jq .
  fail "ETH checkout failed"
  RESULTS+=("ETH: FAIL (checkout)")
else
  ETH_ADDR=$(echo "$ETH_CHECKOUT" | jq -r '.depositAddress')
  ETH_REF=$(echo "$ETH_CHECKOUT" | jq -r '.referenceId')
  ETH_DISPLAY=$(echo "$ETH_CHECKOUT" | jq -r '.displayAmount')
  ETH_PRICE=$(echo "$ETH_CHECKOUT" | jq -r '.priceCents // empty')
  log "Deposit address: $ETH_ADDR"
  log "Send: $ETH_DISPLAY ETH  |  Ref: $ETH_REF"
  [ -n "$ETH_PRICE" ] && log "Price at checkout: \$$(python3 -c "print($ETH_PRICE/100)") per ETH"

  step "2b. Send ETH from Anvil test account"
  # Anvil default account 0 has 10000 ETH
  ANVIL_SENDER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

  # Convert display amount to wei (ETH has 18 decimals)
  # Strip unit suffix (e.g. "0.004753 ETH" → "0.004753")
  ETH_AMT=$(echo "$ETH_DISPLAY" | awk '{print $1}')
  WEI_HEX=$(python3 -c "
amt = float('$ETH_AMT')
wei = int(amt * 10**18)
print(hex(wei))
")
  log "Sending $ETH_DISPLAY ETH ($WEI_HEX wei)"

  TX_RAW=$(anvil_rpc_full '{"jsonrpc":"2.0","method":"eth_sendTransaction","params":[{
    "from":"'"$ANVIL_SENDER"'",
    "to":"'"$ETH_ADDR"'",
    "value":"'"$WEI_HEX"'",
    "gas":"0x5208"
  }],"id":20}')
  TX_HASH=$(echo "$TX_RAW" | jq -r '.result // empty')
  TX_ERR=$(echo "$TX_RAW" | jq -r '.error.message // empty')

  if [ -n "$TX_HASH" ] && [ "$TX_HASH" != "null" ]; then
    log "ETH transfer TX: $TX_HASH"
  else
    warn "ETH transfer may have failed: $TX_ERR"
    echo "$TX_RAW" | jq .
  fi

  # Mine block
  anvil_rpc '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":21}' > /dev/null
  log "Mined Anvil block"

  # Verify ETH arrived
  ETH_BAL_HEX=$(anvil_rpc '{"jsonrpc":"2.0","method":"eth_getBalance","params":["'"$ETH_ADDR"'","latest"],"id":22}')
  ETH_BAL=$(python3 -c "print(int('${ETH_BAL_HEX:-0x0}', 16) / 1e18)")
  log "Deposit address ETH balance: $ETH_BAL ETH"

  step "2c. Wait for watcher poll"
  echo "Waiting ${POLL_WAIT}s for watcher to detect payment..."
  sleep "$POLL_WAIT"

  step "2d. Check charge status"
  if check_charge "$ETH_REF" "ETH"; then
    RESULTS+=("ETH: PASS")
  else
    echo "Waiting another ${POLL_WAIT}s..."
    sleep "$POLL_WAIT"
    if check_charge "$ETH_REF" "ETH"; then
      RESULTS+=("ETH: PASS")
    else
      RESULTS+=("ETH: FAIL (not credited)")
    fi
  fi
fi
fi


# ════════════════════════════════════════════════════════════════════
# TEST 3: BTC (native on regtest via bitcoind)
# ════════════════════════════════════════════════════════════════════
if [ "$CHAIN_FILTER" = "all" ] || [ "$CHAIN_FILTER" = "btc" ]; then
header "TEST 3: BTC (Native on Regtest)"

# Check if bitcoind is reachable
BTC_COUNT=$(btc_rpc '{"jsonrpc":"2.0","method":"getblockcount","params":[],"id":1}' 2>/dev/null | jq -r '.result // empty')
if [ -z "$BTC_COUNT" ]; then
  warn "Bitcoind not reachable — skipping BTC test"
  RESULTS+=("BTC: SKIP (bitcoind down)")
else
  log "Bitcoind at block $BTC_COUNT"

  step "3a. Create checkout"
  BTC_CHECKOUT_RAW=$(trpc_mutation "billing.checkout" '{"methodId":"BTC:mainnet","amountUsd":10}')
  BTC_CHECKOUT=$(echo "$BTC_CHECKOUT_RAW" | jq '.result.data // empty')
  if [ "$BTC_CHECKOUT" = "empty" ] || [ -z "$BTC_CHECKOUT" ]; then
    echo "$BTC_CHECKOUT_RAW" | jq .
    warn "BTC checkout failed — may need xpub configured"
    RESULTS+=("BTC: FAIL (checkout)")
  else
    BTC_ADDR=$(echo "$BTC_CHECKOUT" | jq -r '.depositAddress')
    BTC_REF=$(echo "$BTC_CHECKOUT" | jq -r '.referenceId')
    BTC_DISPLAY=$(echo "$BTC_CHECKOUT" | jq -r '.displayAmount')
    log "Deposit address: $BTC_ADDR"
    log "Send: $BTC_DISPLAY BTC  |  Ref: $BTC_REF"

    step "3b. Wait for watcher to import address"
    echo "Waiting ${POLL_WAIT}s for address import..."
    sleep "$POLL_WAIT"

    step "3c. Create wallet & fund it"
    BTC_WALLET="$BITCOIND/wallet/e2e-test"
    # Create wallet (ignore if exists)
    curl -s -u "$BTC_AUTH" -X POST "$BITCOIND" \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"createwallet","params":{"wallet_name":"e2e-test","descriptors":true},"id":30}' > /dev/null 2>&1 || true
    # Load wallet (ignore if already loaded)
    curl -s -u "$BTC_AUTH" -X POST "$BITCOIND" \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"loadwallet","params":["e2e-test"],"id":31}' > /dev/null 2>&1 || true

    # Generate a funding address
    FUND_ADDR=$(curl -sf -u "$BTC_AUTH" -X POST "$BTC_WALLET" \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"getnewaddress","params":[],"id":32}' | jq -r '.result')
    [ -z "$FUND_ADDR" ] || [ "$FUND_ADDR" = "null" ] && { warn "Could not get funding address"; RESULTS+=("BTC: FAIL (no funding addr)"); }
    log "Funding address: $FUND_ADDR"

    # Generate 101 blocks to funding address (need 100 for coinbase maturity)
    BLOCKS=$(curl -sf -u "$BTC_AUTH" -X POST "$BTC_WALLET" \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"generatetoaddress","params":[101,"'"$FUND_ADDR"'"],"id":33}' | jq -r '.result | length')
    log "Mined $BLOCKS blocks to funding address"

    step "3d. Send BTC to deposit address"
    # Strip unit suffix (e.g. "0.00034567 BTC" → "0.00034567")
    BTC_AMT=$(echo "$BTC_DISPLAY" | awk '{print $1}')
    SEND_RESULT=$(curl -s -u "$BTC_AUTH" -X POST "$BTC_WALLET" \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"sendtoaddress","params":["'"$BTC_ADDR"'",'"$BTC_AMT"'],"id":34}')
    BTC_TXID=$(echo "$SEND_RESULT" | jq -r '.result // empty')
    BTC_ERR=$(echo "$SEND_RESULT" | jq -r '.error.message // empty')

    if [ -n "$BTC_TXID" ] && [ "$BTC_TXID" != "null" ]; then
      log "BTC transfer TXID: $BTC_TXID"
    else
      warn "BTC transfer failed: $BTC_ERR"
      echo "$SEND_RESULT" | jq .
      RESULTS+=("BTC: FAIL (send failed: $BTC_ERR)")
    fi

    if [ -n "${BTC_TXID:-}" ] && [ "$BTC_TXID" != "null" ]; then
      step "3e. Mine confirmation blocks"
      # BTC needs confirmations=3 (from payment_methods config)
      CONF_BLOCKS=$(curl -sf -u "$BTC_AUTH" -X POST "$BTC_WALLET" \
        -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","method":"generatetoaddress","params":[6,"'"$FUND_ADDR"'"],"id":35}' | jq -r '.result | length')
      log "Mined $CONF_BLOCKS confirmation blocks"

      step "3f. Wait for watcher poll"
      echo "Waiting ${POLL_WAIT}s for watcher to detect payment..."
      sleep "$POLL_WAIT"

      step "3g. Check charge status"
      if check_charge "$BTC_REF" "BTC"; then
        RESULTS+=("BTC: PASS")
      else
        echo "Waiting another ${POLL_WAIT}s..."
        sleep "$POLL_WAIT"
        if check_charge "$BTC_REF" "BTC"; then
          RESULTS+=("BTC: PASS")
        else
          RESULTS+=("BTC: FAIL (not credited)")
        fi
      fi
    fi
  fi
fi
fi


# ── Results ─────────────────────────────────────────────────────────
header "Results"
echo ""
PASS=0; FAIL=0; SKIP=0
for r in "${RESULTS[@]}"; do
  if echo "$r" | grep -q "PASS"; then
    echo -e "  ${G}✓${N} $r"
    ((PASS++))
  elif echo "$r" | grep -q "SKIP"; then
    echo -e "  ${Y}○${N} $r"
    ((SKIP++))
  else
    echo -e "  ${R}✗${N} $r"
    ((FAIL++))
  fi
done
echo ""
echo -e "${B}Total: $PASS passed, $FAIL failed, $SKIP skipped${N}"

# Check DB state
header "DB Verification"
echo "Charges:"
docker exec paperclip-platform-postgres-1 psql -U paperclip -d paperclip_platform -c \
  "SELECT reference_id, chain, token, status, deposit_address, credited_at FROM crypto_charges ORDER BY created_at DESC LIMIT 10;" 2>&1 || true
echo ""
echo "Journal entries:"
docker exec paperclip-platform-postgres-1 psql -U paperclip -d paperclip_platform -c \
  "SELECT je.reference, je.memo, jl.amount, jl.direction FROM journal_entries je JOIN journal_lines jl ON je.id = jl.entry_id ORDER BY je.created_at DESC LIMIT 10;" 2>&1 || true

# Exit code
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
