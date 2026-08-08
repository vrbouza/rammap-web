# rammap-web

A WebAssembly adaptation of [rammap](https://github.com/jwanglab/rammap), a pure-Rust
minimap2-compatible mapper and aligner, following the pattern
[sparrowhawk](https://github.com/bacpop/sparrowhawk) uses for its Rust bridges.

This project is a quick example on how to use the [sparrowhawk](https://github.com/bacpop/sparrowhawk) project as example and guide for developing or (as in this case) adapting a scientific methodology that can work with WebAssemblym with the help of LLMs for the initial set up. Thus, the code here is mostly vibe-coded using Claude Code.

rammap already compiled to wasm before this project existed — `rammap-core` ships an
`AlignSession` and a demo page. What it could not do was produce output you could
actually keep: no download, no SAM header, and no quality strings. This bridge closes
those gaps while keeping upstream rammap untouched.

Note: this is intented as an example, not as a proper adaptation to WebAssembly of rammap. 

## Status

**Complete: verified byte-identical to the native CLI, in a browser, with results
streamed to disk, index save/load, progress, and cancellation.**

| | rammap's own wasm demo | rammap-web |
|---|---|---|
| PAF matches native CLI | — | byte-identical |
| SAM header (`@HD`/`@SQ`/`@PG`) | absent | emitted, samtools accepts |
| SAM `QUAL` column | `*` | preserved from FASTQ |
| Presets exposed | 5 | all 16 |
| `index_max_occ` | hardcoded 50 000 | CLI default (uncapped), configurable |
| Save results to disk | — | streamed, no size ceiling |
| Load/save prebuilt index | — | `.rmi` round-trips; the native CLI reads it |
| Progress and cancellation | — | live progress; cancel between chunks |
| minimap2 `.mmi` input | traps (see below) | refused with a clear message |

`compare-native.sh` cross-checks twelve configurations — PAF, SAM, `cs`, `MD`,
`eqx`, comments, and six presets — and all are byte-identical to `rammap -t 1`.
`browser-test.mjs` then runs the same work in headless Chrome, driving the Vue app
through its own Vuex store — the same actions the page dispatches — and proves the
browser output matches the Node harness byte for byte. There is no separate self-test
page: the tests exercise what a user actually drives.

That result is worth stating on its own: **rammap's wasm SIMD128 kernels produce
exactly the same alignments as the native AVX2/AVX-512 backend**, across every preset
tested. rammap claims this in its docs; as far as we can tell it had not been checked
against the CLI end to end before.

## Layout

Laid out like [sparrowhawk-web](https://github.com/bacpop/sparrowhawk): the root holds
`rust/` and `www/` and nothing else but config.

```
rust/rammap-bridge/          the wasm bridge crate (all #[wasm_bindgen] lives here)
├── src/                     lib, index, session, opts, query, sam, progress, util
├── scripts/                 build.sh, map.mjs, compare-native.sh, serve.mjs,
│                            browser-test.mjs, dev-server-test.mjs
└── tests/data/              make-fixtures.mjs (fixtures are generated, not committed)
www/                         the Vue 3 app
```

Two deliberate differences from sparrowhawk-web, so they don't read as oversights.
There is **no `.gitmodules`**: sparrowhawk vendors its forked upstreams as submodules,
whereas we pin `rammap-core` by git rev in `Cargo.toml`, leaving upstream untouched and
nothing to keep in step. And there is **no deployment config** — nothing untested ships.

## Build and test

```sh
sh rust/rammap-bridge/scripts/build.sh                      # both wasm targets
node rust/rammap-bridge/tests/data/make-fixtures.mjs            # small fixtures
node rust/rammap-bridge/tests/data/make-fixtures.mjs --scale    # ~85 MB-of-output fixtures

cd rust/rammap-bridge && cargo test                         # parser property tests
cargo check --target wasm32-unknown-unknown                 # fast wasm loop

# Against the native CLI
RAMMAP=/path/to/rammap sh rust/rammap-bridge/scripts/compare-native.sh

# In a real browser, headless
npm --prefix www run build
node rust/rammap-bridge/scripts/browser-test.mjs      # production build
node rust/rammap-bridge/scripts/dev-server-test.mjs   # the `npm run serve` path
```

## Running it
You'll need the Rust toolchain and npm for this.

```sh
npm --prefix www install       # once
npm --prefix www run serve     # http://localhost:8080/
```

`npm run serve` also compiles the Rust to wasm on the way, through `WasmPackPlugin` in
`vue.config.js`, so the first start takes about half a minute and later ones are quick.
Nothing else needs building first. A static server is required either way: ES module
workers, the dynamic import of the wasm glue, and fetching the `.wasm` all fail under
`file://`.

Note that `publicPath` in `www/vue.config.js` differs between modes — relative for
production, so `dist/` works from any subdirectory, and absolute for development,
because Vue CLI uses the value verbatim as the dev server's URL pathname and a relative
one yields malformed asset URLs. Sparrowhawk draws the same line, using `./` only for
its Electron build. `dev-server-test.mjs` covers the development path so a change to one
mode cannot silently break the other.

## Saving results

The reason the demo can produce output of unbounded size is that alignment bytes never
accumulate in JavaScript. `MapSession::pushChunk` returns a `Uint8Array` rather than a
`String`, and the worker writes each one straight to a sink, keeping only a bounded
preview (2 MB or 5000 lines) for display. rammap's own demo does `lastOutput += chunk`
into a JS string, which is quadratic and dies at V8's ~512 MB cap.

Two sink backends:

- **File System Access API** — `showSaveFilePicker()` runs on the main thread under
  user activation, and the handle is passed into the worker. `await writable.write()`
  applies real backpressure to disk, so output is bounded by the filesystem. Chromium
  desktop only as of 2026.
- **Blob parts** — coalesced into ~8 MB parts and assembled at the end. Firefox and
  Safari always take this path. Unlike string concatenation it is not bounded by the
  string cap, because blob parts spill to disk.

Measured: 20 001 reads against a 4.6 Mb reference produced 84.3 MB of SAM in-browser,
byte-for-byte the same size as the Node harness. Through the Node path the same shape
of run at 60 000 reads produced 252.8 MB with peak RSS of 219 MB and the JS heap capped
at 512 MB — output more than the memory available, which is the whole point.

## Design notes

**The bridge drives rammap's internals, not `api::Aligner`.** Every `Aligner`
constructor either takes a path (there is no filesystem in a browser) or a fully
materialised `Vec<(String, Vec<u8>)>`, which would hold the reference as ASCII
alongside the packed index; `IndexBuilder` exists precisely to avoid that. And
`AlignerBuilder::from_loaded_index` is private, so an `Index` you build yourself cannot
be handed to an `Aligner` at all. Going through `IndexBuilder` and
`pipeline::align_and_format_query` sidesteps both, and is also the only route to SAM,
which `Aligner::format_paf` cannot emit.

**The bridge must never declare `#[wasm_bindgen(start)]`.** `rammap-core`'s own wasm
surface is gated on `target_arch` with no cargo feature to opt out, so its exports link
in alongside ours — verified: the generated module exports `AlignSession`,
`align_wasm_full` and friends next to ours. This is harmless and mildly useful, since
the glue calls `__wbindgen_start()` on import and rammap's panic hook (which prints
file:line:col plus the payload) installs itself for free. But wasm-bindgen permits only
one start function per module, so declaring a second fails the build.

**`.cargo/config.toml` is not optional.** Cargo never reads a dependency's config, so
rammap's own `+simd128` flag does not apply to our build. Without our copy, the v128
kernels compile out and the browser silently runs scalar fallbacks.

## Known upstream issues found along the way

- `Index::load_minimap2` calls unguarded `std::time::Instant::now()`
  (`align/index.rs:443`), while `map.rs` and `pipeline.rs` correctly use `web_time`.
  That will trap on `wasm32-unknown-unknown`, so loading a minimap2 `.mmi` in a browser
  panics. RMMI files take the bincode path and are unaffected. Guarded here in phase 4.
- `FastqStreamer::next_record()` discards quality strings and header comments, which is
  why the upstream demo emits `*` for QUAL. Worked around with a bridge-local parser.
- `wasm-threads` enables the rayon dependency but not the `parallel` feature, so every
  `par_iter` in `rammap-core` is compiled out of the "threaded" build.
- The CLI gates header comments behind `--copy-comment` (minimap2's `-y`); emitting
  them unconditionally adds a field to every PAF record. Matched here via `copyComment`.

## Limits

wasm32 caps linear memory at 4 GB. The minimizer table dominates at roughly 2.5-3 bytes
per reference base, so ~1 Gb of reference is already near the edge and a human genome
(~9-10 GB of index) is out of reach — including as a prebuilt index, since loading
peaks at twice the file size. Use the native CLI for genome-scale references.

## Index save and load

Building an index needs far more headroom than loading one, so a prebuilt `.rmi` is the
only practical route to larger references in a browser. `RammapIndex.serializeStreaming`
emits 8 MB blocks through the module's imported `postMessage`; the worker swaps that
global out for the duration and turns each block into a `Blob` immediately, so the bytes
land in the browser's blob store rather than the JS heap. Peak cost is one block, versus
roughly twice the index for a buffer-then-hand-over.

The format is rammap's own RMMI, so indices move in both directions: an index written by
the browser loads in the native CLI and produces identical alignments, which the test
suite checks.

minimap2 `.mmi` files are refused with an explanatory message rather than loaded, because
`Index::load_minimap2` traps on wasm (see the upstream issues above). Convert with
`rammap -d out.rmi ref.mmi`.

## Cancellation

Worth being precise, because the constraint is structural. One wasm instance lives in one
worker, its memory is a plain `ArrayBuffer` rather than shared, and every export is
synchronous — so the main thread cannot signal into a running call, and wasm has no
preemption. Three tiers ship:

1. **Between chunks.** The worker checks a flag before each `pushChunk`. Chunk size is
   adapted at runtime towards ~250 ms, which bounds cancel latency at roughly that on any
   input; rammap's fixed 16 MB chunks mean seconds on short reads.
2. **Within a chunk, for a cancel issued while the previous one ran.** A Rust `Cell<bool>`
   checked per record, so the chunk exits at its next record boundary.
3. **Force stop.** `worker.terminate()`, the only true mid-chunk abort. It destroys the
   wasm instance, so the index is lost and must be rebuilt; the UI offers it once a soft
   cancel has been pending for three seconds.

Two non-obvious things make tier 1 work at all. The worker serialises jobs through a
promise queue, because an `async` message handler does **not** delay delivery of the next
message — a page posting `{buildIndex}` then `{map}` back to back would otherwise start
both at once. And the chunk loop explicitly yields to the macrotask queue each iteration:
a `for await` over a blob-backed stream resolves its reads through microtasks, which run
to exhaustion before the next task, so without the yield a cancel is not delivered until
the whole file has already been processed.

Not achievable: preempting a single `align_and_format_query` call. One pathological long
read under the `splice` preset can hold the worker for seconds, and only `terminate()`
touches it.

## Licence

MIT, matching `rammap-core`. See `LICENSE`.
