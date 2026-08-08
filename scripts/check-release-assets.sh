#!/usr/bin/env bash
# Verify that all assets referenced in the release are actually uploaded.
set -euo pipefail

if [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
  echo "GITHUB_REPOSITORY is required (e.g. misospace/miso-chat)"
  exit 1
fi

RELEASE_TAG="${1:-${RELEASE_TAG:-}}"
if [[ -z "$RELEASE_TAG" ]]; then
  echo "Release tag is required (pass as argument or set RELEASE_TAG env var)"
  exit 1
fi

echo "=== Verifying release assets for ${RELEASE_TAG} ==="

# Get release assets
ASSETS=$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}" --jq '.assets[] | .name')

if [[ -z "$ASSETS" ]]; then
  echo "No assets found for release ${RELEASE_TAG}"
  exit 1
fi

ASSET_COUNT=$(echo "$ASSETS" | wc -l)
echo "Found ${ASSET_COUNT} asset(s):"
echo "$ASSETS"

# Verify expected assets are present
EXPECTED_ASSETS=(
  "dist.zip"
  "update-manifest.json"
)

for asset in "${EXPECTED_ASSETS[@]}"; do
  if echo "$ASSETS" | grep -qx "$asset"; then
    echo "OK: ${asset} found"
  else
    echo "ERROR: ${asset} not found in release assets"
    exit 1
  fi
done

# Verify APK and AAB are present (match renamed pattern)
VERSION="${RELEASE_TAG#v}"
APK_PATTERN="miso-chat-${VERSION}-release.apk"
AAB_PATTERN="miso-chat-${VERSION}.aab"

if echo "$ASSETS" | grep -q "^${APK_PATTERN}$"; then
  echo "OK: ${APK_PATTERN} found"
else
  echo "ERROR: ${APK_PATTERN} not found in release assets"
  exit 1
fi

if echo "$ASSETS" | grep -q "^${AAB_PATTERN}$"; then
  echo "OK: ${AAB_PATTERN} found"
else
  echo "ERROR: ${AAB_PATTERN} not found in release assets"
  exit 1
fi

# Verify manifest URLs resolve (HTTP 200)
echo ""
echo "=== Verifying manifest asset URLs ==="

MANIFEST_URL="https://github.com/${GITHUB_REPOSITORY}/releases/download/${RELEASE_TAG}/update-manifest.json"
MANIFEST=$(curl -sL --fail "$MANIFEST_URL")

# Extract all apkUrl, aabUrl, bundleUrl from the manifest
URLS=$(echo "$MANIFEST" | jq -r '.. | .apkUrl? // .aabUrl? // .bundleUrl? // empty' | sort -u)

for url in $URLS; do
  if [ -z "$url" ]; then
    continue
  fi
  HTTP_CODE=$(curl -sL -o /dev/null -w "%{http_code}" "$url")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "OK: ${url} (HTTP ${HTTP_CODE})"
  else
    echo "ERROR: ${url} returned HTTP ${HTTP_CODE}"
    exit 1
  fi
done

# Verify digest is non-empty in the manifest
DIGEST=$(echo "$MANIFEST" | jq -r '.. | .digest? // empty' | head -1)
if [ -z "$DIGEST" ]; then
  echo "ERROR: No digest found in update-manifest.json"
  exit 1
fi
echo "OK: Digest present: ${DIGEST:0:16}..."

echo ""
echo "=== All release asset checks passed ==="
