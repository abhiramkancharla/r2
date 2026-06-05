#!/usr/bin/env bash
# Wrapper that loads ~/.r2-build.env (GH_TOKEN, APPLE_ID,
# APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID) and runs electron-builder.
# Keeps secrets out of the repo and out of shell history.

set -euo pipefail

ENV_FILE="${R2_BUILD_ENV:-$HOME/.r2-build.env}"

MODE="${1:-publish}"

# Determine which env vars each mode requires.
# - publish/local need full set (notarize + upload OR notarize only).
# - sideload only needs nothing-from-Apple (sign uses keychain identity).
required=()
case "$MODE" in
  publish)  required=(GH_TOKEN APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID) ;;
  local)    required=(APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID) ;;
  sideload) required=() ;;  # sign-only, no Apple service round-trip
  *)
    echo "Usage: $0 [publish|local|sideload]" >&2
    echo "  publish  = build + sign + notarize + upload to GitHub Releases" >&2
    echo "  local    = build + sign + notarize, no upload (DMG in release/)" >&2
    echo "  sideload = build + sign only, skip notarize (use when Apple's notarytool is down)" >&2
    exit 1
    ;;
esac

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  . "$ENV_FILE"
  set +a
fi

if [ ${#required[@]} -gt 0 ]; then
  missing=()
  for var in "${required[@]}"; do
    if [ -z "${!var:-}" ] || [[ "${!var}" == PASTE_* ]]; then
      missing+=("$var")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "❌ The following vars are unset or still placeholders in $ENV_FILE:" >&2
    printf '   - %s\n' "${missing[@]}" >&2
    echo "   Edit that file and re-run." >&2
    exit 1
  fi
fi

case "$MODE" in
  publish)
    echo "→ build + publish (signed + notarized arm64)"
    npm run build
    npx electron-builder --mac --arm64 --publish always
    ;;
  local)
    echo "→ build only (signed + notarized arm64, no upload)"
    npm run build
    npx electron-builder --mac --arm64 --publish never
    ;;
  sideload)
    echo "→ build sign-only (no notarize, no upload) — Gatekeeper bypass on first launch"
    npm run build
    npx electron-builder --mac --arm64 --publish never -c.mac.notarize=false
    ;;
esac
