#!/usr/bin/env bash
# nvm-bootstrap.sh — Activate an already-installed nvm
# Sourced by install.sh; not executed directly.
# Requires: progress.sh sourced first (uses step_* helpers).
#
# Functions:
#   bootstrap_nvm  — source nvm from NVM_DIR into the current shell session
#
# Respects:
#   NVM_DIR  (default: ~/.nvm)

bootstrap_nvm() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"

  # ------------------------------------------------------------------
  # Step 1: Require an existing, locally installed nvm
  #
  # Never fetch and execute a mutable branch. The installer module bundle is
  # released as one reviewed unit; nvm itself must be installed separately from
  # a release the operator has reviewed.
  # ------------------------------------------------------------------
  local nvm_file="$nvm_dir/nvm.sh"
  if [ ! -f "$nvm_file" ]; then
    printf 'Error: nvm is not installed at %s.\n' "$nvm_dir" >&2
    printf 'This installer will not fetch nvm from HEAD.\n' >&2
    printf 'Install nvm from a reviewed release:\n' >&2
    printf '  https://github.com/nvm-sh/nvm/releases\n' >&2
    printf 'Then run:\n' >&2
    printf '  source %s/nvm.sh\n' "$nvm_dir" >&2
    printf '  bash install.sh --version <version>\n' >&2
    return 1
  fi

  # Source only a private, stable local file. A link or a group/world-writable
  # nvm.sh lets another local principal substitute executable shell code at
  # the instant this installer runs it. A root-owned installation is acceptable
  # for a normal user because only root can replace that file.
  if [ -L "$nvm_dir" ] || [ -L "$nvm_file" ]; then
    printf 'Error: refusing a linked nvm installation at %s.\n' "$nvm_dir" >&2
    return 1
  fi

  local nvm_uid nvm_mode current_uid dir_uid dir_mode
  dir_uid="$(stat -c '%u' -- "$nvm_dir" 2>/dev/null)" || {
    printf 'Error: could not determine the owner of %s.\n' "$nvm_dir" >&2
    return 1
  }
  dir_mode="$(stat -c '%a' -- "$nvm_dir" 2>/dev/null)" || {
    printf 'Error: could not determine the permissions of %s.\n' "$nvm_dir" >&2
    return 1
  }
  nvm_uid="$(stat -c '%u' -- "$nvm_file" 2>/dev/null)" || {
    printf 'Error: could not determine the owner of %s.\n' "$nvm_file" >&2
    return 1
  }
  nvm_mode="$(stat -c '%a' -- "$nvm_file" 2>/dev/null)" || {
    printf 'Error: could not determine the permissions of %s.\n' "$nvm_file" >&2
    return 1
  }
  current_uid="$(id -u)"

  if [ "$nvm_uid" -ne 0 ] && [ "$nvm_uid" -ne "$current_uid" ]; then
    printf 'Error: %s is owned by uid %s, not root or this account.\n' "$nvm_file" "$nvm_uid" >&2
    return 1
  fi
  if [ "$dir_uid" -ne 0 ] && [ "$dir_uid" -ne "$current_uid" ]; then
    printf 'Error: %s is owned by uid %s, not root or this account.\n' "$nvm_dir" "$dir_uid" >&2
    return 1
  fi
  if [ $((0$dir_mode & 022)) -ne 0 ] || [ $((0$nvm_mode & 022)) -ne 0 ]; then
    printf 'Error: %s is writable by another local account; refusing to source it.\n' "$nvm_file" >&2
    return 1
  fi

  # ------------------------------------------------------------------
  # Step 2: Source nvm into the current shell session
  # ------------------------------------------------------------------
  export NVM_DIR="$nvm_dir"
  # shellcheck source=/dev/null
  . "$nvm_file"

  # Verify nvm command is now available
  if ! command -v nvm >/dev/null 2>&1; then
    printf 'Error: nvm.sh did not provide an nvm command.\n' >&2
    printf 'Manual recovery:\n' >&2
    printf '  source ~/.nvm/nvm.sh\n' >&2
    printf '  Then re-run: bash install.sh\n' >&2
    return 1
  fi

  printf '  nvm is active in this session\n'
}
