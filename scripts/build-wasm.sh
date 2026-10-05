#!/bin/bash
set -euo pipefail

# Builds ghostty-vt.wasm from the pinned Ghostty submodule using upstream's
# own libghostty-vt wasm target (no patches).

echo "🔨 Building ghostty-vt.wasm..."

# Initialize/update submodule
if [ ! -e "ghostty/.git" ]; then
    echo "📦 Initializing Ghostty submodule..."
    git submodule update --init --depth 1 ghostty
else
    echo "📦 Ghostty submodule already initialized"
fi

REQUIRED_ZIG=$(sed -n 's/.*minimum_zig_version = "\([^"]*\)".*/\1/p' ghostty/build.zig.zon)

# Check for Zig
if ! command -v zig &> /dev/null; then
    echo "❌ Error: Zig not found"
    echo ""
    echo "Install Zig ${REQUIRED_ZIG}+:"
    echo "  macOS:   brew install zig  (or: mise use zig@${REQUIRED_ZIG})"
    echo "  Linux:   https://ziglang.org/download/"
    echo ""
    exit 1
fi

ZIG_VERSION=$(zig version)
echo "✓ Found Zig $ZIG_VERSION (Ghostty requires $REQUIRED_ZIG+)"

BUILD_ARGS=(-Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall)

# Zig's package fetcher does not work behind every HTTPS proxy. When it fails,
# download the reported dependency archives with curl, add them to the Zig
# cache with `zig fetch` (which verifies them against build.zig.zon hashes),
# and retry. Each round only resolves the dependencies Zig asked for.
build_with_prefetch() {
    local previous="" urls log
    log=$(mktemp)
    trap 'rm -f "$log"' RETURN
    for _ in $(seq 1 10); do
        if zig build "${BUILD_ARGS[@]}" 2>"$log"; then
            return 0
        fi
        urls=$(grep -oE '\.url = "[^"]+"' "$log" | sed -E 's/.*"([^"]+)"/\1/' | sort -u || true)
        if [ -z "$urls" ] || [ "$urls" = "$previous" ]; then
            cat "$log" >&2
            return 1
        fi
        previous=$urls
        echo "⚠️  Zig could not fetch dependencies; prefetching with curl..."
        while IFS= read -r url; do
            local archive
            case "$url" in
                *.tar.xz) archive=$(mktemp).tar.xz ;;
                *.zip) archive=$(mktemp).zip ;;
                *) archive=$(mktemp).tar.gz ;;
            esac
            curl -fsSL --retry 3 -o "$archive" "$url"
            echo "   $(zig fetch "$archive") <- $url"
            rm -f "$archive"
        done <<< "$urls"
    done
    cat "$log" >&2
    return 1
}

echo "⚙️  Building WASM..."
(cd ghostty && build_with_prefetch)

cp ghostty/zig-out/bin/ghostty-vt.wasm ./

# Optional: shrink with Binaryen when available (upstream release flags).
if command -v wasm-opt &> /dev/null; then
    echo "🗜  Optimizing with wasm-opt..."
    wasm-opt -O3 --strip-dwarf --enable-simd --enable-bulk-memory --enable-sign-ext \
        --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types \
        ghostty-vt.wasm -o ghostty-vt.wasm
fi

SIZE=$(du -h ghostty-vt.wasm | cut -f1)
echo "✅ Built ghostty-vt.wasm ($SIZE) from Ghostty $(git -C ghostty rev-parse --short HEAD)"
