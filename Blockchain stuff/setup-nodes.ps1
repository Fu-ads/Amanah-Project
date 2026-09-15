<#
.SYNOPSIS
  Sets up a 4-node Clique PoA Geth network for the Halal Crypto Voting System.
  Automates Parts 3-5 of the setup guide: genesis creation, node init, launching
  all 4 nodes in their own windows, and connecting them as peers.

.PREREQUISITES
  - geth.exe must be installed and available on PATH (run `geth version` to check)
  - You must have already created 4 accounts, one per node, e.g.:
      geth account new --datadir node1
      geth account new --datadir node2
      geth account new --datadir node3
      geth account new --datadir node4
    and placed each node's password in <nodeDir>\password.txt

.USAGE
  Edit the $voters array below with your 4 real addresses (no 0x needed in the
  array itself), then run from PowerShell:

      .\setup-nodes.ps1

  Run it from the parent folder that contains node1, node2, node3, node4.

.SECURITY WARNING
  This version binds RPC to 0.0.0.0 (all interfaces) so external MetaMask
  clients can reach it, and each node runs with --unlock, meaning the
  signer account stays UNLOCKED for the life of the process. Anyone who can
  reach these ports could call eth_sendTransaction using that unlocked
  account with no further authentication. Since you (not voters) now run
  ALL 4 signer nodes yourself, make sure:
    - These 4 signer addresses hold no real funds (they're only used to
      seal Clique blocks and never touch voter funds)
    - Your firewall only allows the RPC ports you actually need exposed
    - Consider restricting --http.api to eth,net,web3 once you no longer
      need personal/admin/clique reachable from outside your own machine
#>

# ============================================================
# CONFIGURE THESE 4 VALUES BEFORE RUNNING
# ============================================================
$voters = @(
    "Voter1AddressHere",   # e.g. AbC123...  (without 0x)
    "Voter2AddressHere",
    "Voter3AddressHere",
    "Voter4AddressHere"
)

$chainId    = 15
$period     = 5          # seconds between blocks
$basePort   = 30301       # node1=30301, node2=30302, ...
$baseRpc    = 8545         # node1=8545, node2=8546, ...
$baseAuthRpc = 8551         # node1=8551, node2=8552, ... (engine API safety net)
$rootDir    = Get-Location  # run this script from the folder containing node1..node4

# ============================================================
# SANITY CHECKS
# ============================================================
if ($voters -contains "Voter1AddressHere") {
    Write-Host "ERROR: You must edit the `$voters array with your real 4 addresses before running this script." -ForegroundColor Red
    exit 1
}

$gethCheck = Get-Command geth -ErrorAction SilentlyContinue
if (-not $gethCheck) {
    Write-Host "ERROR: geth.exe not found on PATH. Install it and re-open PowerShell." -ForegroundColor Red
    exit 1
}

for ($i = 1; $i -le 4; $i++) {
    $dir = Join-Path $rootDir "node$i"
    if (-not (Test-Path $dir)) {
        Write-Host "ERROR: $dir does not exist. Create your 4 accounts first (see script header)." -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path (Join-Path $dir "password.txt"))) {
        Write-Host "ERROR: $dir\password.txt is missing. Create it with that node's account password." -ForegroundColor Red
        exit 1
    }
}

# ============================================================
# PART 3: BUILD genesis.json
# ============================================================
Write-Host "Building genesis.json ..." -ForegroundColor Cyan

$zeroPad32 = "0" * 64          # 32 bytes of zero padding (vanity)
$zeroPad65 = "0" * 130         # 65 bytes of zero padding (empty proposer seal)
$signers   = ($voters -join "")
$extraData = "0x$zeroPad32$signers$zeroPad65"

$alloc = @{}
foreach ($v in $voters) {
    $alloc["0x$v"] = @{ balance = "100000000000000000000" }
}

$genesis = @{
    config = @{
        chainId             = $chainId
        homesteadBlock      = 0
        eip150Block         = 0
        eip155Block         = 0
        eip158Block         = 0
        byzantiumBlock      = 0
        constantinopleBlock = 0
        petersburgBlock     = 0
        istanbulBlock       = 0
        # These two lines tell Geth this chain is pre-merge and will NEVER
        # reach the merge difficulty threshold. Without this, modern Geth
        # (1.12+) assumes the chain is post-merge, which disables the
        # clique RPC module and opens an unwanted Engine API / authrpc
        # listener on port 8551 for a beacon client that doesn't exist here.
        terminalTotalDifficulty       = 5000000000000000000
        terminalTotalDifficultyPassed = $false
        clique              = @{ period = $period; epoch = 30000 }
    }
    difficulty = "1"
    gasLimit   = "8000000"
    extradata  = $extraData
    alloc      = $alloc
}

