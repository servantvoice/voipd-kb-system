#!/usr/bin/env bash
#
# Pushes environment variables to Cloudflare Workers and Pages.
#
# Usage:
#   bash scripts/push-vars.sh              # push non-secret vars only
#   bash scripts/push-vars.sh --secrets    # push secrets via wrangler secret put
#   bash scripts/push-vars.sh --all        # push both vars and secrets
#
# Reads from .env.private (or pass a custom path as second arg).
# Requires: wrangler CLI logged in, CLOUDFLARE_ACCOUNT_ID set or wrangler prompts.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:---vars}"
ENV_FILE="${2:-.env.private}"

if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$REPO_ROOT/$ENV_FILE"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found."
  exit 1
fi

# Parse env file
declare -A VARS
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue
  if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*) ]]; then
    VARS["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
  fi
done < "$ENV_FILE"

# Helper: get a var value or skip if empty
get_var() {
  local val="${VARS[$1]:-}"
  if [[ -z "$val" ]]; then
    return 1
  fi
  echo "$val"
}

# Helper: push a non-secret var to a worker
push_var() {
  local worker_dir="$1"
  local var_name="$2"
  local val
  val="$(get_var "$var_name")" || return 0

  echo "  $var_name"
  (cd "$REPO_ROOT/$worker_dir" && npx wrangler vars set "$var_name" "$val" 2>/dev/null) || {
    echo "    WARNING: failed to set $var_name on $worker_dir"
  }
}

# Helper: push a secret to a worker
push_secret() {
  local worker_dir="$1"
  local var_name="$2"
  local val
  val="$(get_var "$var_name")" || return 0

  echo "  $var_name"
  echo "$val" | (cd "$REPO_ROOT/$worker_dir" && npx wrangler secret put "$var_name" 2>/dev/null) || {
    echo "    WARNING: failed to set secret $var_name on $worker_dir"
  }
}

# ─── Non-secret variables ────────────────────────────────────────────

push_worker_vars() {
  echo ""
  echo "=== workers/crawl ==="
  push_var workers/crawl CF_ACCOUNT_ID

  echo ""
  echo "=== workers/pipeline ==="
  for v in KB_DOMAIN INTERNAL_KB_DOMAIN IMAGE_DOMAIN MANAGER_PORTAL_URL \
           SOURCE_IMAGE_CDN BRAND_NAME CONNECT_NAME CONNECT_DESKTOP_NAME \
           NOTIFICATION_TO NOTIFICATION_FROM PAGES_DEPLOY_HOOK IMAGE_SYNC_URL; do
    push_var workers/pipeline "$v"
  done

  echo ""
  echo "=== workers/internal ==="
  for v in KB_DOMAIN INTERNAL_KB_DOMAIN ADMIN_EMAILS EDITOR_EMAILS \
           VIEWER_EMAILS PAGES_DEPLOY_HOOK BRAND_NAME SITE_TITLE; do
    push_var workers/internal "$v"
  done

  echo ""
  echo "=== workers/images ==="
  for v in IMAGE_DOMAIN SOURCE_IMAGE_CDN ADDITIONAL_IMAGE_SOURCES \
           REVALIDATE_HOURS MAX_CONCURRENT; do
    push_var workers/images "$v"
  done
}

# ─── Secrets ──────────────────────────────────────────────────────────

push_worker_secrets() {
  echo ""
  echo "=== Secrets: workers/crawl ==="
  push_secret workers/crawl CRAWL_SECRET
  push_secret workers/crawl CF_API_TOKEN

  echo ""
  echo "=== Secrets: workers/pipeline ==="
  push_secret workers/pipeline CRAWL_SECRET
  push_secret workers/pipeline POSTMARK_API_TOKEN
  push_secret workers/pipeline RESEND_API_KEY

  echo ""
  echo "=== Secrets: workers/internal ==="
  push_secret workers/internal CRAWL_SECRET

  echo ""
  echo "=== Secrets: workers/images ==="
  push_secret workers/images CRAWL_SECRET
}

# ─── Main ─────────────────────────────────────────────────────────────

echo "Reading from $ENV_FILE"

case "$MODE" in
  --vars)
    echo "Pushing non-secret variables to Cloudflare Workers..."
    push_worker_vars
    echo ""
    echo "Done. Secrets were NOT pushed — run with --secrets or --all to push them."
    echo ""
    echo "NOTE: CF Pages variables (HUGO_*, R2_*, KB_DOMAIN_URL) must be set"
    echo "in the CF Pages dashboard manually — wrangler does not support Pages vars."
    ;;
  --secrets)
    echo "Pushing secrets to Cloudflare Workers..."
    push_worker_secrets
    echo ""
    echo "Done. Non-secret vars were NOT pushed — run with --vars or --all."
    ;;
  --all)
    echo "Pushing all variables and secrets to Cloudflare Workers..."
    push_worker_vars
    push_worker_secrets
    echo ""
    echo "Done."
    echo ""
    echo "NOTE: CF Pages variables (HUGO_*, R2_*, KB_DOMAIN_URL) must be set"
    echo "in the CF Pages dashboard manually — wrangler does not support Pages vars."
    ;;
  *)
    echo "Usage: bash scripts/push-vars.sh [--vars|--secrets|--all] [env-file]"
    exit 1
    ;;
esac
