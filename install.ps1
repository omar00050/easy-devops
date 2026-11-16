<#
.SYNOPSIS
  Easy DevOps Bootstrap Installer for Windows

.DESCRIPTION
  Installs Node.js (via nvm-windows), project dependencies, and registers
  the easy-devops CLI command globally.

.PARAMETER Help
  Print this help message and exit.

.PARAMETER Version
  Skip the version picker and use the specified Node.js major version.
  Example: -Version 20

.PARAMETER KeepNode
  Skip Node.js management entirely. Proceeds directly to dependency
  installation using whatever Node.js is currently active.

.PARAMETER Service
  Install the background service at the end without asking. On Windows Server
  this installs a real Windows Service and relaunches elevated through UAC if
  needed; otherwise it installs the logon launcher. No password is ever asked
  for.

.PARAMETER NoService
  Do not install the background service, and do not ask.

.EXAMPLE
  .\install.ps1                  # Interactive install
  .\install.ps1 -Version 20      # Install Node.js 20.x (latest patch via nvm)
  .\install.ps1 -KeepNode        # Skip Node.js management
#>
param(
  [switch]$Help,
  [string]$Version  = "",
  [switch]$KeepNode,
  [switch]$Service,
  [switch]$NoService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$REQUIRED_NODE_MAJOR = 18
$NVM_WINDOWS_VERSION = '1.1.12'
$NODE_FALLBACK       = '20'

# ─── Summary tracking (mirrors install.sh add_result) ────────────────────────

$stepResults = [System.Collections.Generic.List[PSCustomObject]]::new()

function Add-Result {
  param([string]$Name, [bool]$OK, [string]$Detail = '')
  $script:stepResults.Add([PSCustomObject]@{ Name = $Name; OK = $OK; Detail = $Detail })
}

# ─── Output helpers ───────────────────────────────────────────────────────────

$script:currentStep = 0
$script:totalSteps  = 7   # always 7; package-mode steps shown as skipped

function Write-Step {
  param([string]$msg)
  $script:currentStep++
  Write-Host ""
  Write-Host "  [$script:currentStep/$script:totalSteps] $msg" -ForegroundColor Cyan
  Write-Host "  $('-' * 50)" -ForegroundColor DarkGray
}

function Write-OK   { param([string]$msg) Write-Host "         OK   $msg" -ForegroundColor Green  }
function Write-Warn { param([string]$msg) Write-Host "       WARN   $msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$msg) Write-Host "      ERROR   $msg" -ForegroundColor Red    }
function Write-Info { param([string]$msg) Write-Host "             $msg"  -ForegroundColor Gray   }

function Refresh-Path {
  # Read NVM vars from User scope, fall back to Machine scope
  # (nvm-windows writes to Machine on system-wide installs)
  $nvmHome = [System.Environment]::GetEnvironmentVariable('NVM_HOME', 'User')
  if (-not $nvmHome) { $nvmHome = [System.Environment]::GetEnvironmentVariable('NVM_HOME', 'Machine') }
  $nvmSymlink = [System.Environment]::GetEnvironmentVariable('NVM_SYMLINK', 'User')
  if (-not $nvmSymlink) { $nvmSymlink = [System.Environment]::GetEnvironmentVariable('NVM_SYMLINK', 'Machine') }

  if ($nvmHome)    { $env:NVM_HOME    = $nvmHome }
  if ($nvmSymlink) { $env:NVM_SYMLINK = $nvmSymlink }

  $raw = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
         [System.Environment]::GetEnvironmentVariable('Path', 'User')

  # Expand literal %NVM_HOME% / %NVM_SYMLINK% tokens nvm-windows may have written
  if ($nvmHome)    { $raw = $raw -ireplace [regex]::Escape('%NVM_HOME%'),    $nvmHome }
  if ($nvmSymlink) { $raw = $raw -ireplace [regex]::Escape('%NVM_SYMLINK%'), $nvmSymlink }

  $env:Path = $raw

  # Ensure NVM_SYMLINK is in PATH even if the registry entry was already absolute
  if ($nvmSymlink -and (Test-Path $nvmSymlink -ErrorAction SilentlyContinue)) {
    if ($env:Path -notlike "*$([regex]::Escape($nvmSymlink))*") {
      $env:Path = "$nvmSymlink;$env:Path"
    }
  }
}

# Find nvm.exe: checks PATH first, then known install locations
function Find-NvmExe {
  try {
    $f = (& where.exe nvm 2>$null)
    if ($LASTEXITCODE -eq 0 -and $f) { return 'nvm' }
  } catch {}

  $candidates = @()
  if ($env:NVM_HOME)    { $candidates += Join-Path $env:NVM_HOME    'nvm.exe' }
  if ($env:APPDATA)     { $candidates += Join-Path $env:APPDATA     'nvm\nvm.exe' }
  if ($env:ProgramData) { $candidates += Join-Path $env:ProgramData 'nvm\nvm.exe' }
  $candidates += 'C:\ProgramData\nvm\nvm.exe'

  foreach ($c in $candidates) {
    if (Test-Path $c -ErrorAction SilentlyContinue) {
      $dir = Split-Path $c -Parent
      if ($env:Path -notlike "*$dir*") { $env:Path = "$dir;$env:Path" }
      return $c
    }
  }
  return $null
}

function Get-NodeMajor {
  param([string]$version)
  try { return [int](($version -replace '^v','').Split('.')[0]) } catch { return 0 }
}

# ─── Help output ──────────────────────────────────────────────────────────────

function Print-Help {
  Write-Host ""
  Write-Host "Easy DevOps Bootstrap Installer" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Usage:"
  Write-Host "  .\install.ps1 [OPTIONS]"
  Write-Host ""
  Write-Host "Options:"
  Write-Host "  -Help            Print this help and exit"
  Write-Host "  -Version <ver>   Skip the version picker; install specified Node.js major"
  Write-Host "                   Example: -Version 20"
  Write-Host "  -KeepNode        Skip Node.js management; use current Node.js on PATH"
  Write-Host ""
  Write-Host "Exit codes:"
  Write-Host "  0  Installation completed successfully"
  Write-Host "  1  Unrecoverable error"
  Write-Host "  2  User cancelled"
  Write-Host ""
  Write-Host "Examples:"
  Write-Host "  .\install.ps1                  # Interactive install"
  Write-Host "  .\install.ps1 -Version 20      # Install Node.js 20.x"
  Write-Host "  .\install.ps1 -KeepNode        # Skip Node.js management"
  Write-Host ""
}

if ($Help) {
  Print-Help
  exit 0
}

# ─── BITS/WebClient download with progress ────────────────────────────────────

function Download-File {
  param([string]$Url, [string]$Dest, [string]$Label)

  $bitsOK = $false
  try { Import-Module BitsTransfer -ErrorAction Stop; $bitsOK = $true } catch {}

  if ($bitsOK) {
    try {
      Write-Info "Downloading $Label..."
      Start-BitsTransfer `
        -Source      $Url  `
        -Destination $Dest `
        -DisplayName "Easy DevOps Installer" `
        -Description "Downloading $Label" `
        -ErrorAction Stop
      return
    } catch {
      Write-Info "BITS unavailable, falling back to WebClient..."
    }
  }

  Write-Info "Downloading $Label..."
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('User-Agent', 'EasyDevOps-Installer/1.0')
  try   { $wc.DownloadFile($Url, $Dest) }
  finally { $wc.Dispose() }
}

# ─── Fetch Node.js LTS versions from nodejs.org ───────────────────────────────

$script:ltsVersions = $null

function Fetch-NodeVersions {
  Write-Info "Fetching available Node.js LTS versions from nodejs.org..."

  try {
    $releases = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 20

    $script:ltsVersions = $releases |
      Where-Object { $_.lts -and $_.lts -ne $false } |
      Group-Object { ($_.version -replace '^v(\d+)\..*', '$1') } |
      ForEach-Object {
        $_.Group | Sort-Object { [System.Version]($_.version -replace '^v','') } -Descending |
                   Select-Object -First 1
      } |
      Sort-Object { [int]($_.version -replace '^v(\d+)\..*','$1') } -Descending |
      Select-Object -First 6

    if (-not $script:ltsVersions -or @($script:ltsVersions).Count -eq 0) {
      Write-Warn "No LTS versions found in response."
      return $false
    }
    return $true
  } catch {
    Write-Warn "Could not fetch version list: $_"
    return $false
  }
}

# ─── Interactive version picker ───────────────────────────────────────────────

function Select-NodeVersion {
  param([string]$CurrentVersion = "")

  $list = @($script:ltsVersions)

  Write-Host ""
  Write-Host "  Available Node.js LTS versions:" -ForegroundColor Cyan
  Write-Host ""

  for ($i = 0; $i -lt $list.Count; $i++) {
    $v       = $list[$i]
    $ltsName = if ($v.lts -is [string] -and $v.lts) { "  ($($v.lts))" } else { "" }
    $current = if ($CurrentVersion -and ($v.version -replace '^v(\d+)\..*','$1') -eq ($CurrentVersion -replace '^v(\d+)\..*','$1')) { "  [current]" } else { "" }
    $def     = if ($i -eq 0) { " <- default" } else { "" }
    Write-Host "    [$($i+1)] $($v.version)$ltsName$current$def" -ForegroundColor White
  }

  Write-Host ""

  $majorVersion = $NODE_FALLBACK
  while ($true) {
    $raw = Read-Host "  Choose a version [1-$($list.Count), press Enter for default]"
    if ([string]::IsNullOrWhiteSpace($raw)) { $raw = "1" }

    if ($raw -match '^\d+$') {
      $idx = [int]$raw - 1
      if ($idx -ge 0 -and $idx -lt $list.Count) {
        $majorVersion = ($list[$idx].version -replace '^v(\d+)\..*', '$1')
        Write-OK "Selected $($list[$idx].version)"
        return $majorVersion
      }
    }
    Write-Warn "Please enter a number between 1 and $($list.Count)"
  }
}

# ─── Detect install mode ──────────────────────────────────────────────────────
# source  = running from a git-cloned project directory  -> npm install + npm link
# update  = easy-devops already on PATH                  -> skip install steps
# npm     = downloaded installer standalone              -> npm install -g easy-devops

$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageJson = Join-Path $scriptDir 'package.json'

$isSourceMode       = $false
$isAlreadyInstalled = $false
$existingCmd        = $null

# Source mode: script dir has this project's package.json
if (Test-Path $packageJson) {
  try {
    $pkg = Get-Content $packageJson -Raw | ConvertFrom-Json
    if ($pkg.name -eq 'easy-devops') { $isSourceMode = $true }
  } catch {}
}

# Already installed: easy-devops on PATH
try {
  $existingCmd = (& where.exe easy-devops 2>$null)
  if ($LASTEXITCODE -eq 0 -and $existingCmd) { $isAlreadyInstalled = $true }
} catch {}

# ─── Banner ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host "    Easy DevOps  --  Windows Installer" -ForegroundColor Cyan
Write-Host "  ==========================================" -ForegroundColor Cyan

Write-Host ""
if ($isAlreadyInstalled) {
  Write-Host "  Mode: update  (easy-devops already installed at $existingCmd)" -ForegroundColor DarkGray
  Write-Host "        Node.js will still be managed; npm steps skipped." -ForegroundColor DarkGray
} elseif ($isSourceMode) {
  Write-Host "  Mode: source  (project directory -- npm install + npm link)" -ForegroundColor DarkGray
} else {
  Write-Host "  Mode: npm     (will run: npm install -g easy-devops)" -ForegroundColor DarkGray
}

# ─── Step 1: Detect system ───────────────────────────────────────────────────

Write-Step "Detecting system"

$osVer = [System.Environment]::OSVersion.Version
if ($osVer.Major -lt 10) {
  Write-Err "Windows 10 or later is required (found $($osVer.Major).$($osVer.Minor))"
  exit 1
}
Write-OK "Windows $($osVer.Major).$($osVer.Minor)"
Add-Result "System detection" $true "Windows $($osVer.Major).$($osVer.Minor)"

if ($PSVersionTable.PSVersion.Major -lt 5) {
  Write-Err "PowerShell 5.1+ is required (found $($PSVersionTable.PSVersion))"
  exit 1
}
Write-OK "PowerShell $($PSVersionTable.PSVersion)"

if (-not $KeepNode) {
  try {
    $null = Invoke-WebRequest -Uri "https://nodejs.org" -UseBasicParsing -TimeoutSec 10
    Write-OK "Internet connectivity confirmed"
  } catch {
    Write-Err "No internet connection. Please check your network and try again."
    exit 1
  }
}

# Detect existing Node.js
$nodeOK      = $false
$nodeVersion = $null

try {
  $raw = (& node --version 2>$null).Trim()
  if ($LASTEXITCODE -eq 0 -and $raw -match '^v') {
    $nodeVersion = $raw
    $major = Get-NodeMajor $nodeVersion
    if ($major -ge $REQUIRED_NODE_MAJOR) {
      Write-OK "Node.js $nodeVersion -- compatible"
      $nodeOK = $true
    } else {
      Write-Warn "Node.js $nodeVersion found but v$REQUIRED_NODE_MAJOR+ is required"
    }
  } else {
    Write-Info "Node.js not found on PATH"
  }
} catch {
  Write-Info "Node.js not found on PATH"
}

# ─── Step 2: Fetch Node.js release list ──────────────────────────────────────

$NODE_ACTION = ""    # keep | upgrade | switch
$NODE_TARGET = ""    # major version string

if ($KeepNode) {
  Write-Step "Fetching Node.js release list"
  Write-OK "Skipped (--KeepNode)"
  Add-Result "Node.js release list" $true "Skipped (-KeepNode)"
  $NODE_ACTION = "keep"
} elseif ($Version -ne "") {
  Write-Step "Fetching Node.js release list"
  Write-OK "Skipped (-Version $Version specified)"
  Add-Result "Node.js release list" $true "Skipped (-Version $Version)"
  $NODE_ACTION = "switch"
  $NODE_TARGET = $Version
} else {
  Write-Step "Fetching Node.js release list"
  $fetchOK = Fetch-NodeVersions
  if (-not $fetchOK) {
    Write-Warn "Using fallback version $NODE_FALLBACK."
    $script:ltsVersions = @([PSCustomObject]@{ version = "v$NODE_FALLBACK.0.0"; lts = "LTS" })
  }
  Add-Result "Node.js release list" $true "$(@($script:ltsVersions).Count) LTS versions fetched"
}

# ─── Step 3: Node.js version selection ───────────────────────────────────────

if ($NODE_ACTION -eq "keep") {
  Write-Step "Node.js version selection"
  Write-OK "Skipped (-KeepNode)"
  Add-Result "Node.js selection" $true "Skipped (-KeepNode)"
} elseif ($Version -ne "") {
  Write-Step "Node.js version selection"
  Write-OK "Skipped (using -Version $Version)"
  Add-Result "Node.js selection" $true "$Version"
} else {
  Write-Step "Node.js version selection"

  if ($nodeOK) {
    # Node >= 18 already installed: 3-option menu (mirrors install.sh)
    Write-Host ""
    Write-Host "  Node.js $nodeVersion is already installed." -ForegroundColor White
    Write-Host "  What would you like to do?" -ForegroundColor White
    Write-Host ""
    Write-Host "    [1] Keep current version ($nodeVersion)"     -ForegroundColor White
    Write-Host "    [2] Upgrade to latest LTS automatically"     -ForegroundColor White
    Write-Host "    [3] Switch to a different version (picker)"  -ForegroundColor White
    Write-Host ""

    while ($true) {
      $raw = Read-Host "  Enter 1, 2, or 3 (q to quit)"
      switch ($raw.Trim()) {
        "1" {
          $NODE_ACTION = "keep"
          $NODE_TARGET = ""
          break
        }
        "2" {
          $NODE_ACTION = "upgrade"
          # Pick the newest LTS from the fetched list
          $list = @($script:ltsVersions)
          if ($list.Count -gt 0) {
            $NODE_TARGET = ($list[0].version -replace '^v(\d+)\..*','$1')
          } else {
            $NODE_TARGET = $NODE_FALLBACK
          }
          Write-OK "Upgrading to latest LTS (major $NODE_TARGET)"
          break
        }
        "3" {
          $NODE_ACTION = "switch"
          $NODE_TARGET = Select-NodeVersion -CurrentVersion $nodeVersion
          break
        }
        { $_ -eq "q" -or $_ -eq "Q" } {
          Write-Host ""
          Write-Host "  Installation cancelled by user." -ForegroundColor Yellow
          exit 2
        }
        default {
          Write-Warn "Invalid choice. Please enter 1, 2, or 3."
          continue
        }
      }
      break
    }

    if ($NODE_ACTION -eq "keep") {
      Write-OK "Keeping Node.js $nodeVersion"
      Add-Result "Node.js selection" $true "Keep $nodeVersion"
    } else {
      Add-Result "Node.js selection" $true "$NODE_ACTION -> $NODE_TARGET"
    }
  } else {
    # Node not installed or below 18: go straight to picker
    if ($script:ltsVersions) {
      $NODE_TARGET = Select-NodeVersion
    } else {
      $NODE_TARGET = $NODE_FALLBACK
      Write-OK "Using default Node.js $NODE_TARGET"
    }
    $NODE_ACTION = "switch"
    Add-Result "Node.js selection" $true "$NODE_TARGET"
  }
}

# ─── Step 4: Install nvm-windows ─────────────────────────────────────────────

$nvmReady   = $false
$nvmVersion = $null

if ($NODE_ACTION -eq "keep") {
  Write-Step "Installing nvm-windows"
  Write-OK "Skipped (keeping current Node.js)"
  Add-Result "nvm-windows" $true "Skipped (keep)"
  $nvmReady = $true
} else {
  Write-Step "Installing nvm-windows"

  # Check if nvm-windows is already present (check PATH + known locations)
  Refresh-Path
  $nvmExeCheck = Find-NvmExe
  if ($nvmExeCheck) {
    try {
      $nvmVersion = (& $nvmExeCheck version 2>$null).Trim()
      if ($nvmVersion) {
        Write-OK "nvm-windows $nvmVersion already installed"
        Add-Result "nvm-windows" $true $nvmVersion
        $nvmReady = $true
      }
    } catch {}
  }

  if (-not $nvmReady) {
    # After Refresh-Path, try locating nvm at known paths
    Refresh-Path
    $nvmExePath = Find-NvmExe
    if ($nvmExePath) {
      try {
        $nvmVersion = (& $nvmExePath version 2>$null).Trim()
        if ($nvmVersion) {
          Write-OK "nvm-windows $nvmVersion already installed (found after PATH refresh)"
          Add-Result "nvm-windows" $true $nvmVersion
          $nvmReady = $true
        }
      } catch {}
    }
  }

  if (-not $nvmReady) {
    $skipNvm  = $false

    if ($nodeOK) {
      Write-Host ""
      Write-Host "  nvm-windows is not installed." -ForegroundColor Yellow
      Write-Host "  Required for 'nvm install $NODE_TARGET'. Install now?" -ForegroundColor Gray
      Write-Host ""
      $answer = Read-Host "  Install nvm-windows? [Y/n]"
      if ($answer -match '^[Nn]') {
        Write-Info "Skipping nvm-windows."
        Add-Result "nvm-windows" $true "Skipped (optional)"
        $skipNvm = $true
      }
    }

    if (-not $skipNvm) {
      $installer = "$env:TEMP\nvm-setup.exe"
      $nvmUrl    = "https://github.com/coreybutler/nvm-windows/releases/download/$NVM_WINDOWS_VERSION/nvm-setup.exe"

      try {
        Download-File -Url $nvmUrl -Dest $installer -Label "nvm-windows $NVM_WINDOWS_VERSION"
        Write-OK "Downloaded"
      } catch {
        Write-Err "Download failed: $_"
        Write-Info "Manual: https://github.com/coreybutler/nvm-windows/releases"
        Add-Result "nvm-windows" $false "Download failed"
        if (-not $nodeOK) { exit 1 }
      }

      if (Test-Path $installer) {
        try {
          Write-Info "Running installer silently..."
          $proc = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
          if ($proc.ExitCode -ne 0) {
            Write-Err "Installer exited with code $($proc.ExitCode)"
            Add-Result "nvm-windows" $false "Exit code $($proc.ExitCode)"
            if (-not $nodeOK) { exit 1 }
          } else {
            Write-OK "nvm-windows $NVM_WINDOWS_VERSION installed"
            Add-Result "nvm-windows" $true $NVM_WINDOWS_VERSION
            $nvmReady = $true
          }
        } catch {
          Write-Err "Installer failed: $_"
          Add-Result "nvm-windows" $false "$_"
          if (-not $nodeOK) { exit 1 }
        } finally {
          try { Remove-Item $installer -Force -ErrorAction SilentlyContinue } catch {}
        }

        Refresh-Path
      }
    }
  }
}

# ─── Step 5: Install Node.js via nvm ─────────────────────────────────────────

if ($NODE_ACTION -eq "keep") {
  Write-Step "Installing Node.js via nvm"
  Write-OK "Skipped (keeping current Node.js)"
  Add-Result "Node.js install" $true "Skipped (keep)"
} else {
  Write-Step "Installing Node.js via nvm"

  if ($nvmReady -and (-not $nodeOK -or $NODE_ACTION -eq "upgrade" -or $NODE_ACTION -eq "switch")) {
    Write-Info "Installing Node.js $NODE_TARGET via nvm..."
    $nvmExe = Find-NvmExe
    if (-not $nvmExe) {
      Write-Warn "nvm not found -- open a new terminal and run: nvm install $NODE_TARGET"
      Add-Result "Node.js install" $false "nvm not found"
    } else {
      # IMPORTANT: do NOT pipe nvm output (2>&1 | ...).
      # nvm.exe checks if its stdout is a real console; piping makes it think
      # it is not in a terminal and it shows a GUI dialog instead of running.
      $nvmRunOK = $true
      try {
        & $nvmExe install $NODE_TARGET
        & $nvmExe use     $NODE_TARGET
      } catch {
        Write-Warn "nvm error: $_"
        Add-Result "Node.js install" $false "nvm error -- see above"
        $nvmRunOK = $false
      }

      if ($nvmRunOK) {
        # PATH in this session may still be stale after nvm use.
        # Read NVM_SYMLINK directly from registry and call node.exe by full path.
        Refresh-Path
        $raw = ""
        try { $raw = (& node --version 2>&1).Trim() } catch {}

        if (-not ($raw -match '^v')) {
          $nvmSym = [System.Environment]::GetEnvironmentVariable('NVM_SYMLINK', 'Machine')
          if (-not $nvmSym) { $nvmSym = [System.Environment]::GetEnvironmentVariable('NVM_SYMLINK', 'User') }
          if ($nvmSym) {
            $nodeExe = Join-Path $nvmSym 'node.exe'
            if (Test-Path $nodeExe -ErrorAction SilentlyContinue) {
              # Add to PATH so npm also works in the rest of this script
              if ($env:Path -notlike "*$([regex]::Escape($nvmSym))*") {
                $env:Path = "$nvmSym;$env:Path"
              }
              try { $raw = (& $nodeExe --version 2>&1).Trim() } catch {}
            }
          }
        }

        if ($raw -match '^v') {
          $nodeVersion = $raw
          Write-OK "Node.js $nodeVersion installed and active"
          Add-Result "Node.js install" $true $nodeVersion
          $nodeOK = $true
        } else {
          Write-Warn "Node.js installed but PATH not yet updated in this session"
          Write-Warn "Open a new terminal and run:  nvm use $NODE_TARGET"
          Add-Result "Node.js install" $false "PATH refresh needed -- open a new terminal"
          $nodeOK = $false
        }
      }
    }
  } elseif (-not $nvmReady -and $nodeOK) {
    # nvm not available but Node >= 18 already present: skip
    Write-OK "nvm not available; using existing Node.js $nodeVersion"
    Add-Result "Node.js install" $true "Using existing $nodeVersion"
  } else {
    Write-Warn "No Node.js installed and nvm not available."
    Write-Info "Install Node.js manually from: https://nodejs.org"
    Add-Result "Node.js install" $false "Manual install required"
  }
}

# ─── Steps 6 + 7: Install Easy DevOps & register CLI ─────────────────────────

if ($isAlreadyInstalled) {
  # ── Already installed: skip both steps ──────────────────────────────────────
  Write-Step "Installing Easy DevOps"
  Write-OK "Skipped (easy-devops already installed at $existingCmd)"
  Add-Result "npm install" $true "Skipped (already installed)"

  Write-Step "Registering global command"
  Write-OK "Skipped (already registered)"
  Add-Result "CLI registered" $true "Skipped (already installed)"

} elseif ($isSourceMode) {
  # ── Source mode: npm install in project dir + npm link ───────────────────────
  Write-Step "Installing Easy DevOps dependencies"

  if (-not $nodeOK) {
    Write-Warn "Skipping -- Node.js is not ready. Open a new terminal and re-run install.ps1."
    Add-Result "npm install" $false "Skipped -- Node.js not ready"
  } else {
    try {
      Push-Location $scriptDir
      Write-Info "Running npm install..."
      & npm install
      if ($LASTEXITCODE -ne 0) {
        Write-Err "npm install failed (exit code $LASTEXITCODE)"
        Add-Result "npm install" $false "Exit code $LASTEXITCODE"
        exit 1
      }
      Write-OK "All dependencies installed"
      Add-Result "npm install" $true ""
    } catch {
      Write-Err "npm install error: $_"
      Add-Result "npm install" $false "$_"
      exit 1
    } finally {
      Pop-Location
    }
  }

  Write-Step "Registering global command"

  if (-not $nodeOK) {
    Write-Warn "Skipping -- Node.js is not ready"
    Add-Result "CLI registered" $false "Skipped -- Node.js not ready"
  } else {
    try {
      Push-Location $scriptDir
      & npm link
      if ($LASTEXITCODE -ne 0) {
        Write-Warn "npm link failed -- CLI won't be globally available"
        Write-Warn "You can still run:  node cli/index.js"
        Add-Result "CLI registered" $false "Exit code $LASTEXITCODE"
      } else {
        Write-OK "easy-devops command linked globally"
        Add-Result "CLI registered" $true ""
      }
    } catch {
      Write-Warn "npm link failed: $_ -- run: node cli/index.js"
      Add-Result "CLI registered" $false "$_"
    } finally {
      Pop-Location
    }
  }

} else {
  # ── npm global mode: npm install -g easy-devops ──────────────────────────────
  Write-Step "Installing Easy DevOps"

  if (-not $nodeOK) {
    Write-Warn "Skipping -- Node.js is not ready."
    Write-Warn "Open a new terminal and run:  npm install -g easy-devops"
    Add-Result "npm install" $false "Skipped -- Node.js not ready"
  } else {
    try {
      Write-Info "Running npm install -g easy-devops..."
      & npm install -g easy-devops
      if ($LASTEXITCODE -ne 0) {
        Write-Err "npm install -g easy-devops failed (exit code $LASTEXITCODE)"
        Add-Result "npm install" $false "Exit code $LASTEXITCODE"
        exit 1
      }
      Write-OK "easy-devops installed globally"
      Add-Result "npm install" $true "npm install -g easy-devops"
    } catch {
      Write-Err "npm install -g error: $_"
      Add-Result "npm install" $false "$_"
      exit 1
    }
  }

  Write-Step "Registering global command"
  if ($nodeOK) {
    Write-OK "Registered via npm install -g"
    Add-Result "CLI registered" $true "npm install -g"
  } else {
    Write-Warn "Skipped -- Node.js not ready"
    Add-Result "CLI registered" $false "Skipped -- Node.js not ready"
  }
}

# ─── Summary (mirrors install.sh summary block) ───────────────────────────────

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host "    Installation Summary" -ForegroundColor Cyan
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host ""

$allOK = $true
foreach ($r in $stepResults) {
  if ($r.OK) {
    $icon  = " OK "
    $color = 'Green'
  } else {
    $icon  = "FAIL"
    $color = 'Yellow'
    $allOK = $false
  }
  $detail = if ($r.Detail) { "  ($($r.Detail))" } else { "" }
  Write-Host "    [$icon]  $($r.Name)$detail" -ForegroundColor $color
}

Write-Host ""
if ($allOK) {
  Write-Host "  All steps completed successfully!" -ForegroundColor Green
  Write-Host ""
  Write-Host "  Run the CLI:" -ForegroundColor White
  Write-Host "    easy-devops or ezz" -ForegroundColor Cyan
} else {
  Write-Host "  Some steps need attention -- see warnings above." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  Fallback:" -ForegroundColor White
  Write-Host "    node src/cli/index.js" -ForegroundColor Cyan
}
Write-Host ""

# ─── Offer to install the background service ─────────────────────────────────
#
# Asked LAST, after Node and the package are in place, because `ezz` has to be
# runnable for the answer to mean anything.
#
# Two modes on Windows, and they are genuinely different:
#
#   Server   — a real Windows Service. Starts before anyone logs in. Needs an
#              Administrator terminal once, so this script relaunches itself
#              elevated through UAC if it is not already. NO PASSWORD is ever
#              requested: the service runs as the virtual account
#              NT SERVICE\EasyDevOps, which Windows manages itself.
#   Personal — a launcher in the Startup folder. Starts at logon, needs no
#              administrator rights at all.
#
# The default follows the edition: Server on Windows Server, ask otherwise.

function Test-IsElevated {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

function Get-IsWindowsServer {
  # InstallationType is 'Client', 'Server' or 'Server Core'. os.release() does
  # not distinguish them, and the WMI route takes seconds to start its service
  # on a cold machine; this is immediate.
  try {
    $key = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
    return ($key.InstallationType -like 'Server*')
  } catch {
    return $false
  }
}

function Get-EzCommand {
  foreach ($name in @('ezz', 'easy-devops')) {
    $found = Get-Command $name -ErrorAction SilentlyContinue
    if ($found) { return $name }
  }
  $local = Join-Path $scriptDir 'src\cli\index.js'
  if (Test-Path $local) { return "node `"$local`"" }
  return $null
}

function Invoke-ServiceInstall {
  param([string]$Mode)

  $ez = Get-EzCommand
  if (-not $ez) {
    Write-Host "  Could not find the ezz command, so the service was not installed." -ForegroundColor Yellow
    Write-Host "  Open a new terminal and run: ezz service install" -ForegroundColor Cyan
    return $false
  }

  # Server mode writes under ProgramData, registers a service and sets ACLs,
  # all of which need elevation. If this session is not elevated, relaunch
  # ONLY the service install through UAC rather than re-running the whole
  # installer -- Node is already in place and repeating it would be wasteful
  # and could prompt again.
  if ($Mode -eq 'server' -and -not (Test-IsElevated)) {
    Write-Host ""
    Write-Host "  Server mode needs an Administrator terminal." -ForegroundColor Yellow
    Write-Host "  Windows will ask for consent. You will NOT be asked for a password." -ForegroundColor Gray
    Write-Host ""

    try {
      # -Verb RunAs is what raises the UAC prompt. The child keeps its window
      # open on failure so the user can read the error; a window that vanishes
      # is the usual complaint about elevated helpers.
      $inner = "$ez service install; if (`$LASTEXITCODE -ne 0) { Read-Host 'Press Enter to close' }"
      $proc = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner `
        -Verb RunAs -Wait -PassThru -ErrorAction Stop

      if ($proc.ExitCode -eq 0) { return $true }

      Write-Host "  The elevated install exited with code $($proc.ExitCode)." -ForegroundColor Yellow
      return $false
    } catch {
      # The usual cause is the user declining the UAC prompt, which is a
      # legitimate answer and not an error worth failing the installer over.
      Write-Host "  Elevation was declined or failed, so the service was not installed." -ForegroundColor Yellow
      Write-Host ""
      Write-Host "  To do it yourself: open PowerShell as Administrator and run" -ForegroundColor Gray
      Write-Host "    ezz service install" -ForegroundColor Cyan
      return $false
    }
  }

  # Personal mode, or already elevated: run it here so the prompts appear in
  # this window.
  try {
    Invoke-Expression "$ez service install"
    return ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE)
  } catch {
    Write-Host "  The service install failed: $($_.Exception.Message)" -ForegroundColor Yellow
    return $false
  }
}

function Invoke-ServiceOffer {
  if ($NoService) {
    Write-Host ""
    Write-Host "  Skipping the background service (-NoService)." -ForegroundColor Gray
    Write-Host "  Install it later with: ezz service install" -ForegroundColor Cyan
    Write-Host ""
    return
  }

  $isServer = Get-IsWindowsServer
  $mode = if ($isServer) { 'server' } else { 'personal' }

  if (-not $Service) {
    # Non-interactive host (a CI runner, or piped input): never guess on a
    # question that may need elevation.
    if ([Console]::IsInputRedirected) {
      Write-Host ""
      Write-Host "  No terminal available, so the background service was not installed." -ForegroundColor Gray
      Write-Host "  Install it with:        ezz service install" -ForegroundColor Cyan
      Write-Host "  Or non-interactively:   .\install.ps1 -Service" -ForegroundColor Cyan
      Write-Host ""
      return
    }

    Write-Host ""
    Write-Host "  Easy DevOps can run a background service that keeps monitoring," -ForegroundColor White
    Write-Host "  notifications and the Hub agent alive even with no dashboard open." -ForegroundColor White
    Write-Host ""

    if ($isServer) {
      Write-Host "  This is Windows Server, so Server mode is recommended:" -ForegroundColor White
      Write-Host "    a real Windows Service that starts before anyone logs in." -ForegroundColor Gray
      Write-Host "    Needs Administrator consent once. No password, ever." -ForegroundColor Gray
    } else {
      Write-Host "  On this machine it would start when you log in (Personal mode)," -ForegroundColor White
      Write-Host "    which needs no administrator rights." -ForegroundColor Gray
    }

    Write-Host ""
    $answer = Read-Host "  Install the background service now? (recommended for servers) [Y/n]"

    if ($answer -match '^(n|no)$') {
      Write-Host ""
      Write-Host "  Skipped. Install it later with: ezz service install" -ForegroundColor Gray
      Write-Host ""
      return
    }
  }

  Write-Host ""
  Write-Host "  Installing the background service..." -ForegroundColor Cyan
  Write-Host ""

  $ok = Invoke-ServiceInstall -Mode $mode

  Write-Host ""
  if ($ok) {
    Write-Host "  Background service installed." -ForegroundColor Green
    if ($mode -eq 'personal') {
      Write-Host "  It starts the next time you log in." -ForegroundColor Gray
      Write-Host "  To start it now without signing out: ezz daemon" -ForegroundColor Cyan
    }
  } else {
    Write-Host "  The service was not installed. Nothing else was changed." -ForegroundColor Yellow
    Write-Host "  You can retry with: ezz service install" -ForegroundColor Cyan
  }
  Write-Host ""
}

Invoke-ServiceOffer
