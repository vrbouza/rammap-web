// Static dev server for the web demo.
//
//   node scripts/serve.mjs [port]      → http://localhost:8080/web/
//
// A server is required: ES module workers, dynamic import of the wasm glue, and
// fetching the .wasm all fail under file://.
//
// No COOP/COEP headers here. Those are only needed for SharedArrayBuffer, and this
// build is deliberately single-threaded on stable Rust — the same posture sparrowhawk
// takes. Adding them would break embedding without buying anything.

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Served root: the repository, four levels up from this script. */
const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const port = Number(process.argv[2] ?? 8080);

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".css": "text/css; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
};

createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/web/";
    if (pathname.endsWith("/")) pathname += "index.html";

    // normalize() collapses any ../ before we join, so a crafted path cannot escape.
    const target = join(ROOT, normalize(pathname));
    if (!target.startsWith(ROOT)) {
        res.writeHead(403).end("forbidden");
        return;
    }

    let stats;
    try {
        stats = statSync(target);
    } catch {
        res.writeHead(404).end("not found");
        return;
    }
    if (!stats.isFile()) {
        res.writeHead(404).end("not found");
        return;
    }

    res.writeHead(200, {
        "content-type": TYPES[extname(target)] ?? "application/octet-stream",
        "content-length": stats.size,
        // Rebuilds are frequent, and a stale worker.js paired with a fresh index.html
        // fails in confusing ways.
        "cache-control": "no-store",
    });

    // Navigating away aborts in-flight requests, which surfaces here as EPIPE or a
    // premature close. Without these handlers the resulting 'error' event is unhandled
    // and takes the whole server down — after which every later fetch fails with an
    // opaque "Failed to fetch" in the page.
    const stream = createReadStream(target);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
})
.on("clientError", (_err, socket) => socket.destroy())
.listen(port, () => {
    console.log(`serving ${ROOT}`);
    console.log(`open http://localhost:${port}/web/`);
});
