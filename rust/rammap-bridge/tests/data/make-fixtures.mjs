// Deterministic test fixtures: a synthetic reference plus reads sampled from it with
// a fixed mutation model.
//
// Synthetic rather than downloaded phiX/lambda so the fixtures are hermetic and the
// repository stays small. What we are testing is byte-identity between the wasm and
// native code paths, and for that the reference only has to be realistic enough to
// produce chains, alignments, and a few unmapped reads.
//
//   node test-data/make-fixtures.mjs
//
// Regenerating with the same seed reproduces the files byte for byte.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));

// xorshift32: tiny, deterministic, and identical across Node versions, unlike
// Math.random() which cannot be seeded.
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 0x100000000;
    };
}

const BASES = "ACGT";

function randomSequence(rand, length) {
    const out = new Array(length);
    for (let i = 0; i < length; i++) out[i] = BASES[(rand() * 4) | 0];
    return out.join("");
}

function wrap(seq, width = 60) {
    const lines = [];
    for (let i = 0; i < seq.length; i += width) lines.push(seq.slice(i, i + width));
    return lines.join("\n");
}

function revComp(seq) {
    const comp = { A: "T", C: "G", G: "C", T: "A", N: "N" };
    return seq.split("").reverse().map((c) => comp[c] ?? "N").join("");
}

/** Substitutions, insertions, and deletions at roughly ONT-like rates. */
function mutate(rand, seq, rate) {
    const out = [];
    for (const base of seq) {
        const r = rand();
        if (r < rate * 0.6) {
            out.push(BASES[(rand() * 4) | 0]); // substitution
        } else if (r < rate * 0.8) {
            // deletion: emit nothing
        } else if (r < rate) {
            out.push(base, BASES[(rand() * 4) | 0]); // insertion
        } else {
            out.push(base);
        }
    }
    return out.join("");
}

// `--scale` generates an E. coli-sized reference and enough reads to produce ~85 MB of
// SAM — the shape of run rammap's own demo cannot survive, because it accumulates
// output into one JS string.
const SCALE = process.argv.includes("--scale");
const SUFFIX = SCALE ? "-big" : "";

const rand = rng(20260806);

// Two contigs, so the SAM @SQ block has more than one line and RNAME resolution is
// actually exercised.
const contigs = SCALE
    ? [
        { name: "ctg1", seq: randomSequence(rand, 3_500_000) },
        { name: "ctg2", seq: randomSequence(rand, 1_100_000) },
    ]
    : [
        { name: "ctg1", seq: randomSequence(rand, 60000) },
        { name: "ctg2", seq: randomSequence(rand, 25000) },
    ];

const fasta = contigs.map((c) => `>${c.name} synthetic\n${wrap(c.seq)}`).join("\n") + "\n";
writeFileSync(join(OUT, `ref${SUFFIX}.fa`), fasta);

const reads = [];
// Scale is chosen to produce output far beyond what string concatenation copes with,
// while keeping the fixtures small enough to fetch into a browser Blob in the test
// harness. The real app never has this constraint: it receives a disk-backed File from
// a picker or drag-and-drop, which costs nothing to hand to the worker.
const N_READS = SCALE ? 20000 : 500;
for (let i = 0; i < N_READS; i++) {
    const contig = contigs[rand() < 0.75 ? 0 : 1];
    const length = 500 + ((rand() * 3000) | 0);
    const start = (rand() * Math.max(1, contig.seq.length - length)) | 0;
    let seq = contig.seq.slice(start, start + length);
    if (rand() < 0.5) seq = revComp(seq);
    seq = mutate(rand, seq, 0.08);
    // Fixed quality: rammap does not use QUAL for mapping, but it must survive the
    // parser and reach the SAM QUAL column intact.
    const qual = "I".repeat(seq.length);
    reads.push(`@read${i} len=${seq.length}\n${seq}\n+\n${qual}`);
}
// A read of random sequence, which should not map: exercises the no-hits path.
const junk = randomSequence(rand, 800);
reads.push(`@unmappable\n${junk}\n+\n${"I".repeat(junk.length)}`);

writeFileSync(join(OUT, `reads${SUFFIX}.fq`), reads.join("\n") + "\n");

// The same reads as FASTA, to cover the other parser branch. Skipped at scale: the
// FASTA branch is already covered by the small fixture, and a second copy of a large
// read set is just disk.
if (!SCALE) writeFileSync(
    join(OUT, `reads${SUFFIX}.fa`),
    reads.map((r) => {
        const [header, seq] = r.split("\n");
        return `>${header.slice(1)}\n${wrap(seq)}`;
    }).join("\n") + "\n",
);

console.log(
    `wrote ref${SUFFIX}.fa (${contigs.length} contigs, ` +
    `${contigs.reduce((n, c) => n + c.seq.length, 0).toLocaleString()} bases) and ` +
    `reads${SUFFIX}.fq${SCALE ? "" : " / reads.fa"} (${reads.length.toLocaleString()} reads)`,
);
