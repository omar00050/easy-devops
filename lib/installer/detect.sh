#!/usr/bin/env bash
# detect.sh — System detection helpers
# Sourced by install.sh; not executed directly.
#
# Exports (as shell variables):
#   SYSINFO_OS             — OS name + version string
#   SYSINFO_ARCH           — CPU architecture
#   SYSINFO_SHELL          — Shell name
#   SYSINFO_SHELL_VERSION  — Shell version
#   SYSINFO_NODE_VERSION   — Installed Node.js version, or ""
#   SYSINFO_NPM_VERSION    — Installed npm version, or ""
#   SYSINFO_NVM_INSTALLED  — "true" or "false"
#   SYSINFO_HAS_INTERNET   — "true" or "false"
#   SYSINFO_IS_ROOT        — "true" or "false"
#
# Functions:
#   detect_system  — populate all SYSINFO_* vars and print a summary block

detect_system() {
  # OS name + version
  if [ -f /etc/os-release ]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    SYSINFO_OS="${NAME:-unknown} ${VERSION_ID:-}"
    SYSINFO_OS="${SYSINFO_OS%% }"   # trim trailing space when VERSION_ID is empty
  elif [ "$(uname -s)" = "Darwin" ]; then
    SYSINFO_OS="macOS $(sw_vers -productVersion 2>/dev/null || echo '')"
  else
    SYSINFO_OS="$(uname -s) $(uname -r)"
  fi

  # CPU architecture
  SYSINFO_ARCH="$(uname -m)"

  # Shell name + version
  SYSINFO_SHELL="${SHELL##*/}"
  # shellcheck disable=SC2016
  SYSINFO_SHELL_VERSION="$("$SHELL" --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)"

  # Node.js version (empty if not installed)
  if command -v node >/dev/null 2>&1; then
    SYSINFO_NODE_VERSION="$(node --version 2>/dev/null | tr -d 'v' || true)"
  else
    SYSINFO_NODE_VERSION=""
  fi

  # npm version (empty if not installed)
  if command -v npm >/dev/null 2>&1; then
    SYSINFO_NPM_VERSION="$(npm --version 2>/dev/null || true)"
  else
    SYSINFO_NPM_VERSION=""
  fi

  # nvm installed?
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -d "$nvm_dir" ] && [ -f "$nvm_dir/nvm.sh" ]; then
    SYSINFO_NVM_INSTALLED="true"
  else
    SYSINFO_NVM_INSTALLED="false"
  fi

  # Internet connectivity (reach nodejs.org)
  if curl -s --max-time 5 --head https://nodejs.org >/dev/null 2>&1 \
     || ping -c 1 -W 3 nodejs.org >/dev/null 2>&1; then
    SYSINFO_HAS_INTERNET="true"
  else
    SYSINFO_HAS_INTERNET="false"
  fi

  # Root / Administrator check
  if [ "$(id -u)" = "0" ]; then
    SYSINFO_IS_ROOT="true"
  else
    SYSINFO_IS_ROOT="false"
  fi

  # Print formatted summary block
  printf '\n=== System Information ===\n'
  printf '  OS          : %s\n'  "$SYSINFO_OS"
  printf '  Architecture: %s\n'  "$SYSINFO_ARCH"
  printf '  Shell       : %s %s\n' "$SYSINFO_SHELL" "$SYSINFO_SHELL_VERSION"
  printf '  Node.js     : %s\n'  "${SYSINFO_NODE_VERSION:-not installed}"
  printf '  npm         : %s\n'  "${SYSINFO_NPM_VERSION:-not installed}"
  printf '  nvm         : %s\n'  "$SYSINFO_NVM_INSTALLED"
  printf '  Internet    : %s\n'  "$SYSINFO_HAS_INTERNET"
  printf '  Root        : %s\n'  "$SYSINFO_IS_ROOT"
  printf '==========================\n\n'
}
