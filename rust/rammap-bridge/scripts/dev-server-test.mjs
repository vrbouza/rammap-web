// Verify `npm run serve` in www/ actually works — the command a developer types, which
// the main browser suite does not cover because that one tests the production build.
//
//   node scripts/dev-server-test.mjs
//
// Deliberately separate from scripts/browser-test.mjs: booting vue-cli-service costs
// 30-40 s (longer on the first run, which compiles the crate through WasmPackPlugin),
// and that should not be paid on every run of the main suite.
//
// Worth having its own test because dev and production resolve assets differently:
// publicPath is relative in production and absolute in development, so a change that
// works in one mode can silently break the other.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, four levels up from rust/rammap-bridge/scripts/<this file>. */
const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CRATE = resolve(fileURLToPath(import.meta.url), "../..");
const PORT = 8080;      // vue-cli-service default
const CDP_PORT = 9229;

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

async function waitFor(fn, what, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const v = await fn();
            if (v) return v;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(500);
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

    async eval(expression) {
        const r = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
        return r.result.value;
    }
}

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

const profile = makeProfile("rammap-dev-");
let devServer, chrome;

function shutdown() {
    chrome?.kill("SIGKILL");
    // npm spawns a shell which spawns vue-cli-service, so killing the direct child
    // leaves the server running and holding the port. detached:true puts the whole
    // thing in its own process group; kill the group, and fall back to the direct
    // child if the group has already gone.
    if (devServer?.pid) {
        try { process.kill(-devServer.pid, "SIGKILL"); } catch { /* group already gone */ }
        try { devServer.kill("SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(profile, { recursive: true, force: true });
}
process.on("exit", shutdown);
process.on("SIGINT", () => { shutdown(); process.exit(130); });

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
    if (!ok) failures++;
};

/** Whether something is already listening on the port. */
async function portInUse(port) {
    try {
        await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
        return true;
    } catch {
        return false;
    }
}

try {
    // Refuse to run against a server this script did not start. Silently attaching to a
    // stale one is worse than failing: vue-cli-service quietly falls back to the next
    // free port, so the test would poll one server while driving another, and the
    // symptom is an unexplained boot timeout.
    if (await portInUse(PORT)) {
        throw new Error(
            `port ${PORT} is already in use — stop the running dev server first ` +
            `(pkill -f vue-cli-service)`,
        );
    }

    console.log("starting `npm run serve` (first run also compiles the crate)…");
    devServer = spawn("npm", ["--prefix", join(ROOT, "www"), "run", "serve"], {
        stdio: "ignore",
        detached: true,   // own process group, so shutdown() can kill the whole tree
    });

    await waitFor(
        async () => (await fetch(`http://localhost:${PORT}/`)).ok,
        "the dev server",
        300000,
    );

    chrome = spawn(findChrome(), [
        "--headless=new",
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        "--no-sandbox",
        "--disable-gpu",
        "about:blank",
    ], { stdio: "ignore" });

    const targets = await waitFor(
        async () => {
            const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
            return list.find((t) => t.type === "page") ? list : null;
        },
        "Chrome's debugging endpoint",
        60000,
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
    await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/` });

    console.log(`\nVue dev server (npm run serve, http://localhost:${PORT}/):`);

    const booted = await waitFor(async () => {
        const state = await cdp.eval(`(() => {
            const sel = document.querySelector("select");
            const st = window.__store?.state;
            return {
                presets: sel ? sel.options.length : 0,
                ready: !!st?.ready,
                status: st?.allResults_rammap.status ?? "",
            };
        })()`);
        return state.presets > 0 ? state : null;
    }, "the app to boot", 120000);

    check("app boots and loads wasm", booted.ready, booted.status);
    check("presets rendered from the module", booted.presets === 16, `${booted.presets} presets`);

    // Fixtures are injected rather than fetched: the dev server serves www/public, not
    // the repo root, and teaching the app's config about test data to satisfy a test
    // would be the wrong direction of dependency.
    const b64 = (p) => readFileSync(join(CRATE, p)).toString("base64");
    const refB64 = b64("tests/data/ref.fa");
    const readsB64 = b64("tests/data/reads.fq");

    // A real run through the store, so this proves the worker and its wasm chunk load
    // under the dev server's asset paths — the thing publicPath actually governs.
    const run = await cdp.eval(`(async () => {
        const f = (b64, n) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new File([bytes], n);
        };
        try {
            const ref = f(${JSON.stringify(refB64)}, "ref.fa");
            const reads = f(${JSON.stringify(readsB64)}, "reads.fq");
            const store = window.__store;
            store.dispatch("runRammap", {
                refFile: ref, queryFile: reads,
                opts: { preset: "map-ont", outputSam: false, cigar: true, cs: false, md: false,
                        eqx: false, copyComment: false, indexMaxOcc: 0, k: 0, w: 0 },
                dpCacheMb: 128,
            });
            for (let i = 0; i < 600; i++) {
                const r = store.state.allResults_rammap;
                if (r.result) return { mapped: r.result.stats.mapped, reads: r.result.stats.reads,
                                       bytes: r.result.outputBytes };
                if (r.error) return { error: r.error };
                await new Promise((res) => setTimeout(res, 200));
            }
            return { error: "timed out" };
        } catch (e) { return { error: String(e) }; }
    })()`);

    if (run.error) {
        check("maps through the Vuex store", false, run.error);
    } else {
        check("maps through the Vuex store", run.mapped === 500 && run.reads === 501,
            `${run.mapped}/${run.reads} mapped, ${run.bytes} bytes`);
    }
    check("no uncaught page exceptions", pageErrors.length === 0, pageErrors[0] ?? "");

    console.log(failures === 0 ? "\ndev server OK" : `\n${failures} check(s) failed`);
    process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
    console.error("dev server test error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
} finally {
    shutdown();
}