$genesisPath = Join-Path $rootDir "genesis.json"
$genesis | ConvertTo-Json -Depth 6 | Set-Content -Path $genesisPath -Encoding ASCII
Write-Host "Wrote $genesisPath" -ForegroundColor Green

# ============================================================
# PART 3 (cont): INIT EACH NODE WITH THE GENESIS BLOCK
# ============================================================
for ($i = 1; $i -le 4; $i++) {
    $dir = Join-Path $rootDir "node$i"
    $chainDataDir = Join-Path $dir "geth"
    if (Test-Path $chainDataDir) {
        Write-Host "Removing stale chain data for node$i ..." -ForegroundColor Yellow
        Remove-Item $chainDataDir -Recurse -Force
    }
    Write-Host "Initializing node$i ..." -ForegroundColor Cyan
    & geth --datadir $dir init $genesisPath
}

# ============================================================
# PART 4: LAUNCH ALL 4 NODES, EACH IN ITS OWN WINDOW
# ============================================================
Write-Host "Launching 4 nodes in separate windows ..." -ForegroundColor Cyan

for ($i = 1; $i -le 4; $i++) {
    $dir      = Join-Path $rootDir "node$i"
    $addr     = $voters[$i - 1]
    $port     = $basePort + ($i - 1)
    $rpcPort  = $baseRpc + ($i - 1)
    $authPort = $baseAuthRpc + ($i - 1)
    $pwFile   = Join-Path $dir "password.txt"

    # Write the command to a small .bat file per node, then open it with
    # "cmd /k" so the window STAYS OPEN even if geth errors out immediately -
    # this lets you actually read the error instead of the window closing.
    $argString = "--datadir `"$dir`" --networkid $chainId --port $port " +
                 "--http --http.addr 0.0.0.0 --http.port $rpcPort " +
                 "--http.api personal,eth,net,web3,clique,admin " +
                 "--http.corsdomain `"*`" --http.vhosts `"*`" " +
                 "--ipcdisable --authrpc.port $authPort " +
                 "--allow-insecure-unlock --unlock 0x$addr --password `"$pwFile`" " +
                 "--mine --miner.etherbase 0x$addr --miner.gasprice 0 --txpool.pricelimit 0 console"

    $batchPath = Join-Path $rootDir "run-node$i.bat"
    "@echo off`r`ngeth $argString`r`necho.`r`necho [node$i exited - press any key to close this window]`r`npause >nul" |
        Set-Content -Path $batchPath -Encoding ASCII

    Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "`"$batchPath`"" -WorkingDirectory $rootDir -WindowStyle Normal
    Write-Host "  node$i started -> RPC http://127.0.0.1:$rpcPort  P2P port $port" -ForegroundColor Green
}

Write-Host ""
Write-Host "Waiting 15 seconds for all 4 nodes to finish starting up ..." -ForegroundColor Cyan
Start-Sleep -Seconds 15

# ============================================================
# PART 5: AUTO-CONNECT ALL NODES AS PEERS (via RPC, no manual copy/paste)
# ============================================================
Write-Host "Fetching enode addresses over RPC ..." -ForegroundColor Cyan

function Invoke-GethRpc {
    param($Port, $Method, $Params = @())
    $body = @{ jsonrpc = "2.0"; method = $Method; params = $Params; id = 1 } | ConvertTo-Json -Depth 5
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port" -Method Post -Body $body -ContentType "application/json"
        return $resp.result
    } catch {
        Write-Host "  RPC call to port $Port failed: $_" -ForegroundColor Red
        return $null
    }
}

$enodes = @{}
for ($i = 1; $i -le 4; $i++) {
    $rpcPort = $baseRpc + ($i - 1)
    $info = Invoke-GethRpc -Port $rpcPort -Method "admin_nodeInfo"
    if ($info) {
        # Replace the placeholder host in the enode URL with 127.0.0.1 explicitly
        $enodes[$i] = $info.enode -replace "@.*?:", "@127.0.0.1:"
        Write-Host "  node$i enode: $($enodes[$i])" -ForegroundColor Green
    } else {
        Write-Host "  Could not fetch enode for node$i - is it still starting? Try running Part 5 manually later." -ForegroundColor Yellow
    }
}

Write-Host "Cross-connecting all nodes as peers ..." -ForegroundColor Cyan
for ($i = 1; $i -le 4; $i++) {
    $rpcPortI = $baseRpc + ($i - 1)
    for ($j = 1; $j -le 4; $j++) {
        if ($i -ne $j -and $enodes.ContainsKey($j)) {
            Invoke-GethRpc -Port $rpcPortI -Method "admin_addPeer" -Params @($enodes[$j]) | Out-Null
        }
    }
}

Write-Host ""
Write-Host "Done. Verify peering by running in any node's console window: admin.peers" -ForegroundColor Cyan
Write-Host "You should see 3 connected peers in each node's list." -ForegroundColor Cyan
