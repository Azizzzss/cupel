#!/usr/bin/env bash
#
# Every panel query in every dashboard, asked of a live Prometheus.
#
# A dashboard is the one part of this repo that cannot fail loudly: rename a
# metric upstream and the panel does not error, it just draws an empty box that
# looks like a quiet chain. That is how the community geth dashboards rotted —
# the 2021 one still renders, it simply plots metrics geth stopped emitting.
# This is the external anchor that stops the same thing happening here.
#
#   check-dashboards.sh [prometheus-url] [mode]
#
# mode is `lab` or `network` and decides only which panels are allowed to be
# empty: a lab node runs --maxpeers 0 --nodiscover, so its peer counters are
# legitimately absent and an empty panel there is the honest answer.

set -euo pipefail

PROM="${1:-http://127.0.0.1:9090}"
MODE="${2:-lab}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DASHBOARDS="$ROOT/config/grafana/dashboards"

# Panels whose emptiness is a property of the mode rather than a fault. Matched
# against "<dashboard>:<panel title>".
allowed_empty() {
  local key="$1"
  case "$MODE" in
    lab)
      case "$key" in
        # No peers to have: one node, discovery off.
        "execution:Peers"|"execution:Bytes on the wire") return 0 ;;
        # Every panel on the network dashboard needs consensus clients.
        "network:"*) return 0 ;;
      esac
      ;;
    network)
      case "$key" in
        # Lab mode runs the gateway; network mode does not. The gateway dashboard
        # is cupel.json — the original, from before there was more than one.
        "cupel:"*) return 0 ;;
      esac
      ;;
  esac
  return 1
}

fail=0
checked=0
skipped=0

# Which targets Prometheus is actually scraping, before any panel is judged.
# Every panel being empty almost always means the targets were down rather than
# the queries being wrong, and without this the output is twenty identical
# failures that name the wrong culprit.
echo "── targets"
curl -sfG "$PROM/api/v1/query" --data-urlencode 'query=up' \
  | jq -r '.data.result[] | "   \(if .value[1] == "1" then "up  " else "DOWN" end)  \(.metric.job)  \(.metric.instance)"' \
  | sort || echo "   could not reach Prometheus at $PROM"
echo

# uids must be unique or Grafana silently serves one dashboard twice.
dupes="$(jq -r '.uid' "$DASHBOARDS"/*.json | sort | uniq -d)"
if [ -n "$dupes" ]; then
  echo "FAIL  duplicate dashboard uid(s): $dupes"
  fail=1
fi

for file in "$DASHBOARDS"/*.json; do
  name="$(basename "$file" .json)"

  if ! jq empty "$file" 2>/dev/null; then
    echo "FAIL  $name: not valid JSON"
    fail=1
    continue
  fi

  echo "── $name ($(jq -r '.title' "$file"))"

  # Panel title and query together, tab-separated, so a failure names the panel
  # a person has to go and look at rather than just an expression.
  while IFS=$'\t' read -r title expr; do
    [ -z "$expr" ] && continue
    checked=$((checked + 1))

    body="$(curl -sG --max-time 10 "$PROM/api/v1/query" --data-urlencode "query=$expr")"
    status="$(printf '%s' "$body" | jq -r '.status // "error"')"

    if [ "$status" != "success" ]; then
      echo "   FAIL  $title"
      echo "         $expr"
      echo "         $(printf '%s' "$body" | jq -r '.error // "no response from Prometheus"')"
      fail=1
      continue
    fi

    count="$(printf '%s' "$body" | jq -r '.data.result | length')"
    if [ "$count" -eq 0 ]; then
      if allowed_empty "$name:$title"; then
        echo "   skip  $title — empty, expected in $MODE mode"
        skipped=$((skipped + 1))
      else
        echo "   FAIL  $title returned no series"
        echo "         $expr"
        fail=1
      fi
    else
      echo "   ok    $title ($count series)"
    fi
  done < <(jq -r '.panels[] | .title as $t | .targets[]? | select(.expr) | "\($t)\t\(.expr)"' "$file")
done

echo
resolved=$((checked - skipped))
if [ "$fail" -ne 0 ]; then
  echo "dashboards: FAILED ($resolved of $checked resolved, $skipped skipped, mode=$MODE)"
  exit 1
fi
# A skipped query is one nobody asked Prometheus to answer, and counting those
# as resolved is how a run that verified nothing reports success. If every query
# was skipped — or there were none to find, which a jq expression that stopped
# matching would produce — this script has checked nothing at all.
if [ "$resolved" -eq 0 ]; then
  echo "dashboards: FAILED — nothing was verified ($checked seen, $skipped skipped, mode=$MODE)"
  exit 1
fi
echo "dashboards: $resolved of $checked queries resolved, $skipped skipped as expected in $MODE mode"
