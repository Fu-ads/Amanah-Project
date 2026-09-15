#!/usr/bin/env bash
#
# Linux/Fedora equivalent of setup-nodes.ps1.
# Builds genesis.json, initializes 4 Clique PoA node datadirs, launches all 4
# as background processes (with log files, since this is likely a headless
# server over SSH rather than a GUI desktop), and auto-peers them via RPC.
#
# PREREQUISITES:
#   - geth on PATH (confirm with: geth version)
#   - curl and jq installed (sudo dnf install curl jq -y)
#   - You've already run, for each node:
#       geth account new --datadir node1   (etc. for node2, node3, node4)
#     and put that node's password in node1/password.txt (etc.)
#
# USAGE:
#   Edit the VOTERS array below with your 4 real signer addresses
#   (no 0x prefix), then:
#       chmod +x setup-nodes.sh
#       ./setup-nodes.sh
#   Run it from the folder that contains node1, node2, node3, node4.
#
# SECURITY NOTE: same as the Windows version - RPC is bound to 0.0.0.0 and
# accounts run with --unlock (unlocked for the life of the process), so make
# sure these 4 signer addresses hold no real funds and your firewall only
# opens the ports you actually need exposed.

set -euo pipefail

# ============================================================
# CONFIGURE THESE BEFORE RUNNING
# ============================================================
VOTERS=(
    "Voter1AddressHere"
    "Voter2AddressHere"
    "Voter3AddressHere"
    "Voter4AddressHere"
)

CHAIN_ID=15
PERIOD=5            # seconds between blocks
BASE_PORT=30301      # node1=30301, node2=30302, ...
BASE_RPC=8545        # node1=8545, node2=8546, ...
BASE_AUTH_RPC=8551   # node1=8551, node2=8552, ...
ROOT_DIR="$(pwd)"

# ============================================================
# SANITY CHECKS
# ============================================================
if [[ "${VOTERS[0]}" == "Voter1AddressHere" ]]; then
    echo "ERROR: Edit the VOTERS array with your real 4 addresses before running this script." >&2
    exit 1
fi

if ! command -v geth &>/dev/null; then
    echo "ERROR: geth not found on PATH." >&2
    exit 1
fi
if ! command -v curl &>/dev/null || ! command -v jq &>/dev/null; then
    echo "ERROR: curl and jq are required. Install with: sudo dnf install curl jq -y" >&2
    exit 1
fi

for i in 1 2 3 4; do
    dir="$ROOT_DIR/node$i"
    if [[ ! -d "$dir" ]]; then
        echo "ERROR: $dir does not exist. Create your 4 accounts first (see script header)." >&2
        exit 1
    fi
    if [[ ! -f "$dir/password.txt" ]]; then
        echo "ERROR: $dir/password.txt is missing." >&2
        exit 1
    fi
done

# ============================================================
# BUILD genesis.json
# ============================================================
echo "Building genesis.json ..."

ZERO_PAD_32=$(printf '0%.0s' {1..64})
ZERO_PAD_65=$(printf '0%.0s' {1..130})
SIGNERS=$(IFS=; echo "${VOTERS[*]}")
EXTRADATA="0x${ZERO_PAD_32}${SIGNERS}${ZERO_PAD_65}"

ALLOC=""
for v in "${VOTERS[@]}"; do
    ALLOC+="\"0x$v\": { \"balance\": \"100000000000000000000\" },"
done
ALLOC="${ALLOC%,}"  # strip trailing comma

cat > "$ROOT_DIR/genesis.json" <<EOF
{
  "config": {
    "chainId": $CHAIN_ID,
    "homesteadBlock": 0,
    "eip150Block": 0,
    "eip155Block": 0,
    "eip158Block": 0,
    "byzantiumBlock": 0,
    "constantinopleBlock": 0,
    "petersburgBlock": 0,
    "istanbulBlock": 0,
    "terminalTotalDifficulty": 5000000000000000000,
    "terminalTotalDifficultyPassed": false,
    "clique": { "period": $PERIOD, "epoch": 30000 }
  },
  "difficulty": "1",
  "gasLimit": "8000000",
  "extradata": "$EXTRADATA",
  "alloc": { $ALLOC }
}
EOF
echo "Wrote $ROOT_DIR/genesis.json"

