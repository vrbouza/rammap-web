//! Small shared helpers.

use wasm_bindgen::JsValue;

/// Adapter used at every fallible boundary: `.map_err(js_err)?`.
///
/// Errors cross as plain strings, which JS catches with `try`/`catch`. Internal
/// helpers return `Result<_, String>` so the core logic stays JS-free and testable
/// natively; only the exported methods convert.
///
/// Prefer this over `panic!`/`.expect()`. A Rust panic surfaces as
/// `RuntimeError: unreachable executed` and poisons the module — the worker then has
/// to be discarded and respawned rather than retried.
pub fn js_err(msg: impl core::fmt::Display) -> JsValue {
    JsValue::from_str(&msg.to_string())
}
