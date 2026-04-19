#!/usr/bin/env bash
# regenerate-starter.sh
#
# Rebuilds scripts/category-overrides-starter.json from the CURRENT live
# R2 site manifest (processed/_site-manifest.json). The manifest is the
# authoritative merged view: the pipeline writes it by combining hardcoded
# URL categorization (shared/categorization.ts) with any admin overrides
# (overrides/{slug}/_meta.json), so reading it gives us current truth in
# one call.
#
# Run this ONLY when you want to re-baseline the starter JSON from live
# R2. It is NOT a deploy step. The starter JSON primes fresh onboarding
# deployments; it must not drift from the hardcoded categorization rules,
# nor from admin-entered overrides.
#
# Usage:
#   ./scripts/regenerate-starter.sh
#
# Requirements: jq, npx wrangler, wrangler authentication

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/category-overrides-starter.json"
BUCKET="servant-voice-kb"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install it with: brew install jq" >&2
  exit 1
fi

tmp_manifest=$(mktemp -t sv-manifest)
trap 'rm -f "$tmp_manifest"' EXIT

echo "Fetching current site manifest from R2..."
npx wrangler r2 object get "$BUCKET/processed/_site-manifest.json" \
  --remote --file "$tmp_manifest" >/dev/null

total=$(jq 'length' "$tmp_manifest")
echo "Manifest has $total articles. Building starter JSON..."

# Extract the fields the starter wants: slug, category, displayCategory, breadcrumb.
# Drop null/empty fields. Exclude pending-review articles (not yet approved
# into the baseline) and excluded articles.
jq '
  [ .[]
    | select(.category != "excluded")
    | select(.status != "pending-review")
    | {
        slug: .slug,
        category: (.category // "public"),
        displayCategory: (.displayCategory // null),
        breadcrumb: (.breadcrumb // null),
      }
    | with_entries(select(.value != null))
  ]
' "$tmp_manifest" > "$OUT"

count=$(jq 'length' "$OUT")
echo
echo "Wrote $count entries to $OUT"
echo "Review the diff, then commit if it looks right."
