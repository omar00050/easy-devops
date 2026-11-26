#!/usr/bin/env bash
# pm2.sh — the installer's PM2 offer
# Sourced by install.sh; not executed directly.
#
# One model, and it is the user's own PM2, exactly as anyone installs it:
# `npm i -g pm2` with the npm that installed Easy DevOps, as the account
# running this installer, into that account's npm prefix and its default PM2
# home (~/.pm2). Easy DevOps never creates a PM2 home of its own, never
# installs a second copy, never starts a daemon here, and never moves,
# restarts or touches an app that already exists.
#
# PM2 being absent is not an Easy DevOps error: the package installs and runs
# without it, and every PM2 action says what is missing. So nothing in this
# file may turn a failed PM2 install into a failed Easy DevOps install.
#
# install.sh sets PM2_CHOICE from the flags:
#   ask (default)  ask when there is a terminal, otherwise print the command
#   yes (--pm2)    install without asking
#   no  (--no-pm2) do not install, and do not ask
#
# Functions:
#   maybe_install_pm2     — the whole offer; always returns 0
#   pm2_available         — is `pm2` on PATH for this user
#   pm2_version           — the version of the installed PM2 package, read from
#                           its package.json (pm2 is never executed)
#
# The answer is read through pm2_open_terminal / pm2_prompt_answer so the two
# I/O steps are the only part a test has to replace. The decision, the printed
# command and the npm invocation stay real.

PM2_INSTALL_CMD="npm i -g pm2"

# The answer, shared by the prompt and the decision.
_PM2_ANSWER=""

# Is PM2 installed for THIS user? `command -v` is the same resolution every
# later PM2 call uses, so the installer and the CLI cannot disagree about it.
pm2_available() {
  command -v pm2 >/dev/null 2>&1
}

# The version, read from the installed PM2 package -- never by running pm2.
# Every pm2 command starts the PM2 daemon when none is running (PM2's own
# lib/Client.js does it), and an installer must not be the thing that starts
# one. `npm root -g` is the same npm that installed it, so the package.json
# beside it is the copy this account actually has. Unknown when npm or the
# package is not there; that only changes the wording, never the decision.
pm2_version() {
  local _root="" _pkg="" _v=""
  _root="$(npm root -g 2>/dev/null | tr -d '\r' | head -n 1 || true)"
  if [ -n "$_root" ]; then
    _pkg="$_root/pm2/package.json"
    if [ -f "$_pkg" ]; then
      _v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_pkg" | head -n 1 || true)"
    fi
  fi
  printf '%s\n' "${_v:-unknown}"
}

# Open the terminal on fd 3 ONCE, and let the open decide whether there is one.
# A "[ -r /dev/tty ]" test is not enough: it can pass while the open then fails.
# A plain `read` on stdin is worse -- it consumes a piped installer, or sees EOF
# and takes the default, and the default here is No, so guessing is exactly what
# must not happen. The braces matter: the shell's own diagnostic goes inside the
# redirect too.
pm2_open_terminal() {
  { exec 3</dev/tty; } 2>/dev/null
}

# The single question. Its own function so the answer can be exercised without a
# real terminal; the decision below is never faked.
pm2_prompt_answer() {
  _PM2_ANSWER=""
  IFS= read -r _PM2_ANSWER <&3 || _PM2_ANSWER=""
}

# Only an explicit yes installs. Empty, EOF, "n", "no" and anything unexpected
# all mean no.
pm2_answer_is_yes() {
  case "${1:-}" in
    [Yy]|[Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

_close_pm2_terminal() {
  exec 3<&- 2>/dev/null || true
}

# The offer itself. Called after Easy DevOps is installed and before the
# background-service offer. Every path returns 0 on purpose.
maybe_install_pm2() {
  local _choice="${PM2_CHOICE:-ask}"
  local _version=""

  if pm2_available; then
    _version="$(pm2_version)"
    if [ "$_version" = "unknown" ]; then
      printf '  PM2 is already installed; nothing to install.\n'
    else
      printf '  PM2 %s is already installed; nothing to install.\n' "$_version"
    fi
    return 0
  fi

  if [ "$_choice" = "no" ]; then
    printf '  Skipping PM2 (--no-pm2). Install it later with: %s\n' "$PM2_INSTALL_CMD"
    return 0
  fi

  if [ "$_choice" != "yes" ]; then
    if ! pm2_open_terminal; then
      # No terminal: a CI run, a Dockerfile, or curl | bash with no /dev/tty.
      # Never guess on an install question; say exactly what to run instead.
      printf '\n  PM2 is not installed.\n'
      printf '  No terminal is available, so it was not installed. Install it with:\n'
      printf '    %s\n' "$PM2_INSTALL_CMD"
      return 0
    fi

    printf '\n'
    printf '  Easy DevOps runs the apps it deploys with PM2, and shows the PM2 apps\n'
    printf '  you already have. PM2 is not installed yet.\n'
    printf '\n'
    printf '  It would be installed globally, for the account running this installer\n'
    printf '  (%s), with that account'"'"'s npm and its usual PM2 home. Nothing else\n' "${USER:-the current user}"
    printf '  is created, and existing apps are not touched.\n'
    printf '\n'
    printf '  Install PM2 now? [y/N] '

    pm2_prompt_answer
    if ! pm2_answer_is_yes "${_PM2_ANSWER:-}"; then
      _close_pm2_terminal
      printf '\n\n  PM2 was not installed. Install it later with: %s\n\n' "$PM2_INSTALL_CMD"
      return 0
    fi
    _close_pm2_terminal
  fi

  if ! command -v npm >/dev/null 2>&1; then
    printf '\n  npm is not on PATH, so PM2 was not installed.\n'
    printf '  Install it with: %s\n' "$PM2_INSTALL_CMD"
    return 0
  fi

  printf '\n  Installing PM2 globally: %s\n' "$PM2_INSTALL_CMD"
  printf '  with %s, as %s (this can take a minute)\n\n' "$(command -v npm)" "${USER:-the current user}"

  # The user's own npm, in the user's own prefix -- the same context as the
  # `npm install -g easy-devops` above, and no different. Never elevated here:
  # the installer must not ask for a password on PM2's behalf. A failure is
  # printed with its own reason and never fails the Easy DevOps install.
  if npm i -g pm2; then
    _version="$(pm2_version)"
    if [ "$_version" != "unknown" ]; then
      printf '\n  PM2 %s installed.\n' "$_version"
    elif pm2_available; then
      printf '\n  PM2 installed.\n'
    else
      printf '\n  PM2 was installed. Open a new terminal if the pm2 command is not found yet.\n'
    fi
    return 0
  fi

  printf '\n  PM2 was not installed. Easy DevOps is installed and works without it.\n'
  printf '  The command was:\n'
  printf '    %s\n' "$PM2_INSTALL_CMD"
  printf '  If npm reported a permission error, run it with the same rights your\n'
  printf '  global npm prefix needs (for example: sudo npm i -g pm2), then retry.\n\n'
  return 0
}
