#!/usr/bin/env bash
# node-versions.sh — Fetch and parse Node.js release list from nodejs.org
# Sourced by install.sh; not executed directly.
#
# Functions:
#   fetch_node_versions  — populate NODE_RELEASES array
#
# Exports:
#   NODE_RELEASES  — indexed array, each element: "version|major|lts_label|display_label"
#                    Up to 3 most-recent LTS majors (latest patch each) + 1 latest Current.
#                    Sorted descending by version.

fetch_node_versions() {
  local url="https://nodejs.org/dist/index.json"
  local raw=""

  # Fetch release index
  if command -v curl >/dev/null 2>&1; then
    raw="$(curl -fsSL --max-time 30 "$url" 2>/dev/null || true)"
  fi
  if [ -z "$raw" ] && command -v wget >/dev/null 2>&1; then
    raw="$(wget -qO- --timeout=30 "$url" 2>/dev/null || true)"
  fi

  if [ -z "$raw" ]; then
    printf 'Error: Failed to fetch Node.js release list from %s\n' "$url" >&2
    return 1
  fi

  # Parse JSON using awk (no jq dependency).
  # Strategy: normalise the JSON blob to one object per line, then extract
  # "version" and "lts" fields with awk string operations.
  #
  # Output format (one release per line): version|major|lts_label|display_label
  local parsed
  parsed="$(
    printf '%s' "$raw" \
      | tr -d '\n\r' \
      | sed 's/},{/}\n{/g' \
      | awk '
        BEGIN { lts_count = 0; current_done = 0; seen_majors = " " }
        {
          line = $0

          # --- extract "version":"vX.Y.Z" ---
          ver = ""
          tmp = line
          n = split(tmp, dummy, "\"version\":\"")
          if (n >= 2) {
            seg = dummy[2]
            ver_end = index(seg, "\"")
            if (ver_end > 0) ver = substr(seg, 1, ver_end - 1)
          }
          if (ver == "") next

          # strip leading "v"
          ver_bare = ver
          sub(/^v/, "", ver_bare)

          # major version number
          split(ver_bare, vparts, ".")
          major = vparts[1]

          # --- extract "lts":"CodeName" or "lts":false ---
          lts_val = "false"
          tmp2 = line
          m = split(tmp2, dummy2, "\"lts\":")
          if (m >= 2) {
            seg2 = dummy2[2]
            # Remove leading whitespace
            gsub(/^[ \t]+/, "", seg2)
            if (substr(seg2, 1, 1) == "\"") {
              # String value: "CodeName"
              seg2 = substr(seg2, 2)
              q_end = index(seg2, "\"")
              if (q_end > 0) lts_val = substr(seg2, 1, q_end - 1)
            }
            # else lts_val stays "false"
          }

          # --- accumulate up to 3 LTS majors + 1 Current ---
          if (lts_val != "false" && lts_val != "") {
            # LTS release — only first occurrence of each major
            if (index(seen_majors, " " major " ") == 0 && lts_count < 3) {
              seen_majors = seen_majors major " "
              lts_count++
              print ver_bare "|" major "|" lts_val "|" ver " LTS (" lts_val ")"
            }
          } else if (current_done == 0) {
            current_done = 1
            print ver_bare "|" major "|false|" ver " (Current)"
          }

          if (lts_count >= 3 && current_done == 1) exit
        }
      '
  )"

  # Load into NODE_RELEASES array
  NODE_RELEASES=()
  while IFS= read -r line; do
    [ -n "$line" ] && NODE_RELEASES+=("$line")
  done <<< "$parsed"

  if [ "${#NODE_RELEASES[@]}" -eq 0 ]; then
    printf 'Error: Could not parse any Node.js releases from the release index.\n' >&2
    return 1
  fi
}
