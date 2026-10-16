#!/bin/zsh
# One-command release: build on the Windows machine, tag, push, and publish the GitHub release.
# The app does not read update.json (it asks the GitHub releases API of zai-one/chawo-va).
#   tools/release.sh "Что нового по-русски" "What's new in English"
set -e -o pipefail
cd "$(dirname "$0")/.."
NOTES_RU="${1:?release notes (ru)}"
NOTES_EN="${2:-$NOTES_RU}"
REPO=zai-one/chawo-va
VERSION=$(sed -n 's|.*<Version>\(.*\)</Version>.*|\1|p' src/ChawoVoiceAssistant.csproj)
[[ -n "$VERSION" ]] || { echo "no <Version> in csproj"; exit 1; }
git diff --quiet || { echo "commit your changes first"; exit 1; }

./build.sh
source build.local
mkdir -p dist
scp -q -i "$BUILD_KEY" "$BUILD_HOST:${BUILD_DIR//\\//}/dist/ChawoVoiceAssistant-Setup.exe" dist/ChawoVoiceAssistant-Setup.exe
SHA=$(shasum -a 256 dist/ChawoVoiceAssistant-Setup.exe | cut -d' ' -f1)
SIZE=$(stat -f %z dist/ChawoVoiceAssistant-Setup.exe)
URL="https://github.com/$REPO/releases/download/v$VERSION/ChawoVoiceAssistant-Setup.exe"

git tag "v$VERSION"
git push -q origin main "v$VERSION"
gh release create "v$VERSION" dist/ChawoVoiceAssistant-Setup.exe -R "$REPO" --title "Chawo Voice Assistant для Windows $VERSION" --notes "$NOTES_RU"
echo "released $VERSION: $URL ($SIZE bytes, sha256 $SHA)"