# ============================================================
# INIT EACH NODE (wiping stale chain data first)
# ============================================================
for i in 1 2 3 4; do
    dir="$ROOT_DIR/node$i"
    if [[ -d "$dir/geth" ]]; then
        echo "Removing stale chain data for node$i ..."
        rm -rf "$dir/geth"
    fi
    echo "Initializing node$i ..."
    geth --datadir "$dir" init "$ROOT_DIR/genesis.json"
done

# ============================================================
# LAUNCH ALL 4 NODES AS BACKGROUND PROCESSES
# ============================================================
mkdir -p "$ROOT_DIR/logs"
echo "Launching 4 nodes in the background ..."

for i in 1 2 3 4; do
    dir="$ROOT_DIR/node$i"
    addr="${VOTERS[$((i-1))]}"
    port=$((BASE_PORT + i - 1))
    rpc_port=$((BASE_RPC + i - 1))
    auth_port=$((BASE_AUTH_RPC + i - 1))
    pw_file="$dir/password.txt"
    log_file="$ROOT_DIR/logs/node$i.log"

    nohup geth \
        --datadir "$dir" \
        --networkid "$CHAIN_ID" \
        --port "$port" \
        --http --http.addr 0.0.0.0 --http.port "$rpc_port" \
        --http.api personal,eth,net,web3,clique,admin \
        --http.corsdomain "*" --http.vhosts "*" \
        --ipcdisable --authrpc.port "$auth_port" \
        --allow-insecure-unlock --unlock "0x$addr" --password "$pw_file" \
        --mine --miner.etherbase "0x$addr" --miner.gasprice 0 --txpool.pricelimit 0 \
        > "$log_file" 2>&1 &

    echo $! > "$ROOT_DIR/node$i.pid"
    echo "  node$i started (pid $(cat "$ROOT_DIR/node$i.pid")) -> RPC http://0.0.0.0:$rpc_port  P2P port $port  log: $log_file"
done

echo ""
echo "Waiting 15 seconds for all 4 nodes to finish starting up ..."
sleep 15

# ============================================================
# AUTO-CONNECT ALL NODES AS PEERS (via RPC)
# ============================================================
echo "Fetching enode addresses over RPC ..."

declare -A ENODES
for i in 1 2 3 4; do
    rpc_port=$((BASE_RPC + i - 1))
    result=$(curl -s -X POST -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"admin_nodeInfo","params":[],"id":1}' \
        "http://127.0.0.1:$rpc_port" || true)
    enode=$(echo "$result" | jq -r '.result.enode // empty')
    if [[ -n "$enode" ]]; then
        # Rewrite host to 127.0.0.1 since all 4 nodes are on this same machine
        enode=$(echo "$enode" | sed -E 's/@[^:]+:/@127.0.0.1:/')
        ENODES[$i]="$enode"
        echo "  node$i enode: $enode"
    else
        echo "  Could not fetch enode for node$i - check logs/node$i.log"
    fi
done

echo "Cross-connecting all nodes as peers ..."
for i in 1 2 3 4; do
    rpc_port_i=$((BASE_RPC + i - 1))
    for j in 1 2 3 4; do
        if [[ "$i" != "$j" && -n "${ENODES[$j]:-}" ]]; then
            curl -s -X POST -H "Content-Type: application/json" \
                --data "{\"jsonrpc\":\"2.0\",\"method\":\"admin_addPeer\",\"params\":[\"${ENODES[$j]}\"],\"id\":1}" \
                "http://127.0.0.1:$rpc_port_i" > /dev/null || true
        fi
    done
done

echo ""
echo "Done. Check peering with:"
echo "  geth attach http://127.0.0.1:$BASE_RPC --exec 'admin.peers.length'"
echo "(should print 3). To stop all nodes: for f in node*.pid; do kill \$(cat \$f); done"
