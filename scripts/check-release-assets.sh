#!/usr/bin/env bash
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

echo "🔎 Checking release assets for ${RELEASE_TAG}..."

# Get release assets
ASSETS=$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}" --jq '.assets[] | .name')

if [[ -z "$ASSETS" ]]; then
  echo "❌ Release ${RELEASE_TAG} has NO assets!"
  exit 1
fi

ASSET_COUNT=$(echo "$ASSETS" | wc -l)
echo "📦 Found ${ASSET_COUNT} asset(s):"
echo "$ASSETS"

# Check for expected asset types
HAS_APK=false
HAS_AAB=false
HAS_DIST=false
HAS_MANIFEST=false

while IFS= read -r asset; do
  case "$asset" in
    *.apk) HAS_APK=true ;;
    *.aab) HAS_AAB=true ;;
    dist*.zip) HAS_DIST=true ;;
    update-manifest*.json) HAS_MANIFEST=true ;;
  esac
done <<< "$ASSETS"

MISSING=()
$HAS_APK || MISSING+=("APK")
$HAS_AAB || MISSING+=("AAB")
$HAS_DIST || MISSING+=("dist.zip")
$HAS_MANIFEST || MISSING+=("update-manifest.json")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "❌ Missing release assets for ${RELEASE_TAG}: ${MISSING[*]}"
  exit 1
fi

echo "✅ All expected Android release assets present for ${RELEASE_TAG}"
