#!/usr/bin/env bash
# apply-category-overrides.sh
#
# Reads category-overrides-starter.json and uploads a _meta.json to
# overrides/{slug}/ for each entry via wrangler.
#
# Usage:
#   ./scripts/apply-category-overrides.sh            # upload to R2
#   ./scripts/apply-category-overrides.sh --dry-run  # print paths only
#
# Requirements: jq, npx (wrangler), wrangler authentication

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CATALOG="$SCRIPT_DIR/category-overrides-starter.json"
BUCKET="servant-voice-kb"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "Dry run — no uploads will be made."
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install it with: brew install jq" >&2
  exit 1
fi

if [[ ! -f "$CATALOG" ]]; then
  echo "Error: $CATALOG not found." >&2
  exit 1
fi

count=$(jq 'length' "$CATALOG")
echo "Processing $count articles from $CATALOG..."
echo

uploaded=0
skipped=0
tmpfile=$(mktemp /tmp/override-meta-XXXXXX.json)
trap 'rm -f "$tmpfile"' EXIT

for i in $(seq 0 $((count - 1))); do
  entry=$(jq -c ".[$i]" "$CATALOG")
  slug=$(echo "$entry" | jq -r '.slug')
  r2_key="overrides/${slug}/_meta.json"

  # Build minimal _meta.json from the entry fields present
  jq -n \
    --argjson entry "$entry" \
    '{
      slug: $entry.slug,
      category: $entry.category,
      displayCategory: ($entry.displayCategory // null),
      breadcrumb: ($entry.breadcrumb // null)
    } | with_entries(select(.value != null))' > "$tmpfile"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  would upload: $r2_key"
    ((uploaded++)) || true
  else
    if npx wrangler r2 object put "$BUCKET/$r2_key" \
        --remote \
        --file "$tmpfile" \
        --content-type "application/json" \
        2>/dev/null; then
      echo "  uploaded: $r2_key"
      ((uploaded++)) || true
    else
      echo "  FAILED:   $r2_key" >&2
      ((skipped++)) || true
    fi
  fi
done

echo
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run complete. Would upload $uploaded overrides."
else
  echo "Done. Uploaded: $uploaded, Failed: $skipped"
  echo
  echo "Next: trigger a pipeline run to apply these overrides to processed/ and rebuild manifests."
fi
