#!/usr/bin/env bash
# nvm-bootstrap.sh — Activate nvm, installing a pinned release when needed
# Sourced by install.sh; not executed directly.
# Requires: progress.sh sourced first (uses step_* helpers).
#
# Functions:
#   bootstrap_nvm  — source nvm from NVM_DIR into the current shell session,
#                    installing the pinned NVM_VERSION when it is missing
#
# Respects:
#   NVM_DIR  (default: ~/.nvm)
#
# Test hooks (honoured only while EZ_TEST=1):
#   EZ_TEST_NVM_SHA256       — pin used instead of NVM_INSTALL_SHA256
#   EZ_TEST_NVM_INSTALL_URL  — local fixture instead of the nvm release URL

# Pinned nvm release. The digest below is deliberately empty until the owner
# reviews that release: this installer never learns a hash from the network and
# never guesses one. With the digest empty, nvm is not downloaded at all; the
# exact manual commands are printed instead.
NVM_VERSION="v0.40.3"
# TODO(owner): pin from the reviewed nvm release
NVM_INSTALL_SHA256=""

_nvm_file_sha256() {
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

_nvm_expected_sha256() {
  if [ "${EZ_TEST:-}" = "1" ] && [ -n "${EZ_TEST_NVM_SHA256:-}" ]; then
    printf '%s\n' "$EZ_TEST_NVM_SHA256"
    return 0
  fi
  printf '%s\n' "$NVM_INSTALL_SHA256"
}

_nvm_install_url() {
  if [ "${EZ_TEST:-}" = "1" ] && [ -n "${EZ_TEST_NVM_INSTALL_URL:-}" ]; then
    case "$EZ_TEST_NVM_INSTALL_URL" in
      https://?*|file://?*|http://127.0.0.1[:/]*|http://localhost[:/]*) ;;
      *)
        printf 'Error: refusing nvm test installer URL %s\n' "$EZ_TEST_NVM_INSTALL_URL" >&2
        return 1
        ;;
    esac
    printf '%s\n' "$EZ_TEST_NVM_INSTALL_URL"
    return 0
  fi
  printf 'https://raw.githubusercontent.com/nvm-sh/nvm/%s/install.sh\n' "$NVM_VERSION"
}

_nvm_print_manual() {
  local nvm_dir="$1" url pipe
  url="https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh"
  pipe='|'
  printf 'Error: nvm is not installed at %s.\n' "$nvm_dir" >&2
  printf 'This installer only downloads nvm when a reviewed SHA-256 is pinned for it.\n' >&2
  printf 'Install nvm %s from its official release, then retry:\n' "$NVM_VERSION" >&2
  # The command is printed, never executed; curl is not piped into a shell here.
  printf '  curl -o- %s %s bash\n' "$url" "$pipe" >&2
  printf '  source ~/.nvm/nvm.sh\n' >&2
  printf '  bash install.sh\n' >&2
  printf 'Alternative: with Node.js 18+ already installed (a distro package is fine),\n' >&2
  printf 'skip Node.js management entirely:\n' >&2
  printf '  bash install.sh --keep-node\n' >&2
}

# Source only a private, stable local file. A link or a group/world-writable
# nvm.sh lets another local principal substitute executable shell code at the
# instant this installer runs it. A root-owned installation is acceptable for a
# normal user because only root can replace that file.
_nvm_source_checked() {
  local nvm_dir="$1" nvm_file="$2"

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

  export NVM_DIR="$nvm_dir"
  # shellcheck source=/dev/null
  . "$nvm_file"

  if ! command -v nvm >/dev/null 2>&1; then
    printf 'Error: nvm.sh did not provide an nvm command.\n' >&2
    printf 'Manual recovery:\n' >&2
    printf '  source ~/.nvm/nvm.sh\n' >&2
    printf '  Then re-run: bash install.sh\n' >&2
    return 1
  fi

  printf '  nvm is active in this session\n'
  return 0
}

