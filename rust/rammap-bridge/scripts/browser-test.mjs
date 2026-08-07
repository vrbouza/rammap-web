// End-to-end browser test: drives the built Vue app in headless Chrome and checks its
// output against the Node harness, which is itself verified byte-identical to the
// native rammap CLI. If this passes, the browser path is correct all the way down.
//
//   node scripts/browser-test.mjs
//
// Every case goes through the real Vuex store — the same actions the page dispatches —
// so the tests exercise what a user actually drives rather than a parallel harness.
// That is why there is no separate self-test page.
//
// Chrome is driven over the DevTools Protocol using Node's built-in WebSocket client,
// so there is no puppeteer/playwright dependency to keep in step with the browser.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, four levels up from rust/rammap-bridge/scripts/<this file>. */
const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CRATE = resolve(fileURLToPath(import.meta.url), "../..");
const PORT = 8137;
const CDP_PORT = 9223;

// Fixtures, both on disk (for the Node harness) and as URLs (the static server is
// rooted at the repo, so the page reaches them by their path within it).
const FIXTURES = {
    dir: join(CRATE, "tests/data"),
    url: "/rust/rammap-bridge/tests/data",
};

function findChrome() {
    for (const c of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
        try {
            execFileSync(c, ["--version"], { stdio: "ignore" });
            return c;
        } catch { /* keep looking */ }
    }
    throw new Error("no Chrome or Chromium found on PATH");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const v = await fn();
            if (v) return v;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(200);
    }
}

/** Minimal CDP client: send a command, await its matching reply. */
class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        ws.addEventListener("message", (e) => {
            const msg = JSON.parse(e.data);
            const slot = this.pending.get(msg.id);
            if (!slot) return;
            this.pending.delete(msg.id);
            msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
        });
    }

    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Evaluate an expression and return its JSON value. */
    async eval(expression, timeoutMs) {
        const r = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
            ...(timeoutMs ? { timeout: timeoutMs } : {}),
        });
        if (r.exceptionDetails) {
            throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
        }
        return r.result.value;
    }
}

/**
 * Helpers installed in the page. Everything that touches a Blob stays here, so only
 * small summaries cross the CDP boundary — digesting an 85 MB result in Node would mean
 * shipping 85 MB through a debugging socket.
 */
const BOOTSTRAP = String.raw`
window.__t = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    async sha(blob) {
        const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    },

    async file(path, name) {
        const res = await fetch(path);
        if (!res.ok) throw new Error("fetch " + path + ": " + res.status);
        return new File([await res.blob()], name);
    },

    /** Round-trip through gzip, to exercise the DecompressionStream branch. */
    async gzip(file) {
        const s = file.stream().pipeThrough(new CompressionStream("gzip"));
        return new File([await new Response(s).blob()], file.name + ".gz");
    },

    opts(over) {
        return Object.assign({
            preset: "map-ont", outputSam: false, cigar: true, cs: false, md: false,
            eqx: false, copyComment: false, indexMaxOcc: 0, k: 0, w: 0,
        }, over || {});
    },

    /**
     * Dispatch a run and wait for it to land. onTick is called each poll with the live
     * state, which is how the cancellation case interrupts a run in flight.
     */
    async run(refFile, queryFile, opts, onTick, timeoutMs) {
        const store = window.__store;
        store.dispatch("newReference");     // drop any index cached in the worker
        store.dispatch("runRammap", { refFile, queryFile, opts, dpCacheMb: 128 });
        const deadline = Date.now() + (timeoutMs || 300000);
        for (;;) {
            const r = store.state.allResults_rammap;
            if (r.error) throw new Error(r.error);
            if (r.result) return r.result;   // runRammap clears this at the start
            if (onTick) onTick(r);
            if (Date.now() > deadline) throw new Error("run timed out");
            await this.sleep(100);
        }
    },

    /**
     * Save the loaded index and hand back the blob.
     *
     * The store dispatches handleIndexSaved with the payload rather than storing it, so
     * subscribing is how a caller reaches the bytes without the app holding onto them.
     */
    saveIndex(name) {
        const store = window.__store;
        return new Promise((resolve, reject) => {
            let timer;
            const unsub = store.subscribeAction((action) => {
                if (action.type !== "handleIndexSaved") return;
                clearTimeout(timer);
                unsub();
                resolve(action.payload);
            });
            timer = setTimeout(() => { unsub(); reject(new Error("saveIndex timed out")); }, 180000);
            store.dispatch("saveIndex", { name });
        });
    },
};

// Neutralise the page's "no picker, so download it automatically" path. Whether
// headless Chrome exposes showSaveFilePicker varies, and no case here should write a
// file to the download directory — least of all the 85 MB one. Runs still take the Blob
// sink, because dispatching runRammap directly never passes a file handle.
if (typeof window.showSaveFilePicker !== "function") {
    window.showSaveFilePicker = () => Promise.reject(new Error("suppressed in tests"));
}
"ok"
`;

