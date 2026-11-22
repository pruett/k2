#!/usr/bin/env bash
# k2 secret scan: for every value in ~/.config/k2/*.env, count occurrences in
# the working tree diff and in `git log -p <ref>`. Prints counts only, never
# values. Usage: tools/k2/secret-scan.sh [ref]   (default: HEAD)
set -euo pipefail
ref="${1:-HEAD}"
log="$(mktemp)"; trap 'rm -f "$log"' EXIT
git log -p "$ref" > "$log"
git diff HEAD >> "$log"
fail=0
for f in "$HOME"/.config/k2/*.env; do
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in ''|'#'*) continue ;; esac
		name="${line%%=*}"; value="${line#*=}"
		value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
		[ "${#value}" -ge 8 ] || continue
		# Values stored with \\n escapes (PEM) are checked by their first body line.
		probe="$(printf '%s' "$value" | sed 's/\\n/\n/g' | sed -n '2p')"; [ -n "$probe" ] || probe="$value"
		count="$(grep -cF -- "$probe" "$log" || true)"
		echo "$(basename "$f") $name: $count"
		[ "$count" = 0 ] || fail=1
	done < "$f"
done
exit "$fail"
