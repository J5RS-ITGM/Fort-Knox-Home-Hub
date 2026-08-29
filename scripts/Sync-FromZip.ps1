<#
.SYNOPSIS
  Sync a HomeHub session zip from Claude into this repo, commit, and push.

.DESCRIPTION
  Extracts the zip to a temp dir, mirrors it over the repo working tree
  (robocopy /MIR), then commits and pushes. Mirroring means files deleted
  in the session are deleted locally too. Protected from the mirror (never
  copied, never deleted): .git, node_modules, .venv, .next, __pycache__,
  .env files, and *.db — so local installs, secrets, and git history are
  untouched.

.EXAMPLE
  .\scripts\Sync-FromZip.ps1 -Zip $HOME\Downloads\homehub.zip
  .\scripts\Sync-FromZip.ps1 -Zip $HOME\Downloads\homehub.zip -Message "WallPanel radar module"
  .\scripts\Sync-FromZip.ps1 -Zip $HOME\Downloads\homehub.zip -NoPush   # commit only
#>
param(
  [Parameter(Mandatory = $true)][string]$Zip,
  [string]$Message = ("Sync from Claude session " + (Get-Date -Format "yyyy-MM-dd HH:mm")),
  [switch]$NoPush
)

$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot   # repo root (this script lives in scripts/)

if (-not (Test-Path $Zip)) { throw "Zip not found: $Zip" }
if (-not (Test-Path (Join-Path $Repo ".git"))) { throw "Not a git repo: $Repo" }

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("homehub_" + [guid]::NewGuid().ToString("N"))
Expand-Archive -Path $Zip -DestinationPath $Tmp -Force

# Zip root may be the files directly, or wrapped in a single homehub/ folder.
$Src = $Tmp
if ((Test-Path (Join-Path $Tmp "homehub")) -and -not (Test-Path (Join-Path $Tmp "backend"))) {
  $Src = Join-Path $Tmp "homehub"
}

robocopy $Src $Repo /MIR `
  /XD .git node_modules .venv .next __pycache__ `
  /XF .env .env.local *.db `
  /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
Remove-Item $Tmp -Recurse -Force

Push-Location $Repo
try {
  git add -A
  $pending = git status --porcelain
  if (-not $pending) { Write-Host "Nothing to commit — repo already matches the zip."; return }
  git commit -m $Message
  if (-not $NoPush) { git push }
  Write-Host "Done: committed$(if (-not $NoPush) { ' and pushed' })."
}
finally { Pop-Location }
