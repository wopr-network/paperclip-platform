#!/usr/bin/env bash
set -euo pipefail

# Paperclip Platform — Local Testing Stack
#
# This script builds and starts the full local testing environment.
#
# Prerequisites:
#   - Docker + Docker Compose
#   - .env.local (copy from .env.local.example and fill in Stripe test keys)
#   - ~/paperclip repo checked out (for building managed image)
#   - ~/platform-ui-core repo checked out (for dashboard)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PAPERCLIP_DIR="${HOME}/paperclip"
UI_CORE_DIR="${HOME}/platform-ui-core"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Preflight checks ---
echo ""
echo "============================================"
echo "  Paperclip Platform — Local Testing Stack"
echo "============================================"
echo ""

# Check .env.local
if [ ! -f "$PROJECT_DIR/.env.local" ]; then
  err ".env.local not found. Run:\n  cp .env.local.example .env.local\n  # Then fill in Stripe test keys from ~/wopr-platform/.env"
fi
ok ".env.local found"

# Check Docker
if ! command -v docker &>/dev/null; then
  err "Docker not found. Install Docker first."
fi
ok "Docker available"

# Check repos
[ -d "$PAPERCLIP_DIR" ] || err "~/paperclip not found"
[ -d "$UI_CORE_DIR" ]   || err "~/platform-ui-core not found"
ok "Source repos found"

# --- Step 1: Build managed Paperclip image ---
info "Building paperclip-managed:local image..."
if docker image inspect paperclip-managed:local &>/dev/null; then
  warn "paperclip-managed:local already exists. Rebuild? [y/N]"
  read -r rebuild
  if [[ "$rebuild" =~ ^[Yy] ]]; then
    docker build -t paperclip-managed:local -f "$PAPERCLIP_DIR/Dockerfile.managed" "$PAPERCLIP_DIR"
  else
    info "Skipping image build"
  fi
else
  docker build -t paperclip-managed:local -f "$PAPERCLIP_DIR/Dockerfile.managed" "$PAPERCLIP_DIR"
fi
ok "Paperclip managed image ready"

# --- Step 2: Start the stack ---
info "Starting docker-compose.local.yml..."
cd "$PROJECT_DIR"
docker compose -f docker-compose.local.yml up --build -d

# --- Step 3: Wait for health ---
info "Waiting for platform API to be healthy..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3200/health &>/dev/null; then
    ok "Platform API healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    err "Platform API failed to start. Check: docker compose -f docker-compose.local.yml logs platform"
  fi
  sleep 2
done

info "Waiting for dashboard..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/ &>/dev/null; then
    ok "Dashboard healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    warn "Dashboard not responding yet — may still be building. Check: docker compose -f docker-compose.local.yml logs dashboard"
  fi
  sleep 2
done

# --- Done ---
echo ""
echo "============================================"
echo "  Stack is running!"
echo "============================================"
echo ""
echo "  Dashboard:   http://app.localhost:8080"
echo "  API:         http://localhost:3200/health"
echo "  Caddy admin: http://localhost:2019"
echo ""
echo "  Test flow:"
echo "    1. Open http://app.localhost:8080"
echo "    2. Sign up / log in"
echo "    3. Create an instance"
echo "    4. Check it at http://{name}.localhost:8080"
echo "    5. Destroy the instance"
echo ""
echo "  Admin API:"
echo "    curl -H 'Authorization: Bearer \$ADMIN_API_KEY' http://localhost:3200/api/admin/nodes"
echo "    curl -H 'Authorization: Bearer \$ADMIN_API_KEY' http://localhost:3200/api/admin/containers"
echo ""
echo "  Logs:"
echo "    docker compose -f docker-compose.local.yml logs -f platform"
echo "    docker compose -f docker-compose.local.yml logs -f dashboard"
echo ""
echo "  Stop:"
echo "    docker compose -f docker-compose.local.yml down"
echo ""
