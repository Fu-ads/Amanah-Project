# Halal Crypto Voting System

A permissioned-blockchain voting platform where scholar accounts vote on
whether specific cryptocurrencies are halal. Votes are cast and signed
client-side via MetaMask against a smart contract running on a private
4-node Clique Proof-of-Authority Ethereum network.

## Architecture overview

- **Blockchain**: 4 Geth nodes running Clique PoA consensus (private network,
  not connected to any public chain)
- **Smart contract**: Solidity contract (`HalalCryptoVote.sol`) managing
  proposals and votes, deployed via Hardhat
- **Website**: A single Node.js server (`server.js`) using MongoDB for
  accounts/sessions, serving both the site and a set of `/api/*` routes that
  read from the chain
- **Voting**: Handled entirely client-side - MetaMask signs transactions
  directly in the browser. The server never holds voter private keys.
- **AI features**: Coin summaries and smart-contract explanations via Ollama
  (and optionally a CodeT5 microservice for a narrower contract-translation
  feature)

---

## Prerequisites

Install these before doing anything else:

| Tool | Notes |
|---|---|
| [Node.js](https://nodejs.org) | LTS release recommended |
| [Geth (go-ethereum) **v1.12.2**](https://geth.ethereum.org/downloads) | **Version matters** - see the note below |
| [MongoDB](https://www.mongodb.com/try/download/community) | For accounts/sessions |
| [Ollama](https://ollama.com) | For AI-generated coin summaries and contract explanations |
| A domain name with DNS access | Needed for a valid HTTPS certificate |

> **Why Geth 1.12.2 specifically?** Newer Geth releases (1.13+) removed the
> `personal` account API and changed how `--unlock` works, which this
> project's node-launch scripts rely on. If you build Geth from source on a
> very recent Go toolchain (Go 1.23+), you may also need:
> ```
> go build -ldflags "-checklinkname=0" -o build/bin/geth ./cmd/geth
> ```
> due to a linker compatibility issue between this Geth version and newer Go
> compilers.

---

## 1. Set up the blockchain network

All 4 signer nodes are infrastructure you run yourself - they are **not**
tied to individual voters (voters use MetaMask separately; see step 4).

1. Copy `setup-nodes-auto.ps1` (Windows) or `setup-nodes.sh` (Linux) into an
   empty folder.
2. Run it:
   ```powershell
   # Windows
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   .\setup-nodes-auto.ps1
   ```
   ```bash
   # Linux
   chmod +x setup-nodes.sh
   ./setup-nodes.sh   # edit the VOTERS array first, or generate accounts manually
   ```
   This generates 4 signer accounts, builds `genesis.json`, initializes and
   launches all 4 nodes, and peers them together automatically.
3. Confirm it's working - in any node's console (or via `geth attach`):
   ```js
   eth.blockNumber      // should be increasing
   admin.peers.length   // should show 3
   ```

**Re-running the setup script wipes and rebuilds the chain from block 0.**
You will need to redeploy the contract (step 2) again afterward.

---

## 2. Deploy the smart contract

```bash
cd halal-vote-project
npm install
npx hardhat compile
npx hardhat keystore set VOTER1_PRIVATE_KEY   # your deployer key, once per machine
npx hardhat run scripts/deploy.ts --network privatePoA
```

`hardhat.config.ts`'s `privatePoA.url` must point at wherever your 4 nodes'
RPC is actually reachable (`http://127.0.0.1:8545` if running on the same
machine as this deploy step).

Copy the printed contract address - you'll need it in step 5.

> The deployer's private key is decrypted from its Geth keystore file. See
> `decrypt-key.mjs` pattern in project notes if you need to extract it - and
> delete that script once you're done, it prints keys in plaintext.

---

## 3. Expose the RPC over HTTPS

MetaMask requires HTTPS for any custom network (plain `http://` is rejected
except for `localhost`). This project's `server.js` already includes a
built-in reverse-proxy route (`POST /rpc`) that forwards JSON-RPC calls to
Geth's local port using the site's **existing** HTTPS certificate - no
separate reverse proxy (Caddy, nginx, etc.) is required if the website
already has a valid certificate.

Your public RPC URL for MetaMask/browser use will be:
```
https://yourdomain.com/rpc
```

---

## 4. Set up MetaMask (per voter, not per server)

Each scholar does this once, in their own browser:
1. Install the MetaMask extension
2. Add a network manually: RPC URL = `https://yourdomain.com/rpc`, Chain ID
   = `15`
3. Create a new account (or import an existing key) - this address is what
   gets registered as their `walletAddress` at signup, and what needs to be
   included in the contract's `authorizedVoters` list (edit
   `scripts/deploy.ts`'s `voters` array and redeploy once you have all real
   addresses)

---

## 5. Configure and run the website

Copy `config.env.example` (or create `config.env`) with:

```
httpsPORT=443
httpPORT=80
dbURL=mongodb://127.0.0.1:27017
database=halalvote
collection=coins

rpcURL=http://127.0.0.1:8545
publicRpcUrl=https://yourdomain.com/rpc
contractAddress=0x...              # from step 2
contractArtifactPath=../halal-vote-project/artifacts/contracts/HalalCryptoVote.sol/HalalCryptoVote.json

SSLdirectory=/path/to/certs
SSLfullCertificate=fullchain.pem
SSLkey=privkey.pem
SSLchain=chain.pem
SSLpassphrase=

mailHost=
mailPort=
```

Install dependencies and run:
```bash
npm install
node server.js
```

On startup, the server checks that `contractAddress` actually has code
deployed on the current chain and will warn clearly in the console if it
doesn't (usually means the chain was reset since the last deploy - repeat
step 2).

---

## 6. (Optional) AI features

**Coin summaries and contract explanations** use Ollama:
```bash
ollama pull gemma4
```
Ollama must be running locally (`ollama serve`, or it runs automatically
after install on most platforms) for `/api/ai_summary/*` and the contract
translation feature to work.

**Alternative contract-translation backend** (CodeT5, narrower/smaller model):
```bash
cd python
pip install -r requirements.txt
python codet5_translate.py
```
Runs a small local service on port 5001 that `server.js` calls instead of
Ollama for the `/translate` page, if configured to do so.

---

## Firewall / port checklist

| Port | Purpose |
|---|---|
| 443 | HTTPS website |
| 80 | HTTP (Let's Encrypt renewal, if applicable) |
| 8545 | Geth RPC (only needs to be reachable if you're exposing it directly rather than via the built-in `/rpc` proxy) |
| 30301-30304 | Geth P2P, one per node |

On Windows:
```powershell
New-NetFirewallRule -DisplayName "HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
New-NetFirewallRule -DisplayName "HTTP" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow
New-NetFirewallRule -DisplayName "Geth P2P" -Direction Inbound -Protocol TCP -LocalPort 30301-30304 -Action Allow
```
On Fedora/Linux:
```bash
sudo firewall-cmd --permanent --add-port=443/tcp --add-port=80/tcp --add-port=30301-30304/tcp
sudo firewall-cmd --reload
```

If you're behind a home router (not a cloud VPS), you'll also need to port
forward these to this machine's local IP - and confirm you aren't behind
CGNAT (`curl ifconfig.me` should match your router's own WAN IP; if it
doesn't, port forwarding cannot work and you'll need a tunnel/relay
service instead).

---

## Project structure

```
├── node1-node4/              # Geth node data directories (NOT committed - see .gitignore)
├── genesis.json               # Chain genesis config (safe to commit - public data only)
├── setup-nodes-auto.ps1       # Fully automated node setup (Windows)
├── setup-nodes.sh              # Node setup (Linux)
├── halal-vote-project/        # Hardhat project
│   ├── contracts/HalalCryptoVote.sol
│   ├── scripts/deploy.ts
│   └── hardhat.config.ts
├── server.js                   # Main website server
├── html/, css/, javascript/    # Site frontend
├── python/                     # Optional CodeT5 microservice
└── config.env                  # Environment config (NOT committed)
```

## Never commit these

```
node1/  node2/  node3/  node4/     # contain private keys
passwords.txt
config.env
*.pid
logs/
node_modules/
artifacts/
cache/
decrypt-key.mjs
```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `could not decode result data (value="0x", ...)` | `contractAddress` in `config.env` doesn't match what's deployed on the current chain - redeploy (step 2) and update the address |
| `ECONNREFUSED 127.0.0.1:8545` | Nodes aren't running - re-run the setup script |
| MetaMask: `RPC endpoint returned too many errors` | MetaMask has a stale/wrong RPC URL saved for the network - delete and re-add it, or edit it to match `publicRpcUrl` |
| Geth: `Unavailable modules ... unavailable=[clique]` + `panic: ethash (pow) sealing not supported` | Genesis config is missing `terminalTotalDifficulty`/`terminalTotalDifficultyPassed`, causing Geth to treat the chain as post-merge |
| `Fatal: Access is denied` on node startup | Windows named-pipe collision - add `--ipcdisable` (already default in the setup scripts) |
| Vote/proposal succeeds but tally shows "still in progress" | This is normal until the deadline passes - the tally is computed automatically from vote events once it does, no manual action needed |
