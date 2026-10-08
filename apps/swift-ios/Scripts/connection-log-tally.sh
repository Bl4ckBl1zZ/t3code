#!/usr/bin/env bash
# Capture and tally the [conn] connection-lifecycle diagnostics.
#
# Capture from a booted simulator (writes the raw stream to a file, Ctrl-C to stop):
#   Scripts/connection-log-tally.sh stream [output-file]
#
# Tally any capture (from the stream mode above, or text exported from
# Console.app when reproducing on a physical device — filter Console on
# subsystem com.t3code, category connection):
#   Scripts/connection-log-tally.sh tally <capture-file>
set -euo pipefail

PREDICATE='subsystem == "com.t3code" AND category == "connection"'

usage() {
  sed -n '2,10p' "$0" >&2
  exit 1
}

cmd="${1:-}"
case "$cmd" in
  stream)
    out="${2:-/tmp/t3-conn-$(date +%H%M%S).log}"
    echo "Capturing to $out (Ctrl-C to stop, then: $0 tally $out)" >&2
    # --level info: the connected/start-polling/reload events log at info,
    # which the stream omits by default.
    xcrun simctl spawn booted log stream \
      --level info \
      --style compact \
      --predicate "$PREDICATE" | tee "$out"
    ;;
  tally)
    file="${2:-}"
    [ -f "$file" ] || usage
    echo "== Event counts =="
    grep -o '\[conn\] [a-z-]*' "$file" | awk '{print $2}' | sort | uniq -c | sort -rn
    echo
    echo "== start-polling / reload attribution =="
    { grep -o 'reason=[a-z-]*' "$file" || true; } | sort | uniq -c | sort -rn
    echo
    echo "== client-replaced fields =="
    { grep -o 'changed=[a-zA-Z,]*' "$file" || true; } | sort | uniq -c | sort -rn
    echo
    echo "== Failure reasons (deduped) =="
    { grep -o 'error=.*' "$file" || true; } | sort | uniq -c | sort -rn | head -20
    echo
    echo "== Thread opens: milestone, count, average and worst ms since the tap =="
    { grep -o 'thread-open [a-z-]* thread=[^ ]* ms=[0-9]*' "$file" || true; } \
      | awk '{ split($4, v, "="); n[$2]++; s[$2] += v[2]; if (v[2] > w[$2]) w[$2] = v[2] }
             END { for (k in n) printf "%-12s %5d %8.0f %8d\n", k, n[k], s[k] / n[k], w[k] }'
    ;;
  *)
    usage
    ;;
esac
