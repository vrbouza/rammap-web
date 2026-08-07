// Logic class holding the wasm handle, following sparrowhawk's convention of pairing a
// thin *.worker.ts router with a class that does the work.
//
// Behaviour is a direct port of web/worker.js, which the headless browser suite
// verifies byte-identical to the native rammap CLI.
//
// The central invariant: alignment output never accumulates in JavaScript. Bytes come
// out of wasm as Uint8Array and go straight into an OutputSink; only a bounded preview
// is kept for display.

import type { OptsPayload } from "@/types";
// The generated classes have private constructors, so InstanceType<> rejects them;
// the declared class names are already the instance types.
import type { MapSession, RammapIndex } from "@/pkg_rammap";

type WasmModule = typeof import("@/pkg_rammap");

// Bytes fed to wasm per call, adapted at runtime. Cancellation is only observable
// between chunks, so chunk duration is cancel latency.
const MIN_CHUNK = 256 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;

// Blob parts smaller than this are coalesced; tens of thousands of tiny parts carry
// real per-part overhead in the browser's blob store.
const BLOB_PART_BYTES = 8 * 1024 * 1024;

const PREVIEW_BYTES = 2 * 1024 * 1024;
const PREVIEW_LINES = 5000;

/**
 * Hand control back to the macrotask queue.
 *
 * Load-bearing for cancellation. A `for await` over a blob-backed stream resolves its
 * reads through microtasks, and microtasks run to exhaustion before the next task — so
 * the loop starves the task queue and a cancel message is not delivered until the whole
 * file has already been processed.
 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Streaming output sink with two backends.
 *
 * A) File System Access API: the page obtains a handle from showSaveFilePicker() under
 *    user activation and posts it here. `await write()` gives real backpressure to
 *    disk, so output size is bounded by the filesystem rather than RAM.
 * B) Blob parts: coalesced and assembled at the end. Unlike string concatenation this
 *    is not bounded by the JS string cap, because blob parts spill to disk.
 *
 * A is Chromium-desktop-only as of 2026, so B is mandatory, not decorative.
 */
class OutputSink {
    mode!: "file" | "blob";
    bytes = 0;
    private writable?: FileSystemWritableFileStream;
    private parts: Blob[] = [];
    private pending: Uint8Array[] = [];
    private pendingBytes = 0;

    static async create(handle?: FileSystemFileHandle): Promise<OutputSink> {
        const sink = new OutputSink();
        if (handle) {
            sink.writable = await handle.createWritable();
            sink.mode = "file";
        } else {
            sink.mode = "blob";
        }
        return sink;
    }

    async write(bytes: Uint8Array): Promise<void> {
        this.bytes += bytes.length;
        if (this.mode === "file") {
            await this.writable!.write(bytes);
            return;
        }
        this.pending.push(bytes);
        this.pendingBytes += bytes.length;
        if (this.pendingBytes >= BLOB_PART_BYTES) {
            this.parts.push(new Blob(this.pending as BlobPart[]));
            this.pending = [];
            this.pendingBytes = 0;
        }
    }

    async close(): Promise<Blob | null> {
        if (this.mode === "file") {
            await this.writable!.close();
            return null;
        }
        if (this.pending.length) this.parts.push(new Blob(this.pending as BlobPart[]));
        return new Blob(this.parts, { type: "text/plain" });
    }
}

/** Keeps at most the first PREVIEW_BYTES / PREVIEW_LINES for display. */
class Preview {
    private parts: Uint8Array[] = [];
    private bytes = 0;
    private lines = 0;
    truncated = false;

    push(bytes: Uint8Array): void {
        if (this.truncated) return;
        if (this.bytes >= PREVIEW_BYTES || this.lines >= PREVIEW_LINES) {
            this.truncated = true;
            return;
        }
        const slice = bytes.subarray(0, PREVIEW_BYTES - this.bytes);
        if (slice.length < bytes.length) this.truncated = true;
        this.parts.push(slice);
        this.bytes += slice.length;
        for (const b of slice) if (b === 10) this.lines++;
    }

    text(): string {
        const joined = new Uint8Array(this.bytes);
        let off = 0;
        for (const p of this.parts) {
            joined.set(p, off);
            off += p.length;
        }
        let out = new TextDecoder().decode(joined);
        if (this.truncated) {
            // Drop a trailing partial line so the table never shows half a record.
            const cut = out.lastIndexOf("\n");
            if (cut > 0) out = out.slice(0, cut + 1);
        }
        return out;
    }
}

export class RammapAligner {
    private worker: Worker;
    private wasm: WasmModule | null = null;
    private wasmExports: { memory?: WebAssembly.Memory } | null = null;
    private index: RammapIndex | null = null;
    private indexSource: string | null = null;
    private session: MapSession | null = null;
    private cancelled = false;
    private chunkBytes = 2 * 1024 * 1024;

    constructor(worker: Worker) {
        this.worker = worker;
    }

    private post(msg: Record<string, unknown>): void {
        this.worker.postMessage(msg);
    }

