#!/usr/bin/env bash
# Builds the `whisper-server` the desktop app ships (decision 0019 item 10, issue #405): whisper.cpp
# at the tag and commit pinned in packages/nucleo/src/transcription/whisper-cpp.json (the same file
# `voice install` reads), for macOS arm64, with Metal on (the shader library embedded in the binary,
# so nothing is loaded from disk) and every library linked statically. No CUDA.
#
# Output: apps/desktop/src-tauri/resources/whisper/whisper-server (git-ignored build output; the
# tauri bundle takes it as a resource, see bundle.resources in tauri.conf.json).
# Needs: git, cmake, node, Xcode command line tools. Run it from anywhere.
#
# Optional environment: AHRENA_CONSOLE_WHISPER_WORK_DIR (where the clone and the build live;
# default apps/desktop/.whisper-build).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop="$(cd "$here/.." && pwd)"
pin="$desktop/../../packages/nucleo/src/transcription/whisper-cpp.json"
out="$desktop/src-tauri/resources/whisper"
work="${AHRENA_CONSOLE_WHISPER_WORK_DIR:-$desktop/.whisper-build}"

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "build-whisper-server: this builds the macOS arm64 binary; run it on an Apple Silicon Mac." >&2
  exit 1
fi

pinned() { node -p "require('$pin').$1"; }
tag="$(pinned tag)"
commit="$(pinned commit)"
repo="$(pinned repo)"

src="$work/src"
mkdir -p "$work" "$out"
if [ ! -d "$src/.git" ]; then
  git clone --depth 1 --branch "$tag" "$repo" "$src"
fi
head="$(git -C "$src" rev-parse HEAD)"
if [ "$head" != "$commit" ]; then
  echo "build-whisper-server: whisper.cpp $tag is at $head, not the pinned $commit. Delete $src and run again." >&2
  exit 1
fi

cmake -S "$src" -B "$src/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_CUDA=OFF \
  -DBUILD_SHARED_LIBS=OFF
cmake --build "$src/build" --config Release -j --target whisper-server

install -m 0755 "$src/build/bin/whisper-server" "$out/whisper-server"
# Ad hoc and under the hardened runtime, like the app (Metal compiles the embedded shaders at run
# time, which needs no entitlement). The bundler copies the file as it is.
codesign --force --options runtime --sign - "$out/whisper-server"
echo "whisper-server $tag ($commit) at $out/whisper-server"
