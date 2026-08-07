//! Mapping options, resolved the same way the native CLI resolves them.

use rammap::align::map::{AlignFlags, MapOptions};
use rammap::align::pipeline::OutputConfig;
use rammap::api::{MAX_KMER, apply_preset_str};
use wasm_bindgen::prelude::*;

use crate::util::js_err;

/// Occurrence cap used during index construction when the caller does not set one.
///
/// The CLI default is `usize::MAX`, i.e. uncapped (`AlignerBuilder::new`). rammap's own
/// web demo hardcodes 50_000 (`wasm_lib.rs`), which silently diverges from the CLI on
/// repetitive references — that alone accounts for most reported wasm/native
/// mismatches. We follow the CLI and expose the knob; `0` from JS means uncapped.
const DEFAULT_INDEX_MAX_OCC: usize = usize::MAX;

/// Fraction of the most repetitive minimizers to filter when calibrating the seed
/// occurrence threshold. Matches `AlignerBuilder::new`.
const DEFAULT_MID_OCC_FRAC: f32 = 2e-4;

#[wasm_bindgen]
#[derive(Clone)]
pub struct RammapOptions {
    preset: String,
    k: Option<usize>,
    w: Option<usize>,
    hpc: Option<bool>,
    index_max_occ: usize,
    mid_occ: Option<usize>,
    mid_occ_frac: f32,
    output_sam: bool,
    cigar: bool,
    cs: bool,
    cs_long: bool,
    md: bool,
    eqx: bool,
    copy_comment: bool,
}

#[wasm_bindgen]
impl RammapOptions {
    #[wasm_bindgen(constructor)]
    pub fn new(preset: &str) -> RammapOptions {
        RammapOptions {
            preset: preset.to_string(),
            k: None,
            w: None,
            hpc: None,
            index_max_occ: DEFAULT_INDEX_MAX_OCC,
            mid_occ: None,
            mid_occ_frac: DEFAULT_MID_OCC_FRAC,
            output_sam: false,
            cigar: true,
            cs: false,
            cs_long: false,
            md: false,
            eqx: false,
            copy_comment: false,
        }
    }

    /// `0` clears the override and lets the preset decide.
    #[wasm_bindgen(setter)]
    pub fn set_k(&mut self, v: usize) {
        self.k = (v != 0).then_some(v);
    }
    #[wasm_bindgen(getter)]
    pub fn k(&self) -> usize {
        self.k.unwrap_or(0)
    }

    #[wasm_bindgen(setter)]
    pub fn set_w(&mut self, v: usize) {
        self.w = (v != 0).then_some(v);
    }
    #[wasm_bindgen(getter)]
    pub fn w(&self) -> usize {
        self.w.unwrap_or(0)
    }

    #[wasm_bindgen(setter)]
    pub fn set_hpc(&mut self, v: bool) {
        self.hpc = Some(v);
    }
    #[wasm_bindgen(getter)]
    pub fn hpc(&self) -> bool {
        self.hpc.unwrap_or(false)
    }

    /// `0` (or negative) means uncapped, matching the CLI.
    #[wasm_bindgen(setter, js_name = indexMaxOcc)]
    pub fn set_index_max_occ(&mut self, v: f64) {
        self.index_max_occ = if v <= 0.0 { usize::MAX } else { v as usize };
    }
    #[wasm_bindgen(getter, js_name = indexMaxOcc)]
    pub fn index_max_occ_js(&self) -> f64 {
        if self.index_max_occ == usize::MAX { 0.0 } else { self.index_max_occ as f64 }
    }

    #[wasm_bindgen(setter, js_name = midOcc)]
    pub fn set_mid_occ(&mut self, v: usize) {
        self.mid_occ = (v != 0).then_some(v);
    }

    #[wasm_bindgen(setter, js_name = midOccFrac)]
    pub fn set_mid_occ_frac(&mut self, v: f32) {
        self.mid_occ_frac = v;
    }

    #[wasm_bindgen(setter, js_name = outputSam)]
    pub fn set_output_sam(&mut self, v: bool) {
        self.output_sam = v;
    }
    #[wasm_bindgen(getter, js_name = outputSam)]
    pub fn output_sam(&self) -> bool {
        self.output_sam
    }

    #[wasm_bindgen(setter)]
    pub fn set_cigar(&mut self, v: bool) {
        self.cigar = v;
    }
    #[wasm_bindgen(getter)]
    pub fn cigar(&self) -> bool {
        self.cigar
    }

    #[wasm_bindgen(setter)]
    pub fn set_cs(&mut self, v: bool) {
        self.cs = v;
    }
    #[wasm_bindgen(setter, js_name = csLong)]
    pub fn set_cs_long(&mut self, v: bool) {
        self.cs_long = v;
        if v {
            self.cs = true;
        }
    }
    #[wasm_bindgen(setter)]
    pub fn set_md(&mut self, v: bool) {
        self.md = v;
    }
    #[wasm_bindgen(setter)]
    pub fn set_eqx(&mut self, v: bool) {
        self.eqx = v;
    }

