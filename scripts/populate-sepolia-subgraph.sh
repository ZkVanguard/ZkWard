#!/usr/bin/env bash
# One-command runbook to populate the Graph Studio subgraph with real
# Sepolia activity. Chains: deploy → seed → yaml patch → graph deploy.
#
# Prereqs (drop into .env.local):
#   PRIVATE_KEY       Sepolia deployer with ≥ 0.05 SepETH
#   SEPOLIA_RPC       optional (defaults to sepolia.drpc.org)
#
# Prereqs (installed once):
#   npm i -g @graphprotocol/graph-cli
#   graph auth <YOUR_STUDIO_DEPLOY_KEY>
#
# Run:
#   bash scripts/populate-sepolia-subgraph.sh
#
# Idempotent: if SEPOLIA_VAULT_ADDR and SEPOLIA_USDC_ADDR are already set
# in .env.local, deploy step is skipped and only seed + yaml + graph-deploy run.

set -euo pipefail

cd "$(dirname "$0")/.."

# ─── 1. Deploy (skip if addresses already present) ───────────────────────────
if grep -qE '^SEPOLIA_VAULT_ADDR=0x[0-9a-fA-F]{40}$' .env.local 2>/dev/null; then
  echo "[1/4] deploy — skipped (SEPOLIA_VAULT_ADDR already in .env.local)"
  VAULT_ADDR=$(grep -E '^SEPOLIA_VAULT_ADDR=' .env.local | cut -d= -f2 | tr -d '"' | tr -d "'" | tr -d '\r' | tr -d '\n')
  USDC_ADDR=$(grep -E '^SEPOLIA_USDC_ADDR=' .env.local | cut -d= -f2 | tr -d '"' | tr -d "'" | tr -d '\r' | tr -d '\n')
  DEPLOY_BLOCK=$(grep -E '^SEPOLIA_VAULT_DEPLOY_BLOCK=' .env.local | cut -d= -f2 | tr -d '"' | tr -d "'" | tr -d '\r' | tr -d '\n')
else
  echo "[1/4] deploy — SimpleUsdcVault + MockUSDC to Sepolia"
  OUT=$(npx hardhat run scripts/deploy/deploy-sepolia-usdc-full.cjs --network sepolia)
  echo "$OUT"
  VAULT_ADDR=$(echo "$OUT" | grep -oE '"communityPool":\s*"0x[0-9a-fA-F]{40}"' | grep -oE '0x[0-9a-fA-F]{40}')
  USDC_ADDR=$(echo "$OUT" | grep -oE '"usdc":\s*"0x[0-9a-fA-F]{40}"' | grep -oE '0x[0-9a-fA-F]{40}')
  DEPLOY_BLOCK=$(echo "$OUT" | grep -oE '"poolDeployBlock":\s*[0-9]+' | grep -oE '[0-9]+')
  if [[ -z "$VAULT_ADDR" ]]; then
    echo "ERROR: could not parse deploy output for VAULT_ADDR"
    exit 1
  fi
  # Save into .env.local so seed step can read them, and re-runs are idempotent
  echo "" >> .env.local
  echo "# Sepolia populate — auto-appended $(date -u +%FT%TZ)" >> .env.local
  echo "SEPOLIA_USDC_ADDR=$USDC_ADDR" >> .env.local
  echo "SEPOLIA_VAULT_ADDR=$VAULT_ADDR" >> .env.local
  echo "SEPOLIA_VAULT_DEPLOY_BLOCK=$DEPLOY_BLOCK" >> .env.local
fi

echo "    vault: $VAULT_ADDR"
echo "    usdc:  $USDC_ADDR"
echo "    block: $DEPLOY_BLOCK"

# ─── 2. Seed with 6 deposits + 2 withdrawals ─────────────────────────────────
echo ""
echo "[2/4] seed — 6 deposits + 2 withdrawals"
npx hardhat run scripts/seed-sepolia-vault.cjs --network sepolia

# ─── 3. Patch subgraph.yaml — swap the SimpleUsdcVault placeholder ───────────
echo ""
echo "[3/4] patch subgraph/subgraph.yaml — SimpleUsdcVault address + startBlock"
bun run scripts/update-subgraph-yaml.ts "$VAULT_ADDR" "$DEPLOY_BLOCK"

# ─── 4. Redeploy the subgraph ────────────────────────────────────────────────
echo ""
echo "[4/4] graph deploy zkward"
echo "    (needs: npm i -g @graphprotocol/graph-cli && graph auth <STUDIO_KEY>)"
cd subgraph
graph codegen
graph build
graph deploy zkward --version-label v0.2.0
cd ..

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  DONE — verify with:"
echo "    bun run scripts/demo-graph-parity.ts"
echo "  Studio side should now show 1+ pool with real TVL."
echo "════════════════════════════════════════════════════════════════"
