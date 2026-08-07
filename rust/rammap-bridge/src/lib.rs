//! WebAssembly bridge for [rammap](https://github.com/jwanglab/rammap).
//!
//! This crate owns 100% of the `#[wasm_bindgen]` surface we ship, keeping upstream
//! rammap pristine — the same arrangement sparrowhawk uses for `rust/deacon-bridge`.
//!
//! # Two things to know before editing
//!
//! 1. **Never declare `#[wasm_bindgen(start)]` here.** rammap-core's own wasm surface
//!    (`align/wasm_lib.rs`) is gated on `target_arch = "wasm32"` with no cargo feature
//!    to opt out, so its exports link into our cdylib alongside ours. Verified: the
//!    generated module exports `AlignSession`, `align_wasm`, `align_wasm_full`,
//!    `force_align_wasm`, and `_set_panic_hook` next to ours. That is harmless, and
//!    mildly useful — the glue calls `__wbindgen_start()` on import, so rammap's panic
//!    hook (which prints file:line:col plus the payload, better than
//!    console_error_panic_hook) installs itself for free. But wasm-bindgen permits
//!    only one start function per module: declaring a second fails the build with
//!    "cannot specify two `start` functions".
//!
//! 2. **Keep exported names distinct** from rammap's, listed above. Two `export class`
//!    of the same name in one ESM module is a bundle-time SyntaxError.
//!
//! # Why the internals rather than `api::Aligner`
//!
//! Every `Aligner` constructor either takes a path (no filesystem in a browser) or a
//! fully materialised `Vec<(String, Vec<u8>)>`, which means holding the reference as
//! ASCII alongside the packed index; `IndexBuilder` exists precisely to avoid that.
//! And `AlignerBuilder::from_loaded_index` is private, so there is no way to hand an
//! `Index` you built yourself to an `Aligner`. Driving `IndexBuilder` and
//! `pipeline::align_and_format_query` directly avoids both problems and is also the
//! only route to SAM output, which `Aligner::format_paf` cannot produce.

mod index;
mod opts;
mod progress;
mod query;
mod sam;
mod session;
mod util;

pub use index::{IndexBuildSession, RammapIndex};
pub use opts::RammapOptions;
pub use progress::enable_progress;
pub use session::MapSession;

use wasm_bindgen::prelude::*;

/// Cap on the per-thread DP scratch cache, in megabytes; 0 means unbounded.
///
/// rammap keeps DP matrices (tens of MB for long reads) allocated per thread and
/// reuses them, defaulting to 128 MB. Against a 4 GB ceiling that is worth trimming
/// when the index is large. Process-global, so the last call wins — with one wasm
/// instance per worker that is exactly the intent.
#[wasm_bindgen(js_name = setDpCacheMb)]
pub fn set_dp_cache_mb(mb: usize) {
    rammap::set_dp_cache_cap_mb(if mb == 0 { rammap::DP_CACHE_UNBOUNDED } else { mb });
}

/// rammap's default for the above, so the UI can show it without hardcoding.
#[wasm_bindgen(js_name = defaultDpCacheMb)]
pub fn default_dp_cache_mb() -> usize {
    rammap::DEFAULT_DP_CACHE_CAP_MB
}

/// The rammap version this bridge is pinned against, for display and for asserting
/// that `sam::RAMMAP_VERSION` has not drifted from the `rev` in Cargo.toml.
#[wasm_bindgen(js_name = rammapVersion)]
pub fn rammap_version() -> String {
    sam::RAMMAP_VERSION.to_string()
}

/// Preset names accepted by [`RammapOptions::new`], in the order the UI should show
/// them.
///
/// Resolution goes through rammap's canonical `apply_preset_str`, so every preset the
/// CLI supports works here — including the HPC ones. (rammap's own demo offers only
/// five of them.)
#[wasm_bindgen(js_name = rammapPresets)]
pub fn rammap_presets() -> Vec<String> {
    [
        "map-ont", "map-pb", "map-hifi", "map-iclr", "lr:hq", "lr:hqae", "sr", "splice",
        "splice:hq", "splice:sr", "cdna", "asm5", "asm10", "asm20", "ava-ont", "ava-pb",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}
