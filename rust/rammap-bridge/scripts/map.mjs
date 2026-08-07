// Drive the rammap-bridge wasm module from Node, mirroring what the Web Worker will
// do: stream the reference in to build an index, then stream reads through a mapping
// session and write PAF/SAM to stdout.
//
//   node scripts/map.mjs <ref.fa> <reads.fq> [--preset map-ont] [--sam] [--cs] [--md]
//
// With --save-index / --load-index the reference argument is an .rmi index rather
// than a FASTA.
//
// Build the module first:
//   cd rust/rammap-bridge && wasm-pack build --target nodejs --release

import { createRequire } from "node:module";
import { openSync, readSync, closeSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
/** The crate directory: this script lives in rust/rammap-bridge/scripts/. */
const CRATE = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasm = require(join(CRATE, "pkg/rammap_bridge.js"));

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const [refPath, queryPath] = positional;
if (!refPath || !queryPath) {
    console.error("usage: node scripts/map.mjs <ref.fa> <reads.fq> [--preset X] [--sam] [--cs] [--md]");
    process.exit(2);
}

// Same chunk size the browser worker uses, so the parser sees the same boundaries.
const CHUNK_BYTES = 4 * 1024 * 1024;

function* chunks(path) {
    const fd = openSync(path, "r");
    try {
        const buf = Buffer.allocUnsafe(CHUNK_BYTES);
        for (;;) {
            const n = readSync(fd, buf, 0, CHUNK_BYTES, null);
            if (n <= 0) return;
            // Copy: the wasm call borrows the bytes, and we reuse `buf` next round.
            yield new Uint8Array(buf.subarray(0, n));
        }
    } finally {
        closeSync(fd);
    }
}

const opts = new wasm.RammapOptions(value("preset", "map-ont"));
opts.outputSam = flag("sam");
opts.cigar = true;
if (flag("cs")) opts.cs = true;
if (flag("md")) opts.md = true;
if (flag("eqx")) opts.eqx = true;
if (flag("copy-comment")) opts.copyComment = true;
// 0 = uncapped, matching the CLI. rammap's own demo hardcodes 50_000, which is the
// usual cause of wasm/native output divergence on repetitive references.
opts.indexMaxOcc = 0;

const t0 = process.hrtime.bigint();
let index;
if (flag("load-index")) {
    // A prebuilt index skips the build entirely. This is the only route past the
    // wasm32 memory ceiling for larger references, since building needs far more
    // headroom than loading.
    index = wasm.RammapIndex.fromBytes(new Uint8Array(readFileSync(refPath)));
} else {
    const build = new wasm.IndexBuildSession(opts);
    build.reserveBases(statSync(refPath).size);
    for (const chunk of chunks(refPath)) build.pushChunk(chunk);
    index = build.finish();
}
const tIndex = process.hrtime.bigint();

const saveTo = value("save-index", null);
if (saveTo) {
    // Buffered rather than streaming: serializeStreaming posts blocks through the
    // worker's postMessage, which does not exist on Node's main thread.
    const size = index.serializeToBuffer();
    writeFileSync(saveTo, Buffer.from(index.takeBytes()));
    process.stderr.write(`[*] wrote ${saveTo} (${size} bytes)\n`);
}

const info = index.info();
process.stderr.write(
    `[*] index: k=${info.k} w=${info.w} hpc=${info.hpc} ` +
    `${info.nSeqs} seq(s), ${info.totalBases} bases in ` +
    `${Number(tIndex - t0) / 1e9}s\n`,
);

const session = new wasm.MapSession(index, opts);

// The SAM header, which rammap's own wasm build never emits. Idempotent, so calling it
// in PAF mode is harmless (returns empty).
const header = session.header();
if (header.length) process.stdout.write(Buffer.from(header));

for (const chunk of chunks(queryPath)) {
    const out = session.pushChunk(chunk);
    if (out.length) process.stdout.write(Buffer.from(out));
}
const tail = session.finish();
if (tail.length) process.stdout.write(Buffer.from(tail));

const stats = session.stats();
process.stderr.write(
    `[*] mapped ${stats.mapped}/${stats.reads} reads (${stats.bases} bases) in ` +
    `${Number(process.hrtime.bigint() - tIndex) / 1e9}s\n`,
);
