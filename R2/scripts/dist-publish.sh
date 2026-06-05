#!/usr/bin/env bash
# Wrapper that loads ~/.r2-build.env (GH_TOKEN, APPLE_ID,
# APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID) and runs electron-builder.
# Keeps secrets out of the repo and out of shell history.

set -euo pipefail

ENV_FILE="${R2_BUILD_ENV:-$HOME/.r2-build.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Missing env file: $ENV_FILE" >&2
  echo "   Create it with GH_TOKEN, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

# Sanity check — fail loudly with actionable message instead of letting
# electron-builder spew a 200-line stack trace.
missing=()
for var in GH_TOKEN APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
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

MODE="${1:-publish}"

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
  *)
    echo "Usage: $0 [publish|local]" >&2
    exit 1
    ;;
esac
