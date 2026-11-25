#!/usr/bin/env bash
# install.sh — Easy DevOps Bootstrap Installer (Linux)
#
# Usage:
#   bash install.sh [OPTIONS]
#
# Options:
#   --help, -h           Print this help and exit 0
#   --version VERSION    Skip picker; use the specified Node.js version
#   --keep-node          Skip Node.js management; proceed to dependency install
#   --service            Install the background service without asking
#   --no-service         Skip the background service without asking
#
# Exit codes:
#   0  Installation completed successfully
#   1  Unrecoverable error
#   2  User cancelled

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve script and project directory
#
# BASH_SOURCE[0] is empty when the script arrives on stdin — `curl | bash`, or
# `bash -s`. In that case the directory this resolves to is just the user's
# current directory and has nothing to do with Easy DevOps, so it must not be
# used to decide anything. PIPED records that distinction once, here, rather
# than letting each later test guess.
# ---------------------------------------------------------------------------
_SELF="${BASH_SOURCE[0]:-}"
case "$_SELF" in
  ''|/dev/stdin|/dev/fd/*|/proc/self/fd/*|bash|sh|-) PIPED=true ;;
  *) PIPED=false ;;
esac

if [ "$PIPED" = "true" ]; then
  # Deliberately not the current directory: see above.
  SCRIPT_DIR=""
else
  SCRIPT_DIR="$(cd "$(dirname "$_SELF")" && pwd)"
fi

EASYDEVOPS_DIR="${EASYDEVOPS_DIR:-${SCRIPT_DIR:-$PWD}}"

# ---------------------------------------------------------------------------
# Lib modules
#
# The modules live at src/lib/installer in the repository and in the published
# npm package (package.json ships `src/`). A copy beside the script always wins.
# A standalone download, or `curl ... | bash`, has no bundle beside it, so the
# installer downloads the same files from the release channel into a private
# 0700 directory and verifies each one against the digest fixed in this file
# BEFORE it is sourced. There is no fallback to unverified code.
#
# Defined as functions and called AFTER the flags are parsed, so `--help` costs
# no network request and writes nothing.
# ---------------------------------------------------------------------------
_LIB_MODULES="progress.sh detect.sh node-versions.sh picker.sh nvm-bootstrap.sh"
_LIB_BASE_URL_DEFAULT="https://raw.githubusercontent.com/omar00050/Easy-DevOps/main"
LIB_DIR=""
_LIB_VERIFIED_DIR=""
_LIB_SOURCE=""
_LIB_DIR_MODE=""
CHECK_HELPERS=false

_lib_dir_complete() {
  local dir="$1" _m
  [ -n "$dir" ] || return 1
  for _m in $_LIB_MODULES; do
    [ -f "$dir/$_m" ] || return 1
  done
  return 0
}

_lib_expected_sha256() {
  case "$1" in
    progress.sh)      printf '%s\n' 'f6922cecd8f55a5f9a2b5e3794da58eeebee31eb04bc1a41dd8ba3db699c15b9' ;;
    detect.sh)        printf '%s\n' '1870557130425bc851587da774f5ece78b2319d99bd10521bd9aca6c260f0742' ;;
    node-versions.sh) printf '%s\n' 'e05267a04edccc249e236e6945d6cb3146e804086af400db8611c56cee7d6c84' ;;
    picker.sh)        printf '%s\n' 'd43092378a324beb3f0002c0e4cc176a1e0144c2c8bfb079f04b5902d3e911c1' ;;
    nvm-bootstrap.sh) printf '%s\n' '5fb6404c543c941372495d4e2b9002a0e37e5b6fc6544d13177245be784ec7cf' ;;
    *) return 1 ;;
  esac
}

_lib_file_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sed 's/\r$//' "$file" | sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    sed 's/\r$//' "$file" | shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    sed 's/\r$//' "$file" | openssl dgst -sha256 | awk '{print $NF}'
  else
    printf 'Error: no SHA-256 tool is available (expected sha256sum, shasum, or openssl).\n' >&2
    return 1
  fi
}

_lib_dir_verified() {
  local dir="$1" _m _expected _actual
  for _m in $_LIB_MODULES; do
    _expected="$(_lib_expected_sha256 "$_m")" || return 1
    _actual="$(_lib_file_sha256 "$dir/$_m")" || return 1
    if [ "$_actual" != "$_expected" ]; then
      printf 'Error: installer module %s does not match the reviewed release.\n' "$_m" >&2
      printf '  expected: %s\n' "$_expected" >&2
      printf '  actual:   %s\n' "$_actual" >&2
      printf 'The file is damaged or was replaced. Download the installer again from\n' >&2
      printf 'the official release (https://github.com/omar00050/Easy-DevOps/releases)\n' >&2
      printf 'and retry. If it still fails, report it:\n' >&2
      printf '  https://github.com/omar00050/Easy-DevOps/issues\n' >&2
      return 1
    fi
  done
  return 0
}

# Test hook: EZ_INSTALLER_BASE_URL lets a test serve the helper bundle from a
# local fixture (a file:// URL or a loopback HTTP server the test starts)
# instead of the network. It exists only for tests. Anything that is not
# https://, file://, or loopback http:// is refused before a request is made.
_lib_base_url() {
  local base="${EZ_INSTALLER_BASE_URL:-$_LIB_BASE_URL_DEFAULT}"
  base="${base%/}"
  case "$base" in
    https://?*|file://?*|http://127.0.0.1|http://127.0.0.1[:/]*|http://localhost|http://localhost[:/]*)
      printf '%s\n' "$base"
      ;;
    *)
      printf 'Error: refusing installer helper source %s\n' "${base:-<empty>}" >&2
      printf 'Helpers may only come from https://, file://, or loopback\n' >&2
      printf 'http://127.0.0.1 / http://localhost. Nothing was downloaded.\n' >&2
      return 1
      ;;
  esac
}

_lib_private_dir() {
  _LIB_VERIFIED_DIR="$(mktemp -d "${TMPDIR:-/tmp}/easy-devops-installer.XXXXXX")" || {
    printf 'Error: could not create a private directory for the installer helpers.\n' >&2
    return 1
  }
  chmod 700 "$_LIB_VERIFIED_DIR" || {
    printf 'Error: could not protect the private installer helper directory.\n' >&2
    return 1
  }

  # Prove the mode rather than assuming chmod succeeded. Every byte that will be
  # sourced must live in a directory only this account can write to. Git Bash on
  # Windows cannot express POSIX modes on NTFS, so there the requested 0700 is
  # recorded while the directory stays private to the account under %TEMP%.
  local _mode
  _mode="$(stat -c '%a' -- "$_LIB_VERIFIED_DIR" 2>/dev/null || stat -f '%Lp' -- "$_LIB_VERIFIED_DIR" 2>/dev/null || true)"
  _LIB_DIR_MODE="$_mode"
  case "$_mode" in
    700|0700) ;;
    *)
      case "$(uname -s 2>/dev/null || true)" in
        MINGW*|MSYS*|CYGWIN*) ;;
        *)
          printf 'Error: private installer directory %s has mode %s, expected 700.\n' \
            "$_LIB_VERIFIED_DIR" "${_mode:-unknown}" >&2
          return 1
          ;;
      esac
      ;;
  esac

  _cleanup_verified_lib() {
    if [ -n "${_LIB_VERIFIED_DIR:-}" ] && [ -d "$_LIB_VERIFIED_DIR" ]; then
      rm -rf -- "$_LIB_VERIFIED_DIR"
    fi
  }
  trap '_cleanup_verified_lib' EXIT
  return 0
}

# Download one helper into the private directory. curl is preferred; wget is
# the fallback for minimal images. The caller verifies the bytes afterwards.
_lib_download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    printf 'Error: neither curl nor wget is available to download %s.\n' "$(basename "$dest")" >&2
    printf 'Install curl, or download the release manually and run install.sh from it.\n' >&2
    return 1
  fi
}

# Every layout the modules can legitimately be in: a clone or the published
# package (src/lib/installer), an older checkout (lib/installer), and the
# parent of a copied script.
resolve_lib_dir() {
  local candidate
  for candidate in \
    "${EASYDEVOPS_DIR:+$EASYDEVOPS_DIR/src/lib/installer}" \
    "${SCRIPT_DIR:+$SCRIPT_DIR/src/lib/installer}" \
    "${SCRIPT_DIR:+$SCRIPT_DIR/lib/installer}" \
    "${SCRIPT_DIR:+$SCRIPT_DIR/../src/lib/installer}" \
    "${EZ_INSTALL_LIB_DIR:-}"
  do
    if _lib_dir_complete "$candidate"; then
      LIB_DIR="$(cd "$candidate" && pwd)"
      return 0
    fi
  done
  return 1
}

source_lib_modules() {
  local _module _base _url

  # Hash and source the same bytes. A pathname by itself is not a stable
  # identity: another writer could replace a module after the digest check and
  # before the shell opens it. Copy or download the complete bundle into a fresh
  # 0700 directory, verify that private snapshot, and source only from there.
  if ! _lib_private_dir; then
    exit 1
  fi

  if resolve_lib_dir; then
    for _module in $_LIB_MODULES; do
      cp -- "$LIB_DIR/$_module" "$_LIB_VERIFIED_DIR/$_module" || {
        printf 'Error: could not snapshot installer module %s.\n' "$_module" >&2
        exit 1
      }
    done
    _LIB_SOURCE="local files beside the installer"
  else
    _base="$(_lib_base_url)" || exit 1
    for _module in $_LIB_MODULES; do
      _url="$_base/src/lib/installer/$_module"
      printf '  Downloading installer helper %s\n' "$_module"
      if ! _lib_download "$_url" "$_LIB_VERIFIED_DIR/$_module"; then
        printf 'Error: could not download installer helper %s from %s\n' "$_module" "$_url" >&2
        printf 'Check the network connection and retry. If the problem persists,\n' >&2
        printf 'download the release again from:\n' >&2
        printf '  https://github.com/omar00050/Easy-DevOps/releases\n' >&2
        printf 'and run install.sh from that download.\n' >&2
        exit 1
      fi
    done
    _LIB_SOURCE="downloaded from $_base"
  fi

  LIB_DIR="$_LIB_VERIFIED_DIR"
  if ! _lib_dir_verified "$LIB_DIR"; then
    printf 'Error: the installer helpers do not match this installer release.\n' >&2
    printf 'Nothing from an unverified helper was run.\n' >&2
    exit 1
  fi

  for _module in $_LIB_MODULES; do
    # shellcheck source=/dev/null
    . "$LIB_DIR/$_module"
  done
}

# ---------------------------------------------------------------------------
# Result tracking (mirrors install.ps1 summary table)
# ---------------------------------------------------------------------------
_RESULT_NAMES=()
_RESULT_STATUS=()   # "ok" or "fail"
_RESULT_DETAILS=()

add_result() {
  local name="$1" ok="$2" detail="${3:-}"
  _RESULT_NAMES+=("$name")
  _RESULT_STATUS+=("$ok")
  _RESULT_DETAILS+=("$detail")
}

# ---------------------------------------------------------------------------
# Error / cancellation helpers
# ---------------------------------------------------------------------------

# die <step_name> <reason> [recovery_cmd...]
die() {
  local step="$1"
  local reason="$2"
  shift 2
  step_failed "$step"
  add_result "$step" "fail" "$reason"
  printf '\nInstallation failed: %s. See above for details.\n' "$reason" >&2
  if [ "$#" -gt 0 ]; then
    printf '\nManual recovery:\n' >&2
    local cmd
    for cmd in "$@"; do
      printf '  %s\n' "$cmd" >&2
    done
  fi
  exit 1
}

# check_error <exit_code> <step_name> <reason> [recovery_cmd...]
check_error() {
  local code="$1"
  shift
  if [ "$code" -ne 0 ]; then
    die "$@"
  fi
}

# ---------------------------------------------------------------------------
# --help flag
# ---------------------------------------------------------------------------
print_help() {
  cat <<'EOF'
Easy DevOps Bootstrap Installer

Usage:
  bash install.sh [OPTIONS]

Options:
  --help, -h           Print this help and exit
  --version VERSION    Skip the version picker; install the specified Node.js
                       version directly (e.g., --version 20.11.1)
  --keep-node          Skip Node.js management entirely; proceed straight to
                       dependency installation with whatever Node.js is active
  --service            Install the background service without asking
  --no-service         Do not install the background service, and do not ask

Testing:
  --check-helpers      Load (fetching them when they are not beside the script)
                       and verify the installer helper modules, then exit 0.
                       Nothing is installed and no Node.js step runs.

Exit codes:
  0  Installation completed successfully
  1  Unrecoverable error (network failure, permission denied, etc.)
  2  User cancelled / aborted at a prompt

Examples:
  bash install.sh                   # Interactive install
  bash install.sh --version 20      # Install Node.js 20.x (latest patch)
  bash install.sh --keep-node       # Skip Node.js management
  bash install.sh --service         # Unattended, with the background service
  bash install.sh --no-service      # Unattended, without it
EOF
}

# ---------------------------------------------------------------------------
# Parse CLI flags
# ---------------------------------------------------------------------------
FORCED_VERSION=""
KEEP_NODE=false
# ask | yes | no — whether to install the background service at the end.
SERVICE_CHOICE="ask"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      print_help
      exit 0
      ;;
    --version)
      if [ -z "${2:-}" ]; then
        printf 'Error: --version requires a value (e.g., --version 20.11.1)\n' >&2
        exit 1
      fi
      FORCED_VERSION="$2"
      shift 2
      ;;
    --version=*)
      FORCED_VERSION="${1#--version=}"
      shift
      ;;
    --keep-node)
      KEEP_NODE=true
      shift
      ;;
    --service)
      SERVICE_CHOICE="yes"
      shift
      ;;
    --no-service)
      SERVICE_CHOICE="no"
      shift
      ;;
    --check-helpers)
      CHECK_HELPERS=true
      shift
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      printf 'Run "bash install.sh --help" for usage.\n' >&2
      exit 1
      ;;
  esac
done

# Only now: --help above costs no network request and writes nothing.
source_lib_modules

# --check-helpers: prove the helper bundle loaded, downloaded and verified, then
# stop before any install step. Documented in --help; used by the e2e suite.
if [ "$CHECK_HELPERS" = "true" ]; then
  _check_count=0
  for _check_module in $_LIB_MODULES; do
    _check_count=$((_check_count + 1))
  done
  _check_mode="$(stat -c '%a' -- "$_LIB_VERIFIED_DIR" 2>/dev/null || stat -f '%Lp' -- "$_LIB_VERIFIED_DIR" 2>/dev/null || printf 'unknown')"
  printf 'check-helpers: verified %s helper module(s) in a private directory (requested 0700, mode %s) from %s\n' \
    "$_check_count" "${_LIB_DIR_MODE:-$_check_mode}" "$_LIB_SOURCE"
  printf 'check-helpers: directory %s\n' "$_LIB_VERIFIED_DIR"
  exit 0
fi

# ---------------------------------------------------------------------------
# Install mode detection (mirrors install.ps1 3-mode logic)
#
#   source  : package.json with name=easy-devops found beside this script
#             -> npm install + npm link
#   update  : easy-devops already on PATH
#             -> skip install steps
#   npm     : standalone download, not in project dir
#             -> npm install -g easy-devops
#
# Piped execution is never source mode: with `curl | bash` there is no script
# directory, and the current directory's package.json belongs to whatever the
# user happened to be standing in.
# ---------------------------------------------------------------------------
SOURCE_MODE=false
ALREADY_INSTALLED=false
EXISTING_CMD=""

# Source mode: script is running from the project directory
if [ "$PIPED" = "false" ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  if command -v node >/dev/null 2>&1; then
    _pkg_name="$(node -e "try{process.stdout.write(require('$SCRIPT_DIR/package.json').name)}catch(e){}" 2>/dev/null || true)"
  else
    _pkg_name="$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$SCRIPT_DIR/package.json" 2>/dev/null | grep -o '"[^"]*"$' | tr -d '"' || true)"
  fi
  if [ "$_pkg_name" = "easy-devops" ]; then
    SOURCE_MODE=true
  fi
fi

# Already installed: easy-devops command is on PATH
if command -v easy-devops >/dev/null 2>&1; then
  EXISTING_CMD="$(command -v easy-devops)"
  ALREADY_INSTALLED=true
fi

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
printf '\n'
printf '╔══════════════════════════════════════╗\n'
printf '║   Easy DevOps -- Bootstrap Installer ║\n'
printf '╚══════════════════════════════════════╝\n'
printf '\n'

if [ "$ALREADY_INSTALLED" = "true" ]; then
  printf '  Mode: update  (easy-devops already installed at %s)\n' "$EXISTING_CMD"
  printf '        Node.js will still be managed; npm steps skipped.\n'
  printf '\n'
elif [ "$SOURCE_MODE" = "true" ]; then
  printf '  Mode: source  (project directory -- npm install + npm link)\n'
  printf '\n'
else
  printf '  Mode: npm     (will run: npm install -g easy-devops)\n'
  printf '\n'
fi

# ---------------------------------------------------------------------------
# 7-step install sequence
# ---------------------------------------------------------------------------
STEPS=(
  "Detecting system"
  "Fetching Node.js release list"
  "Node.js version selection"
  "Installing nvm"
  "Installing Node.js via nvm"
  "Installing Easy DevOps dependencies"
  "Registering global command"
)

# ---------------------------------------------------------------------------
# Step 1: Detect system
# ---------------------------------------------------------------------------
step_running "${STEPS[0]}"
detect_system
step_done "${STEPS[0]}"
add_result "System detection" "ok" "$SYSINFO_OS"

# Abort if no internet (unless --keep-node is set and we won't need the network)
if [ "$SYSINFO_HAS_INTERNET" = "false" ] && [ "$KEEP_NODE" = "false" ]; then
  die "${STEPS[0]}" "No internet connectivity -- cannot reach nodejs.org" \
    "Check your network connection and retry: bash install.sh"
fi

# ---------------------------------------------------------------------------
# Node.js decision tree
# ---------------------------------------------------------------------------

# NodeChoice variables
NODE_ACTION=""    # keep | upgrade | switch
NODE_TARGET=""    # version string or empty

if [ "$KEEP_NODE" = "true" ]; then
  # --keep-node flag: skip all Node.js management steps
  NODE_ACTION="keep"
  NODE_TARGET=""
  step_done "${STEPS[1]}  (skipped -- --keep-node)"
  add_result "Node.js release list" "ok" "Skipped (--keep-node)"
  step_done "${STEPS[2]}  (skipped -- --keep-node)"
  add_result "Node.js selection" "ok" "Skipped (--keep-node)"
elif [ -n "$FORCED_VERSION" ]; then
  # --version VERSION flag: version already known
  NODE_ACTION="switch"
  NODE_TARGET="$FORCED_VERSION"
  step_done "${STEPS[1]}  (skipped -- version specified)"
  add_result "Node.js release list" "ok" "Skipped (--version $FORCED_VERSION)"
  step_done "${STEPS[2]}  (skipped -- version specified: $FORCED_VERSION)"
  add_result "Node.js selection" "ok" "$FORCED_VERSION"
else
  # ---------------------------------------------------------------------------
  # Step 2: Fetch Node.js release list
  # ---------------------------------------------------------------------------
  step_running "${STEPS[1]}"
  if ! fetch_node_versions; then
    die "${STEPS[1]}" "Failed to fetch Node.js release list from nodejs.org" \
      "Check internet connection and retry: bash install.sh"
  fi
  step_done "${STEPS[1]}"
  add_result "Node.js release list" "ok" "${#NODE_RELEASES[@]} versions fetched"

  # ---------------------------------------------------------------------------
  # Step 3: Version selection
  # ---------------------------------------------------------------------------
  step_running "${STEPS[2]}"

  if [ -n "$SYSINFO_NODE_VERSION" ]; then
    # Node.js already installed -- present 3-option menu (matches install.ps1)
    printf '\nNode.js %s is already installed.\n' "$SYSINFO_NODE_VERSION"
    printf 'What would you like to do?\n\n'
    printf '  1) Keep current version (%s)\n' "$SYSINFO_NODE_VERSION"
    printf '  2) Upgrade to latest LTS automatically\n'
    printf '  3) Switch to a different version (opens picker)\n'
    printf '\n'

    local_choice=""
    while true; do
      printf 'Enter 1, 2, or 3 (q to quit): '
      IFS= read -r local_choice < /dev/tty
      case "$local_choice" in
        1)
          NODE_ACTION="keep"
          NODE_TARGET=""
          break
          ;;
        2)
          NODE_ACTION="upgrade"
          NODE_TARGET=""
          _upgrade_lts=""
          for _upgrade_rel in "${NODE_RELEASES[@]}"; do
            _upgrade_lts="$(printf '%s' "$_upgrade_rel" | cut -d'|' -f3)"
            if [ "$_upgrade_lts" != "false" ]; then
              NODE_TARGET="$(printf '%s' "$_upgrade_rel" | cut -d'|' -f1)"
              break
            fi
          done
          if [ -z "$NODE_TARGET" ]; then
            die "${STEPS[2]}" "Could not determine latest LTS version" \
              "Run: bash install.sh --version <version>"
          fi
          break
          ;;
        3)
          NODE_ACTION="switch"
          _pick_rc=0
          pick_version "$SYSINFO_NODE_VERSION" || _pick_rc=$?
          if [ "$_pick_rc" -eq 2 ]; then
            printf '\nInstallation cancelled by user.\n'
            exit 2
          fi
          check_error "$_pick_rc" "${STEPS[2]}" "Version selection failed"
          NODE_TARGET="$PICKED_VERSION"
          break
          ;;
        q|Q)
          printf '\nInstallation cancelled by user.\n'
          exit 2
          ;;
        *)
          printf 'Invalid choice. Please enter 1, 2, or 3.\n' >&2
          ;;
      esac
    done
  else
    # No Node.js installed -- go straight to picker
    _pick_rc=0
    pick_version "" || _pick_rc=$?
    if [ "$_pick_rc" -eq 2 ]; then
      printf '\nInstallation cancelled by user.\n'
      exit 2
    fi
    check_error "$_pick_rc" "${STEPS[2]}" "Version selection failed"
    NODE_ACTION="switch"
    NODE_TARGET="$PICKED_VERSION"
  fi

  step_done "${STEPS[2]}"
  add_result "Node.js selection" "ok" "${NODE_ACTION}${NODE_TARGET:+ -> $NODE_TARGET}"
fi

# ---------------------------------------------------------------------------
# Steps 4 + 5: nvm bootstrap + Node.js install
# ---------------------------------------------------------------------------
if [ "$NODE_ACTION" = "keep" ]; then
  step_done "${STEPS[3]}  (skipped -- keeping current Node.js)"
  add_result "nvm" "ok" "Skipped (keep)"
  step_done "${STEPS[4]}  (skipped -- keeping current Node.js)"
  add_result "Node.js install" "ok" "Skipped (keep)"
else
  # Step 4: bootstrap nvm
  step_running "${STEPS[3]}"
  if ! bootstrap_nvm; then
    die "${STEPS[3]}" "nvm installation failed" \
      "Install nvm from a reviewed release: https://github.com/nvm-sh/nvm/releases" \
      "source ~/.nvm/nvm.sh" \
      "bash install.sh --version $NODE_TARGET"
  fi
  step_done "${STEPS[3]}"
  add_result "nvm" "ok" ""

  # Step 5: install chosen Node.js version
  step_running "${STEPS[4]}"
  printf 'Installing Node.js %s via nvm (this may take a minute)...\n' "$NODE_TARGET"
  _nvm_log="$(mktemp /tmp/nvm-install.XXXXXX 2>/dev/null || mktemp)"
  if ! nvm install "$NODE_TARGET" > "$_nvm_log" 2>&1; then
    printf '\n--- nvm install output ---\n' >&2
    cat "$_nvm_log" >&2
    rm -f "$_nvm_log"
    die "${STEPS[4]}" "Failed to install Node.js $NODE_TARGET via nvm" \
      "nvm install $NODE_TARGET" \
      "nvm use $NODE_TARGET" \
      "npm install" \
      "npm link"
  fi
  rm -f "$_nvm_log"
  if ! nvm use "$NODE_TARGET" > /dev/null 2>&1; then
    die "${STEPS[4]}" "Failed to activate Node.js $NODE_TARGET" \
      "nvm use $NODE_TARGET" \
      "npm install" \
      "npm link"
  fi
  step_done "${STEPS[4]}"
  add_result "Node.js install" "ok" "$NODE_TARGET"
fi

# ---------------------------------------------------------------------------
# Steps 6 + 7: Install Easy DevOps & register CLI
# ---------------------------------------------------------------------------

if [ "$ALREADY_INSTALLED" = "true" ]; then
  # ── Already installed: skip both steps ──────────────────────────────────────
  step_done "${STEPS[5]}  (skipped -- easy-devops already installed)"
  add_result "npm install" "ok" "Skipped (already installed)"
  step_done "${STEPS[6]}  (skipped -- already registered)"
  add_result "CLI registered" "ok" "Skipped (already installed)"

elif [ "$SOURCE_MODE" = "true" ]; then
  # ── Source mode: npm install in project dir + npm link ───────────────────────
  step_running "${STEPS[5]}"
  printf 'Running npm install in %s...\n' "$EASYDEVOPS_DIR"
  if ! (cd "$EASYDEVOPS_DIR" && npm install 2>&1); then
    die "${STEPS[5]}" "npm install failed" \
      "cd $EASYDEVOPS_DIR && npm install" \
      "npm link"
  fi
  step_done "${STEPS[5]}"
  add_result "npm install" "ok" ""

  step_running "${STEPS[6]}"
  printf 'Registering global command via npm link...\n'
  if ! (cd "$EASYDEVOPS_DIR" && npm link 2>&1); then
    die "${STEPS[6]}" "npm link failed -- could not register global command" \
      "cd $EASYDEVOPS_DIR && npm link" \
      "If permission denied, try: sudo npm link"
  fi

  # Verify the command is on PATH
  if ! command -v easy-devops >/dev/null 2>&1; then
    printf 'Warning: easy-devops not yet on PATH. Open a new terminal or run:\n' >&2
    printf '  export PATH="$(npm bin -g):$PATH"\n' >&2
  fi
  step_done "${STEPS[6]}"
  add_result "CLI registered" "ok" ""

else
  # ── npm global mode: npm install -g easy-devops ──────────────────────────────
  step_running "${STEPS[5]}"
  printf 'Running npm install -g easy-devops...\n'
  if ! npm install -g easy-devops 2>&1; then
    die "${STEPS[5]}" "npm install -g easy-devops failed" \
      "npm install -g easy-devops" \
      "If permission denied, try: sudo npm install -g easy-devops"
  fi
  step_done "${STEPS[5]}"
  add_result "npm install" "ok" "npm install -g easy-devops"

  step_done "${STEPS[6]}  (registered via npm install -g)"
  add_result "CLI registered" "ok" "npm install -g"
fi

# ---------------------------------------------------------------------------
# Summary (mirrors install.ps1 summary table)
# ---------------------------------------------------------------------------
printf '\n'
printf '=== Installation Summary ===\n\n'

_allOK=true
for _i in "${!_RESULT_NAMES[@]}"; do
  if [ "${_RESULT_STATUS[$_i]}" = "ok" ]; then
    _icon=" OK "
  else
    _icon="FAIL"
    _allOK=false
  fi
  _d="${_RESULT_DETAILS[$_i]}"
  if [ -n "$_d" ]; then _d="  ($_d)"; fi
  printf '  [%s]  %s%s\n' "$_icon" "${_RESULT_NAMES[$_i]}" "$_d"
done
printf '\n'

if [ "$_allOK" = "true" ]; then
  printf '  All steps completed successfully!\n\n'
  printf '  To use immediately in this terminal, run:\n'
  printf '    source ~/.bashrc\n\n'
  printf '  Or open a new terminal, then run:\n'
  printf '    easy-devops\n or  ezz\n'
else
  printf '  Some steps need attention -- see warnings above.\n\n'
  printf '  Fallback:\n'
  printf '    node src/cli/index.js\n'
fi
printf '\n'

# ---------------------------------------------------------------------------
# Offer to install the background service
#
# Asked LAST, after Node and the package are in place, because `ezz` has to be
# runnable for the answer to mean anything.
#
# Reading from /dev/tty rather than stdin keeps the prompt reliable when the
# installer is driven by another program. A plain `read` can consume that
# stream, or see EOF and silently take the default — and this is the one
# question whose default decides whether the user's server is monitored at
# all. If there is no terminal (a CI run, a Dockerfile), the prompt is skipped
# and the command is printed instead.
# ---------------------------------------------------------------------------
maybe_install_service() {
  # An explicit flag means do not ask.
  if [ "$SERVICE_CHOICE" = "no" ]; then
    printf '  Skipping the background service (--no-service).\n'
    printf '  Install it later with: ezz service install\n\n'
    return 0
  fi

  # Open the terminal on fd 3 ONCE, and let the open itself decide whether
  # there is one. A "[ -r /dev/tty ]" test is not enough: it can pass while the
  # open then fails with "No such device or address" on a process that has no
  # controlling terminal -- measured, not assumed. That leaked an error to the
  # user and then fell through to the default, and the default here is yes.
  # Guessing yes on a question that runs sudo is the wrong direction.
  # The braces matter: "exec 3</dev/tty 2>/dev/null" still lets the SHELL print
  # its own "No such device or address" before the redirection takes effect.
  # Grouping puts the shell's own diagnostic inside the redirect too.
  _has_tty=false
  if { exec 3</dev/tty; } 2>/dev/null; then
    _has_tty=true
  fi

  if [ "$SERVICE_CHOICE" != "yes" ]; then
    if [ "$_has_tty" != "true" ]; then
      # Unattended: never guess on a question that needs sudo.
      printf '  No terminal available, so the background service was not installed.\n'
      printf '  Install it with:   ezz service install\n'
      printf '  Or non-interactively: bash install.sh --service\n\n'
      return 0
    fi

    printf '\n'
    printf '  Easy DevOps can run a background service that keeps monitoring,\n'
    printf '  notifications and the Hub agent alive even with no dashboard open.\n'
    printf '  It installs a systemd unit running as your user. sudo will ask for\n'
    printf '  your password itself; nothing here stores or sees it.\n'
    printf '\n'
    printf '  Install the background service now? (recommended for servers) [Y/n] '

    _answer=""
    IFS= read -r _answer <&3 || _answer=""

    case "$_answer" in
      [Nn]|[Nn][Oo])
        printf '\n  Skipped. Install it later with: ezz service install\n\n'
        exec 3<&-
        return 0
        ;;
    esac
  fi

  printf '\n  Installing the background service...\n\n'

  # Resolve the CLI the same way a user would, then fall back to the checkout.
  _ez=""
  if command -v ezz >/dev/null 2>&1; then
    _ez="ezz"
  elif command -v easy-devops >/dev/null 2>&1; then
    _ez="easy-devops"
  elif [ -f "$EASYDEVOPS_DIR/src/cli/index.js" ]; then
    _ez="node \"$EASYDEVOPS_DIR/src/cli/index.js\""
  else
    printf '  Could not find the ezz command, so the service was not installed.\n'
    printf '  Open a new terminal and run: ezz service install\n\n'
    if [ "$_has_tty" = "true" ]; then exec 3<&-; fi
    return 0
  fi

  # stdin comes from the terminal for the same reason as the prompt above:
  # "ezz service install" runs sudo, and sudo must be able to ask.
  _installed=false
  if [ "$_has_tty" = "true" ]; then
    if eval "$_ez service install" <&3; then _installed=true; fi
    exec 3<&-
  elif eval "$_ez service install"; then
    _installed=true
  fi

  if [ "$_installed" = "true" ]; then
    return 0
  fi

  printf '\n  The service was not installed. Nothing else was changed.\n'
  printf '  You can retry with: ezz service install\n\n'
  return 0
}

maybe_install_service

exit 0
