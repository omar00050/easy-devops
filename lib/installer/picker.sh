#!/usr/bin/env bash
# picker.sh — Interactive Node.js version picker
# Sourced by install.sh; not executed directly.
# Requires: node-versions.sh sourced first (uses NODE_RELEASES global array).
#
# Functions:
#   pick_version  [current_version]
#
#   Uses NODE_RELEASES global array (set by fetch_node_versions).
#   Sets PICKED_VERSION to the chosen version string (e.g., "20.11.1").
#   Returns 2 if the user cancels (presses q / Ctrl-C).

pick_version() {
  local current_ver="${1:-}"
  local count="${#NODE_RELEASES[@]}"

  if [ "$count" -eq 0 ]; then
    printf 'Error: No Node.js releases available to pick from.\n' >&2
    return 1
  fi

  # Build display labels (mark currently installed version)
  PICKER_LABELS=()
  local i
  for (( i=0; i<count; i++ )); do
    local entry="${NODE_RELEASES[$i]}"
    local ver label
    ver="$(   printf '%s' "$entry" | cut -d'|' -f1)"
    label="$( printf '%s' "$entry" | cut -d'|' -f4)"
    if [ -n "$current_ver" ] && [ "$ver" = "$current_ver" ]; then
      PICKER_LABELS+=("${label}  [currently installed]")
    else
      PICKER_LABELS+=("$label")
    fi
  done

  # ------------------------------------------------------------------
  # TTY path: arrow-key picker using stty raw + ANSI escape codes
  # ------------------------------------------------------------------
  if [ -t 0 ] && [ -t 1 ]; then
    _pick_tty
    return $?
  fi

  # ------------------------------------------------------------------
  # Non-TTY / scripted path: numbered select list
  # ------------------------------------------------------------------
  _pick_numbered
}

# Internal: TTY arrow-key picker
_pick_tty() {
  local count="${#PICKER_LABELS[@]}"
  local selected=0

  # ANSI sequences
  local CLEAR_LINE BOLD RESET HIGHLIGHT
  CLEAR_LINE="\033[2K\r"
  BOLD="\033[1m"
  RESET="\033[0m"
  HIGHLIGHT="\033[7m"

  # Hide cursor
  printf '\033[?25l'

  # Save terminal state and restore on exit
  local old_stty
  old_stty="$(stty -g 2>/dev/null || true)"

  # Cleanup function
  _tty_cleanup() {
    stty "$old_stty" 2>/dev/null || true
    printf '\033[?25h'   # show cursor
  }
  trap '_tty_cleanup; return 2' INT TERM

  printf '\nSelect a Node.js version (up/down arrows, Enter to confirm, q to quit):\n\n'

  # Draw initial list
  local j
  for (( j=0; j<count; j++ )); do
    if [ "$j" -eq "$selected" ]; then
      printf "  ${HIGHLIGHT}${BOLD}> %s${RESET}\n" "${PICKER_LABELS[$j]}"
    else
      printf "    %s\n" "${PICKER_LABELS[$j]}"
    fi
  done

  # Enable raw mode for single-key reading
  stty raw -echo 2>/dev/null || true

  while true; do
    local ch seq1 seq2
    IFS= read -r -s -n1 ch 2>/dev/null || true

    if [ "$ch" = $'\x1b' ]; then
      IFS= read -r -s -n1 -t 0.1 seq1 2>/dev/null || seq1=""
      IFS= read -r -s -n1 -t 0.1 seq2 2>/dev/null || seq2=""
      if [ "$seq1" = "[" ]; then
        case "$seq2" in
          A) [ "$selected" -gt 0 ] && selected=$(( selected - 1 )) ;;
          B) [ "$selected" -lt $(( count - 1 )) ] && selected=$(( selected + 1 )) ;;
        esac
      fi
    elif [ "$ch" = $'\n' ] || [ "$ch" = $'\r' ] || [ -z "$ch" ]; then
      break
    elif [ "$ch" = "q" ] || [ "$ch" = "Q" ]; then
      _tty_cleanup
      trap - INT TERM
      printf '\n'
      return 2
    fi

    # Redraw: move cursor up count lines
    local k
    for (( k=0; k<count; k++ )); do
      printf "${CLEAR_LINE}\033[1A"
    done
    printf "${CLEAR_LINE}"
    for (( k=0; k<count; k++ )); do
      if [ "$k" -eq "$selected" ]; then
        printf "  ${HIGHLIGHT}${BOLD}> %s${RESET}\n" "${PICKER_LABELS[$k]}"
      else
        printf "    %s\n" "${PICKER_LABELS[$k]}"
      fi
    done
  done

  _tty_cleanup
  trap - INT TERM
  printf '\n'

  PICKED_VERSION="$(printf '%s' "${NODE_RELEASES[$selected]}" | cut -d'|' -f1)"
}

# Internal: numbered list fallback (non-TTY)
_pick_numbered() {
  local count="${#PICKER_LABELS[@]}"

  printf '\nAvailable Node.js versions:\n\n'
  local j
  for (( j=0; j<count; j++ )); do
    printf '  %d) %s\n' $(( j + 1 )) "${PICKER_LABELS[$j]}"
  done
  printf '\n'

  local choice
  while true; do
    printf 'Enter number (1-%d), or q to quit: ' "$count"
    IFS= read -r choice
    if [ "$choice" = "q" ] || [ "$choice" = "Q" ]; then
      return 2
    fi
    if printf '%s' "$choice" | grep -qE '^[0-9]+$'; then
      if [ "$choice" -ge 1 ] && [ "$choice" -le "$count" ]; then
        local idx=$(( choice - 1 ))
        PICKED_VERSION="$(printf '%s' "${NODE_RELEASES[$idx]}" | cut -d'|' -f1)"
        return 0
      fi
    fi
    printf 'Invalid selection. Please enter a number between 1 and %d.\n' "$count" >&2
  done
}
