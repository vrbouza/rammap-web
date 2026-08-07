#!/bin/sh
# Build both wasm packages.
#
#   sh scripts/build.sh
#
# Two targets are needed because they are consumed differently:
#
#   pkg/      --target nodejs, CommonJS, used by scripts/map.mjs and the comparison
#             harness. No init() call; require() instantiates it.
#   pkg-web/  --target web, ESM with a default init() export, loaded by web/worker.js.
#
# (Phase 3 will add a third consumer, webpack, which uses wasm-pack's default
# `bundler` target and needs no init() at all — that one is driven by the
# WasmPackPlugin inside vue.config.js rather than from here.)

set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

echo "[*] building pkg/ (nodejs target)"
wasm-pack build --target nodejs --release

echo "[*] building pkg-web/ (web target)"
wasm-pack build --target web --release --out-dir pkg-web

echo "[*] done:"
ls -l pkg/*.wasm pkg-web/*.wasm | awk '{printf "    %s  %.2f MB\n", $NF, $5/1048576}'
