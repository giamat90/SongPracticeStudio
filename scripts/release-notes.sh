#!/usr/bin/env bash
# Prints the CHANGELOG.md section for a version (e.g. 0.1.62 or v0.1.62).
# Fails if the section is missing or empty, so a tag without a changelog entry cannot be released.
set -euo pipefail
version="${1#v}"
file="${2:-CHANGELOG.md}"
notes=$(awk -v h="## [$version]" '
  index($0, h) == 1 { on = 1; next }
  on && /^## \[/ { exit }
  on { print }
' "$file" | sed -e :a -e '/^[[:space:]]*$/{$d;N;ba' -e '}' | sed '/./,$!d')
if [ -z "$notes" ]; then
  echo "No CHANGELOG.md entry for $version" >&2
  exit 1
fi
printf '%s\n' "$notes"
