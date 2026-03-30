#!/usr/bin/env bash
# nvm-bootstrap.sh — Download, install, and activate nvm
# Sourced by install.sh; not executed directly.
# Requires: progress.sh sourced first (uses step_* helpers).
#
# Functions:
#   bootstrap_nvm  — install nvm if absent, then source it into the current session
#
# Respects:
#   NVM_DIR  (default: ~/.nvm)

bootstrap_nvm() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local nvm_install_url="https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh"

  # ------------------------------------------------------------------
  # Step 1: Install nvm if not already present
  # ------------------------------------------------------------------
  if [ -f "$nvm_dir/nvm.sh" ]; then
    step_done "nvm already installed at $nvm_dir — skipping download"
  else
    step_running "Downloading and installing nvm…"

    local install_ok=false
    if command -v curl >/dev/null 2>&1; then
      if curl -fsSL --max-time 60 "$nvm_install_url" | bash >/dev/null 2>&1; then
        install_ok=true
      fi
    fi
    if [ "$install_ok" = "false" ] && command -v wget >/dev/null 2>&1; then
      if wget -qO- --timeout=60 "$nvm_install_url" | bash >/dev/null 2>&1; then
        install_ok=true
      fi
    fi

    if [ "$install_ok" = "false" ]; then
      step_failed "nvm download failed"
      printf '\nManual recovery:\n' >&2
      printf '  curl -o- %s | bash\n' "$nvm_install_url" >&2
      printf '  Then run: source ~/.nvm/nvm.sh\n' >&2
      return 1
    fi

    step_done "nvm installed at $nvm_dir"
  fi

  # ------------------------------------------------------------------
  # Step 2: Source nvm into the current shell session
  # ------------------------------------------------------------------
  # shellcheck source=/dev/null
  if [ -f "$nvm_dir/nvm.sh" ]; then
    export NVM_DIR="$nvm_dir"
    . "$nvm_dir/nvm.sh"
  fi

  # Verify nvm command is now available
  if ! command -v nvm >/dev/null 2>&1; then
    # nvm is a function, not a binary; try sourcing from common shell rc files
    for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.zshrc"; do
      if [ -f "$rc" ]; then
        # shellcheck source=/dev/null
        . "$rc" 2>/dev/null || true
        command -v nvm >/dev/null 2>&1 && break
      fi
    done
  fi

  if ! command -v nvm >/dev/null 2>&1; then
    step_failed "nvm command not available after install"
    printf '\nManual recovery:\n' >&2
    printf '  source ~/.nvm/nvm.sh\n' >&2
    printf '  Then re-run: bash install.sh\n' >&2
    return 1
  fi

  step_done "nvm is active in this session"
}
