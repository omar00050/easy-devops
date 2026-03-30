#!/usr/bin/env bash
# install.sh — Easy DevOps Bootstrap Installer (Linux / macOS)
#
# Usage:
#   bash install.sh [OPTIONS]
#
# Options:
#   --help, -h           Print this help and exit 0
#   --version VERSION    Skip picker; use the specified Node.js version
#   --keep-node          Skip Node.js management; proceed to dependency install
#
# Exit codes:
#   0  Installation completed successfully
#   1  Unrecoverable error
#   2  User cancelled

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve script and project directory
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EASYDEVOPS_DIR="${EASYDEVOPS_DIR:-$SCRIPT_DIR}"

# ---------------------------------------------------------------------------
# Source lib modules
# ---------------------------------------------------------------------------
LIB_DIR="$SCRIPT_DIR/lib/installer"

for _module in progress.sh detect.sh node-versions.sh picker.sh nvm-bootstrap.sh; do
  if [ ! -f "$LIB_DIR/$_module" ]; then
    printf 'Error: Required module not found: %s/%s\n' "$LIB_DIR" "$_module" >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  . "$LIB_DIR/$_module"
done

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

Exit codes:
  0  Installation completed successfully
  1  Unrecoverable error (network failure, permission denied, etc.)
  2  User cancelled / aborted at a prompt

Examples:
  bash install.sh                   # Interactive install
  bash install.sh --version 20      # Install Node.js 20.x (latest patch)
  bash install.sh --keep-node       # Skip Node.js management
EOF
}

# ---------------------------------------------------------------------------
# Parse CLI flags
# ---------------------------------------------------------------------------
FORCED_VERSION=""
KEEP_NODE=false

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
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      printf 'Run "bash install.sh --help" for usage.\n' >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Source mode / package mode detection (mirrors install.ps1)
#
#   Package mode: easy-devops already on PATH (installed via npm -g)
#                 -> skip npm install + npm link
#   Source mode:  running from cloned repo or fresh directory
#                 -> run all 7 steps
# ---------------------------------------------------------------------------
PACKAGE_MODE=false
EXISTING_CMD=""

if command -v easy-devops >/dev/null 2>&1; then
  EXISTING_CMD="$(command -v easy-devops)"
  PACKAGE_MODE=true
fi

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
printf '\n'
printf '╔══════════════════════════════════════╗\n'
printf '║   Easy DevOps -- Bootstrap Installer ║\n'
printf '╚══════════════════════════════════════╝\n'
printf '\n'

if [ "$PACKAGE_MODE" = "true" ]; then
  printf '  Mode: package  (easy-devops already installed at %s)\n' "$EXISTING_CMD"
  printf '        Skipping npm install / npm link steps.\n'
  printf '\n'
else
  printf '  Mode: source  (installing from project directory)\n'
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

# Print all steps as pending initially
for _s in "${STEPS[@]}"; do
  step_pending "$_s"
done
printf '\n'

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
      IFS= read -r local_choice
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
      "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash" \
      "source ~/.nvm/nvm.sh" \
      "bash install.sh --version $NODE_TARGET"
  fi
  step_done "${STEPS[3]}"
  add_result "nvm" "ok" ""

  # Step 5: install chosen Node.js version
  step_running "${STEPS[4]}"
  printf 'Installing Node.js %s via nvm...\n' "$NODE_TARGET"
  if ! nvm install "$NODE_TARGET" 2>&1; then
    die "${STEPS[4]}" "Failed to install Node.js $NODE_TARGET via nvm" \
      "nvm install $NODE_TARGET" \
      "nvm use $NODE_TARGET" \
      "npm install" \
      "npm link"
  fi
  if ! nvm use "$NODE_TARGET" 2>&1; then
    die "${STEPS[4]}" "Failed to activate Node.js $NODE_TARGET" \
      "nvm use $NODE_TARGET" \
      "npm install" \
      "npm link"
  fi
  step_done "${STEPS[4]}"
  add_result "Node.js install" "ok" "$NODE_TARGET"
fi

# ---------------------------------------------------------------------------
# Step 6: npm install
# ---------------------------------------------------------------------------
if [ "$PACKAGE_MODE" = "true" ]; then
  step_done "${STEPS[5]}  (skipped -- package mode)"
  add_result "npm install" "ok" "Skipped (package mode)"
else
  step_running "${STEPS[5]}"
  printf 'Running npm install in %s...\n' "$EASYDEVOPS_DIR"
  if ! npm install --prefix "$EASYDEVOPS_DIR" 2>&1; then
    die "${STEPS[5]}" "npm install failed" \
      "cd $EASYDEVOPS_DIR && npm install" \
      "npm link"
  fi
  step_done "${STEPS[5]}"
  add_result "npm install" "ok" ""
fi

# ---------------------------------------------------------------------------
# Step 7: npm link -- register global command
# ---------------------------------------------------------------------------
if [ "$PACKAGE_MODE" = "true" ]; then
  step_done "${STEPS[6]}  (skipped -- package mode)"
  add_result "CLI registered" "ok" "Skipped (package mode)"
else
  step_running "${STEPS[6]}"
  printf 'Registering global command via npm link...\n'
  _link_ok=false
  if npm link --prefix "$EASYDEVOPS_DIR" 2>&1; then
    _link_ok=true
  elif (cd "$EASYDEVOPS_DIR" && npm link 2>&1); then
    _link_ok=true
  fi

  if [ "$_link_ok" = "false" ]; then
    die "${STEPS[6]}" "npm link failed -- could not register global command" \
      "cd $EASYDEVOPS_DIR && npm link" \
      "If permission denied, try: sudo npm link"
  fi

  # Verify the command is on PATH
  if ! command -v easy-devops >/dev/null 2>&1; then
    printf 'Warning: easy-devops command not found on PATH yet.\n' >&2
    printf 'You may need to open a new terminal or run:\n' >&2
    printf '  export PATH="$(npm bin -g):$PATH"\n' >&2
  fi

  step_done "${STEPS[6]}"
  add_result "CLI registered" "ok" ""
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
  printf '  Run the CLI:\n'
  printf '    easy-devops\n'
else
  printf '  Some steps need attention -- see warnings above.\n\n'
  printf '  Fallback:\n'
  printf '    node cli/index.js\n'
fi
printf '\n'
exit 0
