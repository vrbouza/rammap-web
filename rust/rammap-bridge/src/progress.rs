//! Progress reporting and cooperative cancellation.

use std::cell::Cell;

use js_sys::{Object, Reflect};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// The worker global's own `postMessage`.
    ///
    /// Importing it directly, rather than threading a `js_sys::Function` callback
    /// through every call, is what sparrowhawk's esm-bridge does; it keeps the
    /// per-record loop free of `Function::call` reflection.
    ///
    /// This binds a *bare global*, so it only exists inside a Web Worker. On the main
    /// thread `window.postMessage` has a different signature, and under
    /// `wasm-pack test --node` the identifier is absent entirely. That is what
    /// `PROGRESS_ON` below is for: the import always resolves, and is only ever called
    /// once a worker has opted in.
    #[wasm_bindgen(js_name = postMessage)]
    fn post_message(data: &JsValue);
}

thread_local! {
    static PROGRESS_ON: Cell<bool> = const { Cell::new(false) };
    static LAST_POST_MS: Cell<f64> = const { Cell::new(f64::NEG_INFINITY) };
}

/// Opt in to `postMessage`-based progress. A worker calls this once after loading the
/// module; anywhere else leaves it off and every `post_*` below is a no-op.
#[wasm_bindgen(js_name = enableProgress)]
pub fn enable_progress(on: bool) {
    PROGRESS_ON.with(|c| c.set(on));
    LAST_POST_MS.with(|c| c.set(f64::NEG_INFINITY));
}

/// One message per 100 ms. A post per record on a 10 M-read FASTQ would enqueue 10 M
/// structured clones for the main thread to drain, which costs more than the work
/// being reported on.
const MIN_INTERVAL_MS: f64 = 100.0;

/// `{ rammapProgress: true, phase, completed, total, detail }`.
///
/// The counter is `completed`, not `done`: consumers discriminate completion with
/// `if (msg.done)`, and a field named `done` on a *progress* message is truthy the
/// moment any work has happened, so the two collide and progress is mistaken for a
/// finished run.
///
/// `force` bypasses the throttle, for phase transitions that must not be dropped.
pub fn post_progress(phase: &str, completed: f64, total: f64, detail: Option<&str>, force: bool) {
    if !PROGRESS_ON.with(|c| c.get()) {
        return;
    }
    let now = js_sys::Date::now();
    if !force && now - LAST_POST_MS.with(|c| c.get()) < MIN_INTERVAL_MS {
        return;
    }
    LAST_POST_MS.with(|c| c.set(now));

    let o = Object::new();
    let _ = Reflect::set(&o, &"rammapProgress".into(), &JsValue::TRUE);
    let _ = Reflect::set(&o, &"phase".into(), &JsValue::from_str(phase));
    let _ = Reflect::set(&o, &"completed".into(), &JsValue::from_f64(completed));
    let _ = Reflect::set(&o, &"total".into(), &JsValue::from_f64(total));
    if let Some(d) = detail {
        let _ = Reflect::set(&o, &"detail".into(), &JsValue::from_str(d));
    }
    post_message(&o.into());
}

/// `{ rammapIndexBlock: true, bytes }` — one block of a serialising index.
///
/// Streaming the index out in blocks is why `RammapIndex::serializeStreaming` never
/// holds the whole serialised form alongside the index itself.
pub fn post_index_block(bytes: &[u8]) {
    if !PROGRESS_ON.with(|c| c.get()) {
        return;
    }
    let o = Object::new();
    let _ = Reflect::set(&o, &"rammapIndexBlock".into(), &JsValue::TRUE);
    let _ = Reflect::set(&o, &"bytes".into(), &js_sys::Uint8Array::from(bytes));
    post_message(&o.into());
}

/// Cooperative cancellation.
///
/// `Cell`, not `AtomicBool`: there is exactly one thread. This is also the limit of
/// what is achievable without `SharedArrayBuffer` — the main thread cannot write into
/// the module's linear memory, and while a `pushChunk` call is running the worker's
/// event loop is blocked, so a cancel message sits undelivered until it returns.
/// Checking the flag per record means an *already dispatched* chunk stops at its next
/// record boundary; a chunk already executing cannot be interrupted at all short of
/// `worker.terminate()`.
#[derive(Default)]
pub struct CancelFlag(Cell<bool>);

impl CancelFlag {
    #[inline]
    pub fn is_set(&self) -> bool {
        self.0.get()
    }
    pub fn set(&self) {
        self.0.set(true);
    }
}
