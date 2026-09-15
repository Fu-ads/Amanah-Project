<#
.SYNOPSIS
  Fully automates supplying the 4 voter private keys to Hardhat, without
  using hardhat-keystore's interactive prompt (which is what caused the
  "got object" bug - a malformed value getting typed/pasted into it).

  Instead, this decrypts each node's geth keystore file directly and sets
  the results as SESSION-ONLY environment variables. Hardhat's
  configVariable() reads from environment variables automatically when
  nothing is in the keystore, so hardhat.config.ts needs no changes.

.PREREQUISITES
  - Run from inside halal-vote-project (where `ethers` is installed)
  - node1..node4 folders (with keystore + password.txt) exist one level up,
    i.e. at ..\node1, ..\node2, etc. Adjust $nodesRoot below if different.

.USAGE
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  .\load-voter-keys.ps1
  # then, in the SAME window:
  npx hardhat run scripts/deploy.ts --network privatePoA
  # (or just let this script run the deploy for you automatically - see bottom)
#>

$nodesRoot = ".."   # adjust if your node1-4 folders live somewhere else

# Recreate the tiny decrypt helper if it isn't already sitting here
if (-not (Test-Path "decrypt-key.mjs")) {
@'
import { ethers } from "ethers";
import { readFileSync } from "fs";

const keystoreJson = readFileSync(process.argv[2], "utf8");
const password = process.argv[3];

const wallet = ethers.Wallet.fromEncryptedJsonSync(keystoreJson, password);
console.log(wallet.privateKey);
'@ | Set-Content -Path "decrypt-key.mjs" -Encoding UTF8
}

for ($i = 1; $i -le 4; $i++) {
    $nodeDir = Join-Path $nodesRoot "node$i"
    $keystoreDir = Join-Path $nodeDir "keystore"
    $pwFile = Join-Path $nodeDir "password.txt"

    if (-not (Test-Path $keystoreDir) -or -not (Test-Path $pwFile)) {
        Write-Host "ERROR: node$i is missing keystore/ or password.txt at $nodeDir" -ForegroundColor Red
        exit 1
    }

    $keystoreFile = Get-ChildItem $keystoreDir | Select-Object -First 1
    if (-not $keystoreFile) {
        Write-Host "ERROR: no keystore file found in $keystoreDir" -ForegroundColor Red
        exit 1
    }

    $password = (Get-Content $pwFile -Raw).Trim()

    Write-Host "Decrypting node$i keystore ..." -ForegroundColor Cyan
    $privateKey = node decrypt-key.mjs $keystoreFile.FullName $password 2>&1

    if ($privateKey -notmatch '^0x[0-9a-fA-F]{64}$') {
        Write-Host "ERROR: decryption for node$i did not produce a valid private key. Output was:" -ForegroundColor Red
        Write-Host $privateKey
        exit 1
    }

    # Session-scoped only - not saved permanently, not written to disk anywhere
    [Environment]::SetEnvironmentVariable("VOTER${i}_PRIVATE_KEY", $privateKey, "Process")
    Write-Host "  VOTER${i}_PRIVATE_KEY set for this session (node$i, $($keystoreFile.Name))" -ForegroundColor Green
}

Write-Host ""
Write-Host "All 4 keys loaded into this session's environment." -ForegroundColor Cyan
Write-Host "Running deploy now ..." -ForegroundColor Cyan
npx hardhat run scripts/deploy.ts --network privatePoA