    private log(text: string): void {
        this.post({ log: text });
    }

    async initWasm(): Promise<void> {
        // wasm-pack's default `bundler` target: webpack instantiates the module on
        // this dynamic import, so there is no init() to call.
        const wasm = await import("@/pkg_rammap");
        this.wasm = wasm;
        // Until this is called every progress post in the bridge is a no-op, which is
        // what keeps `wasm-pack test --node` and any main-thread import safe.
        wasm.enableProgress(true);
        this.post({ ready: true, version: wasm.rammapVersion(), presets: wasm.rammapPresets() });
    }

    private need(): WasmModule {
        if (!this.wasm) throw new Error("the wasm module is not loaded yet");
        return this.wasm;
    }

    cancel(): void {
        this.cancelled = true;
        this.session?.cancel();
    }

    resetAll(): void {
        this.index = null;
        this.indexSource = null;
        this.session = null;
        this.cancelled = false;
    }

    private tuneChunk(elapsedMs: number): void {
        if (elapsedMs > 250 && this.chunkBytes > MIN_CHUNK) this.chunkBytes >>= 1;
        else if (elapsedMs < 50 && this.chunkBytes < MAX_CHUNK) this.chunkBytes <<= 1;
    }

    private async *streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
        const reader = stream.getReader();
        let held: Uint8Array[] = [];
        let heldBytes = 0;
        const merge = (): Uint8Array => {
            const merged = new Uint8Array(heldBytes);
            let off = 0;
            for (const p of held) {
                merged.set(p, off);
                off += p.length;
            }
            held = [];
            heldBytes = 0;
            return merged;
        };
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                held.push(value);
                heldBytes += value.length;
                if (heldBytes >= this.chunkBytes) yield merge();
            }
            if (heldBytes > 0) yield merge();
        } finally {
            reader.releaseLock();
        }
    }

    private async openStream(file: File): Promise<{ stream: ReadableStream<Uint8Array>; gz: boolean }> {
        const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
        const gz = head[0] === 0x1f && head[1] === 0x8b;
        return {
            stream: gz
                ? (file.stream() as ReadableStream<Uint8Array>).pipeThrough(new DecompressionStream("gzip"))
                : (file.stream() as ReadableStream<Uint8Array>),
            gz,
        };
    }

    private buildOptions(payload: OptsPayload) {
        const wasm = this.need();
        const opts = new wasm.RammapOptions(payload.preset);
        opts.outputSam = !!payload.outputSam;
        opts.cigar = payload.cigar !== false;
        if (payload.cs) opts.cs = true;
        if (payload.md) opts.md = true;
        if (payload.eqx) opts.eqx = true;
        if (payload.copyComment) opts.copyComment = true;
        // 0 = uncapped, matching the CLI. rammap's own demo hardcodes 50_000, which
        // silently changes output on repetitive references.
        opts.indexMaxOcc = Number(payload.indexMaxOcc ?? 0);
        if (payload.k) opts.k = Number(payload.k);
        if (payload.w) opts.w = Number(payload.w);
        return opts;
    }

    private announceIndex(): void {
        this.post({
            indexReady: {
                info: this.index!.info(),
                refNames: this.index!.refNames(),
                source: this.indexSource,
            },
        });
    }

    async loadIndex(file: File): Promise<void> {
        const wasm = this.need();
        this.index = wasm.RammapIndex.fromBytes(new Uint8Array(await file.arrayBuffer()));
        this.indexSource = `loaded from ${file.name}`;
        this.log(`Index loaded from ${file.name}`);
        this.announceIndex();
    }

    async buildIndex(file: File, optsPayload: OptsPayload): Promise<void> {
        const wasm = this.need();

        // A prebuilt index dropped into the reference slot is detected by magic bytes
        // rather than extension, the same reasoning as Index::sniff_is_index_file: an
        // index saved under an unexpected name would otherwise be silently rebuilt
        // from its own binary content, producing a bogus index with no error.
        const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
        const magic = wasm.RammapIndex.rmmiMagic();
        if (magic.every((b: number, i: number) => head[i] === b)) {
            await this.loadIndex(file);
            return;
        }

        const opts = this.buildOptions(optsPayload);
        const build = new wasm.IndexBuildSession(opts);
        const { stream, gz } = await this.openStream(file);
        // Upper bound for the packed buffer: file size for plain FASTA, ~4x for gzip.
        // Skipping this costs a doubling realloc that transiently needs 3x the buffer.
        build.reserveBases(gz ? file.size * 4 : file.size);

        this.log(`Reading reference${gz ? " (gzip)" : ""}: ${file.name}`);
        const t0 = performance.now();
        for await (const chunk of this.streamChunks(stream)) {
            if (this.cancelled) {
                build.cancel();
                throw new Error("cancelled");
            }
            build.pushChunk(chunk);
            await yieldToEventLoop();
        }
        this.log("Sorting minimizers and building the index");
        this.index = build.finish();
        this.indexSource = `built from ${file.name}`;
        const info = this.index.info();
        this.log(
            `Index ready: k=${info.k} w=${info.w}, ${info.nSeqs} sequence(s), ` +
            `${info.totalBases.toLocaleString()} bases in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
        );
        this.announceIndex();
    }

    async saveIndex(handle: FileSystemFileHandle | undefined, name: string): Promise<void> {
        if (!this.index) throw new Error("no index loaded");

        // serializeStreaming emits blocks through the module's imported postMessage,
        // which is this worker's own channel to the page. Swapping the global out for
        // the duration keeps the bytes here: each block becomes a Blob immediately, so
        // it lands in the browser's blob store (which spills to disk) rather than the
        // JS heap. Peak cost is one block, versus ~2x the index for serializeToBuffer.
        //
        // The glue emits a bare `postMessage(arg)` resolved at call time, so replacing
        // the global property is enough; nothing is captured at module init.
        const ctx = self as unknown as { postMessage: (msg: unknown) => void };
        const real = ctx.postMessage.bind(ctx);
        const parts: Blob[] = [];
        ctx.postMessage = (msg: unknown) => {
            const m = msg as { rammapIndexBlock?: boolean; bytes?: Uint8Array };
            if (m && m.rammapIndexBlock) {
                parts.push(new Blob([m.bytes as BlobPart]));
                return;
            }
            real(msg);
        };

        let total: number;
        try {
            total = this.index.serializeStreaming();
        } finally {
            ctx.postMessage = real;
        }

        const blob = new Blob(parts, { type: "application/octet-stream" });
        if (handle) {
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            this.post({ indexSaved: { bytes: total, savedToFile: true, name } });
        } else {
            this.post({ indexSaved: { bytes: total, savedToFile: false, name, blob } });
        }
        this.log(`Index written: ${(total / 1048576).toFixed(1)} MB`);
    }

    async map(payload: {
        queryFile: File;
        opts: OptsPayload;
        dpCacheMb?: number;
        fileHandle?: FileSystemFileHandle;
    }): Promise<void> {
        const wasm = this.need();
        if (!this.index) throw new Error("no index loaded");
        const opts = this.buildOptions(payload.opts);
        if (payload.dpCacheMb != null) wasm.setDpCacheMb(Number(payload.dpCacheMb));

        this.session = new wasm.MapSession(this.index, opts);
        const sink = await OutputSink.create(payload.fileHandle);
        const preview = new Preview();

        // The SAM header, which rammap's own wasm build never emits. Idempotent, so
        // calling it in PAF mode is harmless.
        const header = this.session.header();
        if (header.length) {
            await sink.write(header);
            preview.push(header);
        }

        const queryFile = payload.queryFile;
        const { stream, gz } = await this.openStream(queryFile);
        this.log(`Mapping reads${gz ? " (gzip)" : ""}: ${queryFile.name}`);
        const t0 = performance.now();
        let bytesIn = 0;

        for await (const chunk of this.streamChunks(stream)) {
            if (this.cancelled) {
                this.session.cancel();
                break;
            }
            const started = performance.now();
            const out = this.session.pushChunk(chunk);
            this.tuneChunk(performance.now() - started);
            if (out.length) {
                await sink.write(out);
                preview.push(out);
            }
            bytesIn += chunk.length;
            this.post({ progress: { phase: "reads", completed: bytesIn, total: gz ? 0 : queryFile.size } });
            await yieldToEventLoop();
        }
        if (!this.cancelled) {
            const tail = this.session.finish();
            if (tail.length) {
                await sink.write(tail);
                preview.push(tail);
            }
        }

        const stats = this.session.stats();
        const blob = await sink.close();

        this.post({
            done: {
                stats: { reads: stats.reads, mapped: stats.mapped, bases: stats.bases },
                outputBytes: sink.bytes,
                seconds: (performance.now() - t0) / 1000,
                savedToFile: blob === null,
                cancelled: this.cancelled,
                preview: preview.text(),
                truncated: preview.truncated,
                blob,
            },
        });
        this.session = null;
        this.cancelled = false;
    }

    reportError(err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "cancelled") {
            this.post({ cancelledBeforeStart: true });
            return;
        }
        const heap = this.wasmExports?.memory?.buffer.byteLength ?? 0;
        // wasm32 caps linear memory at 4 GB. A trap plus a nearly-full heap is almost
        // always the index outgrowing it, and saying so beats "unreachable executed".
        if (/unreachable|RuntimeError/i.test(message) && heap > 3.5 * 1024 ** 3) {
            this.post({
                error:
                    `Out of memory: the wasm heap hit its 4 GB cap (${(heap / 1024 ** 3).toFixed(1)} GB used). ` +
                    `This reference is too large for a 32-bit browser build — use the native rammap CLI.`,
                fatal: true,
            });
            return;
        }
        // A Rust panic poisons the module; the worker must be replaced, not retried.
        this.post({ error: message, fatal: /unreachable|RuntimeError/i.test(message) });
    }
}
