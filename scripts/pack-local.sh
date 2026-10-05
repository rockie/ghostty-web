#!/bin/bash
set -euo pipefail

# Builds the library and packs it into .pack/ for installing into a local
# consumer without publishing:
#   npm install /path/to/ghostty-web/.pack/<file>.tgz
# The file name carries the commit (and -dirty for uncommitted changes) so the
# consumer's package.json shows exactly which build it uses.

cd "$(dirname "$0")/.."

bun run build

VERSION=$(node -p "require('./package.json').version")
REV=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    REV="${REV}-dirty"
fi

mkdir -p .pack
FILE=$(npm pack --ignore-scripts --silent --pack-destination .pack)
OUT=".pack/xgent-ai-ghostty-web-${VERSION}-${REV}.tgz"
mv -f ".pack/${FILE}" "$OUT"
echo "📦 $(pwd)/${OUT}"
