#!/usr/bin/env bash
# apply-category-overrides.sh
#
# Fresh-onboarding priming ONLY. Reads category-overrides-starter.json
# and uploads a _meta.json to overrides/{slug}/ for each entry via wrangler.
#
# WARNING: This script overwrites live admin overrides. NEVER run it on
# an established deployment without --force. Use scripts/regenerate-starter.sh
# first if you want to rebuild the starter JSON from current R2 truth.
#
# Usage:
#   ./scripts/apply-category-overrides.sh                    # upload to R2 (refuses if populated)
#   ./scripts/apply-category-overrides.sh --dry-run          # print paths only
#   ./scripts/apply-category-overrides.sh --force            # bypass populated-bucket safety
#   ./scripts/apply-category-overrides.sh --dry-run --force  # combine
#
# Requirements: jq, npx (wrangler), wrangler authentication

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CATALOG="$SCRIPT_DIR/category-overrides-starter.json"
BUCKET="servant-voice-kb"
DRY_RUN=false
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force) FORCE=true ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run — no uploads will be made."
fi

# Safety check: refuse to run on an established deployment without --force.
# Proxy for "established" = site manifest already has >10 articles.
if [[ "$FORCE" != "true" ]]; then
  safety_tmp=$(mktemp -t sv-manifest-check)
  if npx wrangler r2 object get "$BUCKET/processed/_site-manifest.json" \
      --remote --file "$safety_tmp" >/dev/null 2>&1; then
    existing=$(jq 'length' "$safety_tmp" 2>/dev/null || echo 0)
    rm -f "$safety_tmp"
    if (( existing > 10 )); then
      cat <<EOF >&2

ERROR: Target bucket is already populated ($existing articles in the site manifest).
This script overwrites live admin overrides and would revert any admin
edits made since the starter JSON was generated.

If you intentionally want to re-baseline overrides from the starter JSON,
re-run with:  $0 --force

To refresh the starter JSON from current R2 state first:
  ./scripts/regenerate-starter.sh
EOF
      exit 1
    fi
  else
    rm -f "$safety_tmp"
  fi
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
tmpfile=$(mktemp -t sv-override-meta)
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
