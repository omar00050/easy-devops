#!/usr/bin/env bash
# progress.sh — Step progress display helpers
# Sourced by install.sh; not executed directly.
#
# Functions:
#   step_pending  <label>  — print "[ ] <label>"  to stdout
#   step_running  <label>  — print "[→] <label>"  to stdout
#   step_done     <label>  — print "[✓] <label>"  to stdout
#   step_failed   <label>  — print "[✗] <label>"  to stderr

step_pending() {
  printf '[ ] %s\n' "$1"
}

step_running() {
  printf '[→] %s\n' "$1"
}

step_done() {
  printf '[✓] %s\n' "$1"
}

step_failed() {
  printf '[✗] %s\n' "$1" >&2
}
