//! Mapping session: reads in as byte chunks, PAF or SAM out.

use std::sync::Arc;

use js_sys::{Object, Reflect};
use rammap::align::extend::AlignmentContext;
use rammap::align::index::Index;
use rammap::align::map::{MapContext, MapOptions};
use rammap::align::pipeline::{OutputConfig, ReadInfo, align_and_format_query};
use rammap::api::{calibrate_mid_occ, finalize_options};
use wasm_bindgen::prelude::*;

use crate::index::{RammapIndex, set_num};
use crate::opts::RammapOptions;
use crate::progress::{CancelFlag, post_progress};
use crate::query::{QueryParser, QueryRecord};
use crate::sam::sam_header;
use crate::util::js_err;

#[wasm_bindgen]
pub struct MapSession {
    index: Arc<Index>,
    opt: MapOptions,
    out_cfg: OutputConfig,
    opts: RammapOptions,
    parser: QueryParser,
    ctx: AlignmentContext,
    map_ctx: MapContext,
    header_emitted: bool,
    copy_comment: bool,
    cancel: CancelFlag,
    n_reads: u64,
    n_mapped: u64,
    n_bases: u64,
}

#[wasm_bindgen]
impl MapSession {
    #[wasm_bindgen(constructor)]
    pub fn new(index: &RammapIndex, opts: &RammapOptions) -> Result<MapSession, JsValue> {
        let idx = index.arc();
        let (mut opt, k, w, hpc) = opts.resolve()?;

        // An index's seeding geometry is fixed at build time. A mismatch means the
        // query sketch and the index disagree, and the symptom is silent zero output
        // rather than an error — so check explicitly.
        if opts.k_set() && k != idx.kmer_size {
            return Err(js_err(format!(
                "k={k} does not match the index (k={})",
                idx.kmer_size
            )));
        }
        if opts.w_set() && w != idx.window_size {
            return Err(js_err(format!(
                "w={w} does not match the index (w={})",
                idx.window_size
            )));
        }
        if opts.hpc_set() && hpc != idx.homopolymer_compressed {
            return Err(js_err("hpc setting does not match the index"));
        }

        // Without reference bases there is nothing to run DP against. Failing loudly
        // beats emitting SAM full of `*` CIGARs.
        if opts.wants_alignment() && !idx.has_sequences() {
            return Err(js_err(
                "this index was built without reference sequences, so base-level \
                 alignment is impossible; use PAF output with CIGAR disabled, or \
                 rebuild the index",
            ));
        }

        finalize_options(&mut opt, idx.kmer_size);
        calibrate_mid_occ(&mut opt, &idx, opts.mid_occ_frac());

        Ok(MapSession {
            index: idx,
            opt,
            out_cfg: opts.out_cfg(),
            opts: opts.clone(),
            parser: QueryParser::new(),
            ctx: AlignmentContext::new(),
            map_ctx: MapContext::new(),
            header_emitted: false,
            copy_comment: opts.copy_comment(),
            cancel: CancelFlag::default(),
            n_reads: 0,
            n_mapped: 0,
            n_bases: 0,
        })
    }

    /// The `@HD`/`@SQ`/`@PG` block, or empty in PAF mode.
    ///
    /// Idempotent: a second call returns empty, so the caller can invoke it
    /// unconditionally before the first chunk without risking a duplicated header.
    pub fn header(&mut self) -> Vec<u8> {
        if self.header_emitted || !self.out_cfg.output_sam {
            return Vec::new();
        }
        self.header_emitted = true;
        sam_header(&self.index, &self.opts)
    }

    /// Push query bytes; returns the output for the reads completed by this chunk.
    ///
    /// Returns `Vec<u8>` (a JS `Uint8Array`) rather than `String` deliberately. PAF and
    /// SAM are ASCII, so bytes go straight into a writable stream or a Blob part with
    /// no UTF-16 conversion — and, more importantly, the caller is never tempted to
    /// accumulate one giant JS string, which is what caps rammap's own demo at V8's
    /// ~512 MB string limit.
    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.parser.push(chunk).map_err(js_err)?;
        let mut out = Vec::new();
        while let Some(rec) = self.parser.next_record().map_err(js_err)? {
            // Checked per record rather than per chunk, so a cancel issued while the
            // previous chunk was running takes effect at the next record boundary
            // instead of after this whole chunk. Any bytes still buffered in the
            // parser are left intact.
            if self.cancel.is_set() {
                break;
            }
            self.map_one(&rec, &mut out);
            post_progress(
                "map",
                self.n_reads as f64,
                0.0,
                Some(&format!("{} mapped", self.n_mapped)),
                false,
            );
        }
        Ok(out)
    }

    /// Flush the trailing record. May return empty.
    pub fn finish(&mut self) -> Result<Vec<u8>, JsValue> {
        self.parser.finalize();
        let mut out = Vec::new();
        while let Some(rec) = self.parser.next_record().map_err(js_err)? {
            if self.cancel.is_set() {
                break;
            }
            self.map_one(&rec, &mut out);
        }
        post_progress("map", self.n_reads as f64, 0.0, Some("done"), true);
        Ok(out)
    }

    /// Request a stop. Only observable between records — see `CancelFlag`.
    pub fn cancel(&self) {
        self.cancel.set();
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.is_set()
    }

    /// Bytes buffered awaiting a record boundary.
    #[wasm_bindgen(js_name = pendingBytes)]
    pub fn pending_bytes(&self) -> usize {
        self.parser.pending_bytes()
    }

    pub fn stats(&self) -> Result<JsValue, JsValue> {
        let o = Object::new();
        set_num(&o, "reads", self.n_reads as f64)?;
        set_num(&o, "mapped", self.n_mapped as f64)?;
        set_num(&o, "bases", self.n_bases as f64)?;
        Reflect::set(&o, &"outputSam".into(), &JsValue::from_bool(self.out_cfg.output_sam))?;
        Reflect::set(&o, &"cancelled".into(), &JsValue::from_bool(self.cancel.is_set()))?;
        Ok(o.into())
    }
}

impl MapSession {
    fn map_one(&mut self, rec: &QueryRecord, out: &mut Vec<u8>) {
        self.n_reads += 1;
        self.n_bases += rec.seq.len() as u64;

        let ri = ReadInfo {
            qname: &rec.name,
            qseq: &rec.seq,
            // Populating qual is the whole reason for our own parser: rammap's
            // FastqStreamer drops it, which is why its demo emits `*` for QUAL.
            qual: rec.qual.as_deref(),
            // Gated like the CLI's --copy-comment (minimap2 -y). Passing it
            // unconditionally appends an extra field to every record.
            comment: self.copy_comment.then(|| rec.comment.as_deref()).flatten(),
            n_seg: 1,
            seg_idx: 0,
        };

        // The exact per-read entry point the CLI uses. `api::Aligner::format_paf`
        // cannot emit SAM at all, so this is the only route to CLI-identical output.
        let (text, _stats) = align_and_format_query(
            &self.opt,
            &self.index,
            &ri,
            &mut self.ctx,
            &mut self.map_ctx,
            None, // junc_db: --junc-bed/--spsc are file-based, out of scope here
            None, // jump_db: likewise
            &self.out_cfg,
        );

        if !text.is_empty() {
            self.n_mapped += 1;
            out.extend_from_slice(text.as_bytes());
        }
    }
}