/**
 * Chrome's profile directory, on tmpfs where available.
 *
 * Chrome sizes its blob quota from the filesystem backing the profile. On a root
 * filesystem reporting 100% full that quota drops far enough that fetching the ~77 MB
 * fixture into a Blob fails with a bare net::ERR_FAILED, while smaller fetches succeed
 * — which reads as a code bug and is not one. /dev/shm is memory-backed and unaffected.
 * Falls back to the system temp dir where /dev/shm does not exist.
 */
function makeProfile(prefix) {
    const base = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
    return mkdtempSync(join(base, prefix));
}

const profile = makeProfile("rammap-chrome-");
let server, chrome;

function shutdown() {
    chrome?.kill("SIGKILL");
    server?.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
}
process.on("exit", shutdown);

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
    if (!ok) failures++;
};

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
/** What the Node harness produces for the same inputs and options. */
const harness = (args) =>
    execFileSync(process.execPath, [join(CRATE, "scripts/map.mjs"), ...args], { maxBuffer: 1 << 30 });

try {
    if (!existsSync(join(ROOT, "www/dist/index.html"))) {
        throw new Error("www/dist is missing — run `npm --prefix www run build` first");
    }

    server = spawn(process.execPath, [join(CRATE, "scripts/serve.mjs"), String(PORT)], {
        stdio: "ignore",
    });
    await waitFor(
        async () => (await fetch(`http://localhost:${PORT}/www/dist/index.html`)).ok,
        "the dev server",
    );

    chrome = spawn(findChrome(), [
        "--headless=new",
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        // The sandbox needs user namespaces, which are not always available in
        // containers; the browser only ever loads localhost here.
        "--no-sandbox",
        "--disable-gpu",
        // Deliberately NOT --disable-dev-shm-usage. That flag redirects Chrome's blob
        // store to /tmp, which is right on containers with a tiny /dev/shm but wrong
        // whenever the root filesystem is fuller than /dev/shm — the scale case then
        // fails with an opaque net::ERR_FAILED on the large fetch.
        "about:blank",
    ], { stdio: "ignore" });

    const targets = await waitFor(
        async () => {
            const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
            return list.find((t) => t.type === "page") ? list : null;
        },
        "Chrome's debugging endpoint",
    );

    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", () => rej(new Error("CDP socket failed")), { once: true });
    });

    const cdp = new Cdp(ws);
    const pageErrors = [];
    ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
        if (msg.method === "Runtime.exceptionThrown") {
            pageErrors.push(msg.params.exceptionDetails.exception?.description ?? "exception");
        }
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    /**
     * Load the app fresh and install the helpers.
     *
     * Called before each section rather than once, so a section's memory pressure
     * cannot spill into the next. Sharing one page across all six cases made the large
     * fetches in the cancellation and scale sections fail with a bare "Failed to
     * fetch": the renderer had accumulated the earlier cases' blobs and wasm heap, and
     * wasm linear memory never shrinks.
     */
    async function openApp() {
        await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/www/dist/index.html` });
        const state = await waitFor(async () => {
            const s = await cdp.eval(`(() => {
                const sel = document.querySelector("select");
                const st = window.__store?.state;
                return {
                    presets: sel ? sel.options.length : 0,
                    ready: !!st?.ready,
                    status: st?.allResults_rammap.status ?? "",
                };
            })()`);
            return s.presets > 0 ? s : null;
        }, "the Vue app to boot", 60000);
        await cdp.eval(BOOTSTRAP);
        return state;
    }

    console.log("Vue app boots (production build):");
    const booted = await openApp();

    check("loads wasm and reports ready", booted.ready, booted.status);
    check("all 16 presets listed", booted.presets === 16, `${booted.presets} presets`);

    // --- correctness against the Node harness -------------------------------------
    console.log("\noutput matches the Node harness (itself byte-identical to the CLI):");

    const nodePaf = sha(harness([join(FIXTURES.dir, "ref.fa"), join(FIXTURES.dir, "reads.fq")]));
    const nodeSam = sha(harness([join(FIXTURES.dir, "ref.fa"), join(FIXTURES.dir, "reads.fq"), "--sam"]));

    const core = await cdp.eval(`(async () => {
        const t = window.__t;
        const ref = await t.file("${FIXTURES.url}/ref.fa", "ref.fa");
        const reads = await t.file("${FIXTURES.url}/reads.fq", "reads.fq");

        const paf = await t.run(ref, reads, t.opts());
        const sam = await t.run(ref, reads, t.opts({ outputSam: true }));
        const samText = await sam.blob.text();
        const gz = await t.run(await t.gzip(ref), await t.gzip(reads), t.opts());

        return {
            paf: {
                sha: await t.sha(paf.blob), reads: paf.stats.reads, mapped: paf.stats.mapped,
                bytes: paf.outputBytes,
                previewLines: paf.preview.split("\\n").filter(Boolean).length,
            },
            sam: {
                sha: await t.sha(sam.blob), bytes: sam.outputBytes,
                headerLines: samText.split("\\n").filter((l) => l.startsWith("@")).length,
                // The gap this project closed: rammap's own demo emits "*" here.
                firstQual: (samText.split("\\n").find((l) => l && !l.startsWith("@")) ?? "")
                    .split("\\t")[10]?.slice(0, 8),
            },
            gzSha: await t.sha(gz.blob),
        };
    })()`, 300000);

    check("PAF matches", core.paf.sha === nodePaf,
        core.paf.sha === nodePaf ? `${core.paf.bytes} bytes` : `${core.paf.sha.slice(0, 12)} vs ${nodePaf.slice(0, 12)}`);
    check("PAF read counts", core.paf.reads === 501 && core.paf.mapped === 500,
        `${core.paf.mapped}/${core.paf.reads} mapped`);
    check("SAM matches", core.sam.sha === nodeSam,
        core.sam.sha === nodeSam ? `${core.sam.bytes} bytes` : `${core.sam.sha.slice(0, 12)} vs ${nodeSam.slice(0, 12)}`);
    check("SAM header present", core.sam.headerLines === 4, `${core.sam.headerLines} header lines`);
    check("SAM QUAL preserved", core.sam.firstQual === "IIIIIIII", `QUAL="${core.sam.firstQual}"`);
    check("gzip input matches plain", core.gzSha === core.paf.sha);
    check("preview is bounded", core.paf.previewLines > 0 && core.paf.previewLines <= 5000,
        `${core.paf.previewLines} lines`);

    // --- index save and load ------------------------------------------------------
    console.log("\nindex save and load:");
    await openApp();
    const roundTrip = await cdp.eval(`(async () => {
        const t = window.__t;
        const ref = await t.file("${FIXTURES.url}/ref.fa", "ref.fa");
        const reads = await t.file("${FIXTURES.url}/reads.fq", "reads.fq");

        const direct = await t.run(ref, reads, t.opts());
        const saved = await t.saveIndex("ref.rmi");

        // Feeding the .rmi back in as the reference exercises the worker's magic-byte
        // sniffing, not the file extension.
        const viaIndex = await t.run(new File([saved.blob], "ref.rmi"), reads, t.opts());

        return {
            indexBytes: saved.bytes,
            directSha: await t.sha(direct.blob),
            viaIndexSha: await t.sha(viaIndex.blob),
            mapped: viaIndex.stats.mapped,
        };
    })()`, 300000);

    check("index round-trips to identical output", roundTrip.directSha === roundTrip.viaIndexSha,
        `${(roundTrip.indexBytes / 1024).toFixed(0)} kB index, ${roundTrip.mapped} mapped`);

    // --- cancellation and scale, which need the large fixtures ---------------------
    if (existsSync(join(FIXTURES.dir, "reads-big.fq"))) {
        console.log("\ncancellation:");
        await openApp();
        const cancel = await cdp.eval(`(async () => {
            const t = window.__t;
            const ref = await t.file("${FIXTURES.url}/ref-big.fa", "ref-big.fa");
            const reads = await t.file("${FIXTURES.url}/reads-big.fq", "reads-big.fq");
            let sent = false;
            const r = await t.run(ref, reads, t.opts(), (state) => {
                // Cancel once mapping is demonstrably under way, so this tests a
                // mid-run stop rather than racing startup.
                if (!sent && state.progress && state.progress.completed > 4 * 1024 * 1024) {
                    sent = true;
                    window.__store.dispatch("cancelRammap");
                }
            }, 600000);
            return { cancelled: r.cancelled, reads: r.stats.reads };
        })()`, 600000);

        check("cancel stops the run", cancel.cancelled === true);
        check("cancel stops early", cancel.reads > 0 && cancel.reads < 20001,
            `${cancel.reads} of 20001 reads processed`);

        console.log("\nscale (~85 MB of SAM through the Blob sink):");
        await openApp();
        const nodeBytes = harness([
            join(FIXTURES.dir, "ref-big.fa"), join(FIXTURES.dir, "reads-big.fq"), "--sam",
        ]).length;

        const scale = await cdp.eval(`(async () => {
            const t = window.__t;
            const ref = await t.file("${FIXTURES.url}/ref-big.fa", "ref-big.fa");
            const reads = await t.file("${FIXTURES.url}/reads-big.fq", "reads-big.fq");
            const started = performance.now();
            const r = await t.run(ref, reads, t.opts({ outputSam: true }), null, 900000);
            // Deliberately not hashed: digesting 85 MB needs the whole blob in memory at
            // once, which is exactly what this case exists to rule out.
            return {
                bytes: r.outputBytes, blobSize: r.blob.size,
                reads: r.stats.reads, mapped: r.stats.mapped,
                truncated: r.truncated,
                previewLines: r.preview.split("\\n").filter(Boolean).length,
                seconds: (performance.now() - started) / 1000,
            };
        })()`, 900000);

        check("output size matches Node harness", scale.bytes === nodeBytes,
            `${(scale.bytes / 1048576).toFixed(1)} MB vs ${(nodeBytes / 1048576).toFixed(1)} MB`);
        check("blob holds the whole output", scale.blobSize === scale.bytes, `${scale.blobSize} bytes`);
        check("all reads mapped", scale.mapped === 20001, `${scale.mapped}/${scale.reads}`);
        check("preview stayed bounded", scale.truncated && scale.previewLines <= 5000,
            `${scale.previewLines} lines, truncated=${scale.truncated}`);
        console.log(`  (${scale.seconds.toFixed(1)}s in-browser)`);
    } else {
        console.log("\n(skipping cancellation and scale: run make-fixtures.mjs --scale first)");
    }

    console.log("");
    check("no uncaught page exceptions", pageErrors.length === 0, pageErrors[0] ?? "");

    console.log(failures === 0 ? "\nall browser checks passed" : `\n${failures} browser check(s) failed`);
    process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
    console.error("browser test error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
} finally {
    shutdown();
}