    /// Copy FASTA/FASTQ header comments to the output, i.e. the CLI's
    /// `--copy-comment` (minimap2's `-y`). Off by default, matching both.
    ///
    /// Our parser always *retains* the comment — unlike rammap's `FastqStreamer`,
    /// which discards it — but emitting it unconditionally would append an extra
    /// field to every PAF record and diverge from the CLI.
    #[wasm_bindgen(setter, js_name = copyComment)]
    pub fn set_copy_comment(&mut self, v: bool) {
        self.copy_comment = v;
    }
    #[wasm_bindgen(getter, js_name = copyComment)]
    pub fn copy_comment(&self) -> bool {
        self.copy_comment
    }
}

// Rust-side accessors. Kept out of the `#[wasm_bindgen]` block so they do not become
// part of the JS surface.
impl RammapOptions {
    pub(crate) fn k_set(&self) -> bool {
        self.k.is_some()
    }
    pub(crate) fn w_set(&self) -> bool {
        self.w.is_some()
    }
    pub(crate) fn hpc_set(&self) -> bool {
        self.hpc.is_some()
    }
    pub(crate) fn index_max_occ(&self) -> usize {
        self.index_max_occ
    }
    pub(crate) fn mid_occ_frac(&self) -> f32 {
        self.mid_occ_frac
    }
    pub(crate) fn wants_alignment(&self) -> bool {
        self.cigar || self.output_sam || self.cs || self.md
    }

    /// Preset plus overrides, before any index-derived values are applied.
    ///
    /// Deliberately mirrors `AlignerBuilder::resolve` so wasm and native validate
    /// identically and reject the same inputs.
    ///
    /// Note `apply_preset_str` has a process-global side effect (`set_simd_cap`).
    /// Harmless with one wasm instance, but it means presets are not fully
    /// independent — enumerate them at startup, not between sessions.
    pub(crate) fn resolve(&self) -> Result<(MapOptions, usize, usize, bool), JsValue> {
        let (mut k, mut w, mut hpc) = (15usize, 10usize, false);
        let mut opt = MapOptions::default();
        apply_preset_str(&mut opt, &mut k, &mut w, &mut hpc, &self.preset)
            .map_err(|e| js_err(format!("unknown preset '{}': {e}", self.preset)))?;

        let k = self.k.unwrap_or(k);
        let w = self.w.unwrap_or(w);
        let hpc = self.hpc.unwrap_or(hpc);

        if k == 0 || k > MAX_KMER {
            return Err(js_err(format!("k must be in 1..={MAX_KMER}, got {k}")));
        }
        if w == 0 {
            return Err(js_err("w must be at least 1"));
        }
        if !(0.0..1.0).contains(&self.mid_occ_frac) {
            return Err(js_err(format!(
                "mid_occ_frac must be in [0, 1), got {}",
                self.mid_occ_frac
            )));
        }
        if let Some(v) = self.mid_occ {
            opt.seeding.mid_occ = v;
        }

        // SAM, cs, and MD all require base-level alignment.
        if self.wants_alignment() {
            opt.flags.insert(AlignFlags::OUT_CIGAR);
        } else {
            opt.flags.remove(AlignFlags::OUT_CIGAR);
        }
        Ok((opt, k, w, hpc))
    }

    pub(crate) fn out_cfg(&self) -> OutputConfig {
        OutputConfig {
            do_cigar: self.cigar || self.output_sam,
            do_cs: self.cs,
            cs_long: self.cs_long,
            do_md: self.md,
            do_ds: false,
            eqx: self.eqx,
            output_sam: self.output_sam,
            rg_id: None,
            split_mode: false,
        }
    }

    /// Reconstruction of the equivalent CLI invocation, for the SAM `@PG CL:` field.
    /// There is no argv in a browser, so the resolved knobs are what a reader wants
    /// for provenance.
    pub(crate) fn pseudo_cmdline(&self) -> String {
        let mut parts = vec!["rammap".to_string(), "-x".to_string(), self.preset.clone()];
        if self.output_sam {
            parts.push("-a".to_string());
        } else if self.cigar {
            parts.push("-c".to_string());
        }
        if let Some(k) = self.k {
            parts.push(format!("-k{k}"));
        }
        if let Some(w) = self.w {
            parts.push(format!("-w{w}"));
        }
        if self.cs {
            parts.push(if self.cs_long { "--cs=long".into() } else { "--cs".into() });
        }
        if self.md {
            parts.push("--MD".to_string());
        }
        if self.eqx {
            parts.push("--eqx".to_string());
        }
        parts.join(" ")
    }
}
