#!/bin/sh
# Cross-check the wasm bridge against the native rammap CLI.
#
#   RAMMAP=/path/to/rammap sh scripts/compare-native.sh
#
# Byte-identical output is the acceptance criterion. Sources of legitimate divergence,
# all controlled for here:
#
#   - @PG CL: differs by construction (there is no argv in a browser), so it is excluded.
#   - Threads: the CLI is pinned to -t 1, since multithreaded output ordering can differ.
#   - index_max_occ: the harness sets it to 0 (uncapped) to match the CLI default.
#     rammap's own web demo hardcodes 50_000, which is the usual cause of divergence
#     on repetitive references.
#   - Comments: gated behind --copy-comment on both sides (minimap2's -y).
#
# A remaining diff means the wasm v128 kernels disagree with the native SIMD backend,
# which would be a genuine upstream bug in chain_simd.rs or dp/*.

set -eu

RAMMAP="${RAMMAP:-rammap}"
# This script lives in rust/rammap-bridge/scripts/, so one level up is the crate.
CRATE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

REF="$CRATE/tests/data/ref.fa"
FQ="$CRATE/tests/data/reads.fq"
FA="$CRATE/tests/data/reads.fa"

pass=0
fail=0

check() {
    desc=$1
    native_args=$2
    wasm_args=$3
    query=$4

    # shellcheck disable=SC2086
    "$RAMMAP" $native_args "$REF" "$query" >"$TMP/native" 2>/dev/null
    # shellcheck disable=SC2086
    node "$CRATE/scripts/map.mjs" "$REF" "$query" $wasm_args >"$TMP/wasm" 2>/dev/null

    grep -v '^@PG' "$TMP/native" >"$TMP/native.cmp" || true
    grep -v '^@PG' "$TMP/wasm" >"$TMP/wasm.cmp" || true

    if cmp -s "$TMP/native.cmp" "$TMP/wasm.cmp"; then
        printf '  PASS  %-22s (%s lines)\n' "$desc" "$(wc -l <"$TMP/wasm.cmp" | tr -d ' ')"
        pass=$((pass + 1))
    else
        printf '  FAIL  %-22s\n' "$desc"
        diff "$TMP/native.cmp" "$TMP/wasm.cmp" | head -4
        fail=$((fail + 1))
    fi
}

echo "native rammap: $("$RAMMAP" --version 2>&1 | head -1)"
echo "cross-checking wasm bridge against native CLI:"

check "PAF"              "-x map-ont -t 1 -c"        ""                    "$FQ"
check "FASTA reads"      "-x map-ont -t 1 -c"        ""                    "$FA"
check "SAM + header"     "-x map-ont -t 1 -a"        "--sam"               "$FQ"
check "cs tag"           "-x map-ont -t 1 -c --cs"   "--cs"                "$FQ"
check "MD tag"           "-x map-ont -t 1 -a --MD"   "--sam --md"          "$FQ"
check "eqx CIGAR"        "-x map-ont -t 1 -a --eqx"  "--sam --eqx"         "$FQ"
check "copy-comment"     "-x map-ont -t 1 -c -y"     "--copy-comment"      "$FQ"
check "preset sr"        "-x sr -t 1 -c"             "--preset sr"         "$FQ"
check "preset asm20"     "-x asm20 -t 1 -c"          "--preset asm20"      "$FQ"
check "preset splice"    "-x splice -t 1 -c"         "--preset splice"     "$FQ"
check "preset map-hifi"  "-x map-hifi -t 1 -c"       "--preset map-hifi"   "$FQ"
check "preset map-pb"    "-x map-pb -t 1 -c"         "--preset map-pb"     "$FQ"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
