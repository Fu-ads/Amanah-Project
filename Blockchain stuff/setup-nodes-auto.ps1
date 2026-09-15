<#
.SYNOPSIS
  Fully automated setup for the 4-node Clique PoA network - generates all
  4 signer accounts non-interactively (random passwords, addresses captured
  automatically), builds genesis.json, inits each node, launches all 4, and
  auto-peers them. No manual typing, no manual address copy-paste.

.PREREQUISITES
  - geth on PATH (confirm with: geth version)

.USAGE
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  .\setup-nodes-auto.ps1
  Run it from an empty (or fresh) working folder - it creates node1..node4
  itself.

.SECURITY NOTE
  RPC is bound to 0.0.0.0 (reachable from outside this machine) and each
  node runs with --unlock, so its signer account stays unlocked for the
  life of the process. These 4 generated accounts are pure infrastructure
  (they seal blocks) - they should never hold real funds and are separate
  from the MetaMask addresses your actual voters use.
#>

$CHAIN_ID    = 15
$PERIOD      = 5
$BASE_PORT   = 30301
$BASE_RPC    = 8545
$BASE_AUTH_RPC = 8551
$ROOT_DIR    = Get-Location

if (-not (Get-Command geth -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: geth not found on PATH." -ForegroundColor Red
    exit 1
}

function New-RandomPassword {
    -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
}

# ============================================================
# STEP 1: GENERATE 4 ACCOUNTS NON-INTERACTIVELY
# ============================================================
$voters = @()

for ($i = 1; $i -le 4; $i++) {
    $dir = Join-Path $ROOT_DIR "node$i"
    $keystoreDir = Join-Path $dir "keystore"
    $pwFile = Join-Path $dir "password.txt"

    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    if (-not (Test-Path $pwFile)) {
        Write-Host "Generating password for node$i ..." -ForegroundColor Cyan
        New-RandomPassword | Set-Content -Path $pwFile -Encoding ASCII -NoNewline
    }

    $existing = if (Test-Path $keystoreDir) { Get-ChildItem $keystoreDir -ErrorAction SilentlyContinue } else { $null }

    if ($existing) {
        Write-Host "node$i already has an account, reusing it." -ForegroundColor Yellow
        # Address is embedded in the keystore filename after the second "--"
        $addr = ($existing[0].Name -split '--')[2]
    } else {
        Write-Host "Creating account for node$i (non-interactive) ..." -ForegroundColor Cyan
        $output = & geth account new --datadir $dir --password $pwFile 2>&1 | Out-String
        if ($output -notmatch '0x[0-9a-fA-F]{40}') {
            Write-Host "ERROR: could not parse a new address for node$i. Full output:" -ForegroundColor Red
            Write-Host $output
            exit 1
        }
        $addr = ($Matches[0]).Substring(2)  # strip 0x for use in extradata/array
    }

    $voters += $addr
    Write-Host "  node$i address: 0x$addr" -ForegroundColor Green
}

# ============================================================
# STEP 2: BUILD genesis.json
# ============================================================
Write-Host "Building genesis.json ..." -ForegroundColor Cyan

$zeroPad32 = "0" * 64
$zeroPad65 = "0" * 130
$signers   = ($voters -join "")
$extraData = "0x$zeroPad32$signers$zeroPad65"

$alloc = @{}
foreach ($v in $voters) {
    $alloc["0x$v"] = @{ balance = "100000000000000000000" }
}

$genesis = @{
    config = @{
        chainId             = $CHAIN_ID
        homesteadBlock      = 0
        eip150Block         = 0
        eip155Block         = 0
        eip158Block         = 0
        byzantiumBlock      = 0
        constantinopleBlock = 0
        petersburgBlock     = 0
        istanbulBlock       = 0
        terminalTotalDifficulty       = 5000000000000000000
        terminalTotalDifficultyPassed = $false
        clique              = @{ period = $PERIOD; epoch = 30000 }
    }
    difficulty = "1"
    gasLimit   = "8000000"
    extradata  = $extraData
    alloc      = $alloc
}

$genesisPath = Join-Path $ROOT_DIR "genesis.json"
$genesis | ConvertTo-Json -Depth 6 | Set-Content -Path $genesisPath -Encoding ASCII
Write-Host "Wrote $genesisPath" -ForegroundColor Green

# ============================================================
# STEP 3: INIT EACH NODE (wiping stale chain data first)
# ============================================================
for ($i = 1; $i -le 4; $i++) {
    $dir = Join-Path $ROOT_DIR "node$i"
    $chainDataDir = Join-Path $dir "geth"
    if (Test-Path $chainDataDir) {
        Write-Host "Removing stale chain data for node$i ..." -ForegroundColor Yellow
        Remove-Item $chainDataDir -Recurse -Force
    }
    Write-Host "Initializing node$i ..." -ForegroundColor Cyan
    & geth --datadir $dir init $genesisPath
}

# ============================================================
# STEP 4: LAUNCH ALL 4 NODES
# ============================================================
Write-Host "Launching 4 nodes ..." -ForegroundColor Cyan

for ($i = 1; $i -le 4; $i++) {
    $dir      = Join-Path $ROOT_DIR "node$i"
    $addr     = $voters[$i - 1]
    $port     = $BASE_PORT + ($i - 1)
    $rpcPort  = $BASE_RPC + ($i - 1)
    $authPort = $BASE_AUTH_RPC + ($i - 1)
    $pwFile   = Join-Path $dir "password.txt"

    $argString = "--datadir `"$dir`" --networkid $CHAIN_ID --port $port " +
                 "--http --http.addr 0.0.0.0 --http.port $rpcPort " +
                 "--http.api personal,eth,net,web3,clique,admin " +
                 "--http.corsdomain `"*`" --http.vhosts `"*`" " +
                 "--ipcdisable --authrpc.port $authPort " +
                 "--allow-insecure-unlock --unlock 0x$addr --password `"$pwFile`" " +
                 "--mine --miner.etherbase 0x$addr --miner.gasprice 0 --txpool.pricelimit 0 console"

    $batchPath = Join-Path $ROOT_DIR "run-node$i.bat"
    "@echo off`r`ngeth $argString`r`necho.`r`necho [node$i exited - press any key to close this window]`r`npause >nul" |
        Set-Content -Path $batchPath -Encoding ASCII

    Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "`"$batchPath`"" -WorkingDirectory $ROOT_DIR -WindowStyle Normal
    Write-Host "  node$i started -> RPC http://0.0.0.0:$rpcPort  P2P port $port" -ForegroundColor Green
}

Write-Host ""
Write-Host "Waiting 15 seconds for all 4 nodes to finish starting up ..." -ForegroundColor Cyan
Start-Sleep -Seconds 15

# ============================================================
# STEP 5: AUTO-CONNECT ALL NODES AS PEERS
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
    $rpcPort = $BASE_RPC + ($i - 1)
    $info = Invoke-GethRpc -Port $rpcPort -Method "admin_nodeInfo"
    if ($info) {
        $enodes[$i] = $info.enode -replace "@.*?:", "@127.0.0.1:"
        Write-Host "  node$i enode: $($enodes[$i])" -ForegroundColor Green
    } else {
        Write-Host "  Could not fetch enode for node$i - is it still starting?" -ForegroundColor Yellow
    }
}

Write-Host "Cross-connecting all nodes as peers ..." -ForegroundColor Cyan
for ($i = 1; $i -le 4; $i++) {
    $rpcPortI = $BASE_RPC + ($i - 1)
    for ($j = 1; $j -le 4; $j++) {
        if ($i -ne $j -and $enodes.ContainsKey($j)) {
            Invoke-GethRpc -Port $rpcPortI -Method "admin_addPeer" -Params @($enodes[$j]) | Out-Null
        }
    }
}

Write-Host ""
Write-Host "Done. Your 4 signer addresses (for reference, no action needed):" -ForegroundColor Cyan
for ($i = 1; $i -le 4; $i++) { Write-Host "  node$i : 0x$($voters[$i-1])" }
Write-Host ""
Write-Host "Verify peering in any node's console window: admin.peers (should show 3)" -ForegroundColor Cyan
