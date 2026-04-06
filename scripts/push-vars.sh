#!/usr/bin/env bash
#
# Pushes environment variables to Cloudflare Workers using `wrangler secret bulk`.
# This uploads all vars (both secrets and non-secrets) as encrypted values.
#
# Usage:
#   bash scripts/push-vars.sh           # push all vars to all workers
#   bash scripts/push-vars.sh crawl     # push to a single worker
#
# Prerequisites:
#   1. Run `bash scripts/setup-env.sh` first to generate .dev.vars files
#   2. Workers must be deployed first (`npm run deploy:all`)
#   3. Wrangler must be logged in
#
# Note: CF Pages variables (HUGO_*, R2_*, KB_DOMAIN_URL) must be set
# in the CF Pages dashboard manually — wrangler does not support Pages.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-all}"

push_worker() {
  local worker_dir="$1"
  local worker_name="$2"
  local dev_vars="$REPO_ROOT/$worker_dir/.dev.vars"

  if [[ ! -f "$dev_vars" ]]; then
    echo "  SKIP: $dev_vars not found (run scripts/setup-env.sh first)"
    return
  fi

  # Filter out comments and blank lines for display
  local var_count
  var_count=$(grep -c '=' "$dev_vars" 2>/dev/null || echo 0)
  echo "  Pushing $var_count vars from $worker_dir/.dev.vars..."

  (cd "$REPO_ROOT/$worker_dir" && npx wrangler secret bulk "$dev_vars") || {
    echo "  ERROR: failed to push vars to $worker_name"
    return 1
  }
  echo ""
}

echo "Pushing variables to Cloudflare Workers via 'wrangler secret bulk'..."
echo "(All vars are stored encrypted — both secrets and non-secrets.)"
echo ""

case "$TARGET" in
  all)
    echo "=== workers/crawl ==="
    push_worker workers/crawl cf-crawl

    echo "=== workers/pipeline ==="
    push_worker workers/pipeline cf-pipeline

    echo "=== workers/internal ==="
    push_worker workers/internal cf-internal

    echo "=== workers/images ==="
    push_worker workers/images cf-images
    ;;
  crawl)
    push_worker workers/crawl cf-crawl
    ;;
  pipeline)
    push_worker workers/pipeline cf-pipeline
    ;;
  internal)
    push_worker workers/internal cf-internal
    ;;
  images)
    push_worker workers/images cf-images
    ;;
  *)
    echo "Usage: bash scripts/push-vars.sh [all|crawl|pipeline|internal|images]"
    exit 1
    ;;
esac

echo "Done."
echo ""
echo "NOTE: CF Pages variables (HUGO_*, R2_*, KB_DOMAIN_URL) must be set"
echo "in the CF Pages dashboard manually — wrangler does not support Pages vars."
