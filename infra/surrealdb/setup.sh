#!/usr/bin/env bash
# ============================================================================
# SurrealDB Setup Script
#
# Purpose:
#   Start SurrealDB Docker container and apply the Lore schema.
#   Run once on initial setup, safe to re-run (idempotent schema).
#
# Usage:
#   ./setup.sh
#
# Prerequisites:
#   - Docker Desktop running
#   - .env file with SURREAL_ROOT_PASS set
#
# Side Effects:
#   - Starts Docker container "surrealdb" on 127.0.0.1:8000
#   - Creates/updates SurrealDB schema
#   - Creates named volume "surrealdb_surreal-data" for persistence
#
# Determinism: Idempotent (safe to re-run)
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Sentinel Check ──────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "❌ .env file not found. Create it with SURREAL_ROOT_PASS=<strong-password>"
  exit 1
fi

source .env

BLOCKED_PASSWORDS=("changeme" "password" "root" "admin" "surrealdb" "secret" "test")
for blocked in "${BLOCKED_PASSWORDS[@]}"; do
  if [ "$SURREAL_ROOT_PASS" = "$blocked" ]; then
    echo "❌ SURREAL_ROOT_PASS is set to '$blocked'. Use a strong, unique password."
    exit 1
  fi
done

if [ ${#SURREAL_ROOT_PASS} -lt 16 ]; then
  echo "❌ SURREAL_ROOT_PASS must be at least 16 characters. Current: ${#SURREAL_ROOT_PASS}"
  exit 1
fi

echo "✓ Password sentinel check passed"

# ─── Start Docker Container ──────────────────────────────────────────────────
echo "→ Starting SurrealDB Docker container..."
docker compose up -d

echo "→ Waiting for SurrealDB to be ready..."
sleep 3

# Verify container is running
if ! docker ps --filter "name=surrealdb" --format '{{.Status}}' | grep -q "Up"; then
  echo "❌ SurrealDB container failed to start. Check: docker logs surrealdb"
  exit 1
fi

echo "✓ SurrealDB container running on 127.0.0.1:8000"

# ─── Apply Schema ────────────────────────────────────────────────────────────
echo "→ Applying Lore schema..."

# Use docker exec to run surreal sql inside the container
docker exec -i surrealdb /surreal sql \
  --endpoint http://localhost:8000 \
  --username root \
  --password "$SURREAL_ROOT_PASS" \
  --namespace groundfloor \
  --database lore \
  < schema.surql

echo "✓ Schema applied successfully"

# ─── Verify ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  SurrealDB is running!"
echo ""
echo "  Endpoint:  http://127.0.0.1:8000"
echo "  User:      root"
echo "  Namespace: groundfloor"
echo "  Database:  lore"
echo ""
echo "  Next steps:"
echo "    1. Set up Cloudflare Tunnel (see docs/groundfloor-lore.md)"
echo "    2. Configure pmset: sudo pmset -c sleep 0 displaysleep 10"
echo "═══════════════════════════════════════════════════════════"
