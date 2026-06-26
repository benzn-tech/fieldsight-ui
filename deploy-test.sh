#!/usr/bin/env bash
# =============================================================================
# Deploy fieldsight-ui to the TEST environment — ALWAYS from origin/main.
#
#   Usage:  ./deploy-test.sh
#
# - Pulls the exact tree of origin/main (does NOT touch your current checkout /
#   working changes), so what ships is always the desktop-tested main.
# - Ships only web assets (*.html, scripts/**, styles/**); ignores .git, docs,
#   *.md, *.sh, editor configs, etc.
# - Sets app-shell-preview.html as index.html (CloudFront default root object).
# - Invalidates the test CloudFront distribution.
#
# Requires AWS CLI profile "fieldsight-deployer" (already configured locally).
# =============================================================================
set -euo pipefail

PROFILE=fieldsight-deployer
BUCKET=fieldsight-web-test-509194952652
DIST=E34AAK2PCGPWVZ
URL=https://d3qwnuldpg1tmp.cloudfront.net
REF=origin/main

REPO="$(cd "$(dirname "$0")" && pwd)"
TMP="$REPO/.deploy-tmp"

echo "==> [1/4] fetch $REF"
git -C "$REPO" fetch origin --quiet

echo "==> [2/4] export $REF tree (your working branch is untouched)"
rm -rf "$TMP"; mkdir -p "$TMP"
git -C "$REPO" archive "$REF" | tar -x -C "$TMP"

echo "==> [3/4] sync web assets -> s3://$BUCKET"
aws s3 sync "$TMP/" "s3://$BUCKET/" --delete \
  --exclude "*" --include "*.html" --include "scripts/*" --include "styles/*" --exclude "index.html" \
  --cache-control "max-age=60" --only-show-errors --profile "$PROFILE"
aws s3 cp "$TMP/app-shell-preview.html" "s3://$BUCKET/index.html" \
  --content-type "text/html" --cache-control "max-age=60" --only-show-errors --profile "$PROFILE"
rm -rf "$TMP"

echo "==> [4/4] invalidate CloudFront $DIST"
INVID=$(MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation --distribution-id "$DIST" \
  --paths "/*" --profile "$PROFILE" --query "Invalidation.Id" --output text)

echo
echo "Done. Deployed origin/main -> $URL  (invalidation: $INVID)"
echo "Changes appear in ~30-60s once the invalidation completes."
