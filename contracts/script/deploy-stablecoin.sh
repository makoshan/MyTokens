#!/usr/bin/env bash
# Deploy the test stablecoin (USDT) to Ethereum Sepolia and seed funds.
#
# Validation only: this stands in for real USDC on mainnet (Base). The relayer
# is set as owner so the gateway can faucet-mint test USDT to friends; the friend
# then signs a gasless transferWithSig to "pay" the relayer, who hands back MYC.
#
# Required env:
#   PRIVATE_KEY        deployer key (pays Sepolia gas for the deploy)
#   RELAYER_ADDRESS    gateway relayer EOA — becomes token owner + payment sink
#                      (currently 0xc36fDC5eeee5599aEC0602e36020d4609d07eF3C)
# Optional env:
#   RPC_URL            default: https://ethereum-sepolia-rpc.publicnode.com
#   FAUCET_TO          if set, mint 100 test-USDT to this address after deploy
#
# After deploy, set the gateway Worker config:
#   STABLECOIN_TOKEN_ADDRESS = <printed address>
#   STABLECOIN_MICRO_USD_PER_TOKEN = 1000000   (1 USDT buys 1 MYC = $1 credit)
set -euo pipefail

RPC_URL="${RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
: "${PRIVATE_KEY:?set PRIVATE_KEY (deployer)}"
: "${RELAYER_ADDRESS:?set RELAYER_ADDRESS (relayer EOA = token owner)}"

cd "$(dirname "$0")/.."

echo "Deploying MockStablecoin (USDT, 6dp, owner=$RELAYER_ADDRESS) to $RPC_URL …"
DEPLOY_OUT=$(forge create src/MockStablecoin.sol:MockStablecoin \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --constructor-args "Tether USD (test)" "USDT" 6 "$RELAYER_ADDRESS")

echo "$DEPLOY_OUT"
TOKEN=$(echo "$DEPLOY_OUT" | sed -n 's/^Deployed to: //p')
echo ""
echo "STABLECOIN_TOKEN_ADDRESS=$TOKEN"

if [[ -n "${FAUCET_TO:-}" ]]; then
  echo "Minting 100 test-USDT to $FAUCET_TO (owner=relayer must sign) …"
  echo "Run from the relayer key:"
  echo "  cast send $TOKEN 'mint(address,uint256)' $FAUCET_TO 100000000 --rpc-url $RPC_URL --private-key \$RELAYER_PRIVATE_KEY"
fi