bootstrap_nvm() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local nvm_file="$nvm_dir/nvm.sh"

  # ------------------------------------------------------------------
  # Already installed: use the reviewed safety checks unchanged.
  # ------------------------------------------------------------------
  if [ -f "$nvm_file" ]; then
    _nvm_source_checked "$nvm_dir" "$nvm_file"
    return $?
  fi

  # ------------------------------------------------------------------
  # Missing, and no reviewed digest pinned: never download or guess.
  # ------------------------------------------------------------------
  local expected
  expected="$(_nvm_expected_sha256)"
  if [ -z "$expected" ]; then
    _nvm_print_manual "$nvm_dir"
    return 1
  fi

  # ------------------------------------------------------------------
  # Missing, with a pinned digest: download into a private 0700 directory,
  # verify it, and run only that verified copy (never the shell's stdin).
  # ------------------------------------------------------------------
  local tmp_dir url installer actual _rc
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/easy-devops-nvm.XXXXXX")" || {
    printf 'Error: could not create a private directory for the nvm installer.\n' >&2
    return 1
  }
  chmod 700 "$tmp_dir" || {
    rm -rf -- "$tmp_dir"
    printf 'Error: could not protect the private nvm installer directory.\n' >&2
    return 1
  }

  url="$(_nvm_install_url)" || { rm -rf -- "$tmp_dir"; return 1; }
  installer="$tmp_dir/install.sh"
  printf '  Downloading nvm %s installer...\n' "$NVM_VERSION"

  _rc=0
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$installer" || _rc=$?
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$installer" "$url" || _rc=$?
  else
    printf 'Error: neither curl nor wget is available to download the nvm installer.\n' >&2
    rm -rf -- "$tmp_dir"
    return 1
  fi
  if [ "$_rc" -ne 0 ] || [ ! -f "$installer" ]; then
    printf 'Error: could not download the nvm %s installer from %s\n' "$NVM_VERSION" "$url" >&2
    printf 'Check the network connection and retry, or install nvm manually:\n' >&2
    _nvm_print_manual "$nvm_dir"
    rm -rf -- "$tmp_dir"
    return 1
  fi

  actual="$(_nvm_file_sha256 "$installer")" || { rm -rf -- "$tmp_dir"; return 1; }
  if [ "$actual" != "$expected" ]; then
    printf 'Error: the nvm installer %s does not match the pinned release.\n' "$installer" >&2
    printf '  expected: %s\n' "$expected" >&2
    printf '  actual:   %s\n' "$actual" >&2
    printf 'Nothing was run. Download the installer again from the official\n' >&2
    printf 'release (https://github.com/nvm-sh/nvm/releases/tag/%s). If it still\n' "$NVM_VERSION" >&2
    printf 'fails, report it: https://github.com/omar00050/Easy-DevOps/issues\n' >&2
    rm -rf -- "$tmp_dir"
    return 1
  fi

  printf '  Running the verified nvm %s installer (shell rc files untouched)...\n' "$NVM_VERSION"
  _rc=0
  # PROFILE=/dev/null stops the official installer from editing shell rc files.
  # NVM_DIR points it at the directory the rest of this script will use.
  PROFILE=/dev/null NVM_DIR="$nvm_dir" bash "$installer" || _rc=$?
  rm -rf -- "$tmp_dir"

  if [ "$_rc" -ne 0 ]; then
    printf 'Error: the nvm installer exited with code %s.\n' "$_rc" >&2
    printf 'Install nvm manually, then re-run install.sh:\n' >&2
    _nvm_print_manual "$nvm_dir"
    return 1
  fi
  if [ ! -f "$nvm_file" ]; then
    printf 'Error: the nvm installer did not create %s.\n' "$nvm_file" >&2
    _nvm_print_manual "$nvm_dir"
    return 1
  fi

  _nvm_source_checked "$nvm_dir" "$nvm_file"
}
