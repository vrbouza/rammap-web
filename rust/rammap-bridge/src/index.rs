//! Reference index: streaming construction, loading a prebuilt index, and serialising
//! one back out.

use std::io::{Cursor, Write};
use std::sync::Arc;

use js_sys::{Array, Object, Reflect};
use rammap::align::index::{Index, IndexBuilder};
use rammap::fasta::FastaStreamer;
use wasm_bindgen::prelude::*;

use crate::opts::RammapOptions;
use crate::progress::{CancelFlag, post_index_block, post_progress};
use crate::util::js_err;

/// rammap's own index magic, written by `Index::save_part`.
const RMMI_MAGIC: &[u8; 4] = b"RMMI";
/// minimap2's `.mmi` magic. See `RammapIndex::from_bytes` for why we refuse these.
const MMI_MAGIC: &[u8; 4] = b"MMI\x02";

/// Bytes buffered before a block is handed to JS during index serialisation.
const INDEX_BLOCK_BYTES: usize = 8 << 20;

/// A reference index, built here or loaded from bytes.
///
/// Shared by `Arc` so several `MapSession`s can reuse one copy of what is by far the
/// largest allocation in the process — wasm-bindgen cannot hand out Rust references,
/// so `Arc` is how you get "many sessions, one index". Same split as sparrowhawk's
/// `WasmIndex` / `WasmFilterSession`.
#[wasm_bindgen]
pub struct RammapIndex {
    inner: Arc<Index>,
    /// Filled by `serializeToBuffer`, emptied by `takeBytes`.
    serialized: Vec<u8>,
}

#[wasm_bindgen]
impl RammapIndex {
    /// Load a prebuilt index that is already resident in JS memory.
    ///
    /// `Index::load_part` needs `Read + Seek` (it seeks back four bytes to handle the
    /// legacy no-magic layout), and `Cursor` over the wasm-bindgen slice provides both
    /// with no extra copy.
    ///
    /// Memory: peaks at roughly twice the file, since bincode has no in-place mode.
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(data: &[u8]) -> Result<RammapIndex, JsValue> {
        // Refuse minimap2 .mmi files rather than trap on them. rammap's
        // Index::load_minimap2 calls unguarded std::time::Instant::now(), which panics
        // on wasm32-unknown-unknown — every other timing site in the crate uses
        // web_time, so this one was simply missed. A clear message beats
        // "unreachable executed", and this guard stays useful even once upstream is
        // fixed, because an older pinned rev would silently regress.
        if data.starts_with(MMI_MAGIC) {
            return Err(js_err(
                "minimap2 .mmi indices cannot be loaded in the browser yet. Convert it \
                 first with the native CLI: `rammap -d out.rmi ref.mmi`",
            ));
        }
        if data.is_empty() {
            return Err(js_err("index file is empty"));
        }

        let mut cursor = Cursor::new(data);
        let idx = Index::load_part(&mut cursor)
            .map_err(|e| js_err(format!("failed to read index: {e}")))?
            .ok_or_else(|| js_err("index file is empty"))?;

        // Multi-part indices (`rammap -I`) hold only a slice of the reference per part,
        // so mapping against part 0 alone silently loses alignments. Detect and refuse
        // rather than produce quietly wrong output.
        if matches!(Index::load_part(&mut cursor), Ok(Some(_))) {
            return Err(js_err(
                "this is a multi-part index; only single-part indices are supported in \
                 the browser. Rebuild with a batch size large enough for one part \
                 (rammap -I <size>)",
            ));
        }

        Ok(RammapIndex { inner: Arc::new(idx), serialized: Vec::new() })
    }

    /// `{ k, w, hpc, nSeqs, totalBases, hasSequences }`.
    ///
    /// Built with `js_sys::Object` + `Reflect::set` rather than serde-wasm-bindgen,
    /// matching sparrowhawk, which uses no serde bridge anywhere.
    pub fn info(&self) -> Result<JsValue, JsValue> {
        let total: usize = self.inner.seqs.iter().map(|s| s.len).sum();
        let o = Object::new();
        set_num(&o, "k", self.inner.kmer_size as f64)?;
        set_num(&o, "w", self.inner.window_size as f64)?;
        Reflect::set(&o, &"hpc".into(), &JsValue::from_bool(self.inner.homopolymer_compressed))?;
        set_num(&o, "nSeqs", self.inner.seqs.len() as f64)?;
        set_num(&o, "totalBases", total as f64)?;
        Reflect::set(&o, &"hasSequences".into(), &JsValue::from_bool(self.inner.has_sequences()))?;
        Ok(o.into())
    }

    /// Reference names and lengths, for the UI and for previewing the `@SQ` block.
    #[wasm_bindgen(js_name = refNames)]
    pub fn ref_names(&self) -> Result<Array, JsValue> {
        let arr = Array::new();
        for s in &self.inner.seqs {
            let o = Object::new();
            Reflect::set(&o, &"name".into(), &JsValue::from_str(&s.name))?;
            set_num(&o, "len", s.len as f64)?;
            arr.push(&o);
        }
        Ok(arr)
    }

    /// Whether base-level alignment is possible. False for an index built with
    /// `-no-seq`, or one that has been through `strip_sequences`.
    #[wasm_bindgen(js_name = hasSequences)]
    pub fn has_sequences(&self) -> bool {
        self.inner.has_sequences()
    }

    /// Serialise to rammap's RMMI format, emitting 8 MB blocks to the worker via
    /// `postMessage` as they are produced. Returns the total byte count.
    ///
    /// `Index::save_part` takes `&mut W`, so a custom `Write` sink means the serialised
    /// stream never coexists with the index in linear memory: peak overhead is one
    /// block, rather than the ~2x a serialise-then-hand-over would cost. That matters
    /// against a 4 GB ceiling where the index is already the dominant allocation.
    #[wasm_bindgen(js_name = serializeStreaming)]
    pub fn serialize_streaming(&self) -> Result<f64, JsValue> {
        let mut sink = ChunkedSink::new(INDEX_BLOCK_BYTES);
        self.inner
            .save_part(&mut sink)
            .map_err(|e| js_err(format!("failed to serialise index: {e}")))?;
        let total = sink.finish();
        post_progress("saveIndex", total as f64, total as f64, Some("index written"), true);
        Ok(total as f64)
    }

    /// Serialise into an internal buffer and return its size.
    ///
    /// For callers that cannot receive `postMessage` blocks — the Node harness, and
    /// anything running on the main thread. Costs ~2x the index in peak memory, so
    /// prefer `serializeStreaming` inside a worker.
    ///
    /// Split into two calls rather than returning `Vec<u8>` directly so JS learns the
    /// size first and can decide, and so `takeBytes` frees the wasm-side copy the
    /// moment it lands in JS.
    #[wasm_bindgen(js_name = serializeToBuffer)]
    pub fn serialize_to_buffer(&mut self) -> Result<f64, JsValue> {
        let mut buf = Vec::new();
        self.inner
            .save_part(&mut buf)
            .map_err(|e| js_err(format!("failed to serialise index: {e}")))?;
        self.serialized = buf;
        Ok(self.serialized.len() as f64)
    }

    /// Move the buffered bytes out to JS, freeing the wasm-side copy in the same call.
    /// The `take_*` idiom from sparrowhawk's orphos-bridge; under a 4 GB ceiling it
    /// matters that this does not leave a second copy behind.
    #[wasm_bindgen(js_name = takeBytes)]
    pub fn take_bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.serialized)
    }

    /// The magic bytes an RMMI file starts with, so JS can label a downloaded index or
    /// sniff a dropped file without duplicating the constant.
    #[wasm_bindgen(js_name = rmmiMagic)]
    pub fn rmmi_magic() -> Vec<u8> {
        RMMI_MAGIC.to_vec()
    }
}

impl RammapIndex {
    pub(crate) fn from_index(idx: Index) -> Self {
        RammapIndex { inner: Arc::new(idx), serialized: Vec::new() }
    }
    pub(crate) fn arc(&self) -> Arc<Index> {
        Arc::clone(&self.inner)
    }
}

/// A `std::io::Write` that forwards completed blocks straight to JS and keeps nothing.
struct ChunkedSink {
    buf: Vec<u8>,
    cap: usize,
    total: u64,
}

impl ChunkedSink {
    fn new(cap: usize) -> Self {
        ChunkedSink { buf: Vec::with_capacity(cap), cap, total: 0 }
    }

    fn flush_block(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        post_index_block(&self.buf);
        // Clear, not drop: the capacity is reused for the next block.
        self.buf.clear();
        post_progress("saveIndex", self.total as f64, 0.0, None, false);
    }

    fn finish(mut self) -> u64 {
        self.flush_block();
        self.total
    }
}

impl Write for ChunkedSink {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        self.total += data.len() as u64;
        if self.buf.len() >= self.cap {
            self.flush_block();
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Streaming index construction: push reference bytes, get an index out.
///
/// Each completed FASTA record is packed and its ASCII bytes dropped before the next
/// arrives, so peak memory is roughly (packed + buckets) rather than
/// (raw + packed + buckets). That is what `IndexBuilder` exists for, and it is why we
/// do not go through `api::Aligner::from_seqs`, which needs the whole reference
/// materialised as `Vec<(String, Vec<u8>)>`.
#[wasm_bindgen]
pub struct IndexBuildSession {
    builder: Option<IndexBuilder>,
    parser: FastaStreamer,
    bytes_in: u64,
    cancel: CancelFlag,
}

#[wasm_bindgen]
impl IndexBuildSession {
    #[wasm_bindgen(constructor)]
    pub fn new(opts: &RammapOptions) -> Result<IndexBuildSession, JsValue> {
        let (_opt, k, w, hpc) = opts.resolve()?;
        Ok(IndexBuildSession {
            builder: Some(IndexBuilder::new(w, k, hpc, opts.index_max_occ())),
            parser: FastaStreamer::new(),
            bytes_in: 0,
            cancel: CancelFlag::default(),
        })
    }

    /// Upper-bound hint for the packed buffer: the file size for plain FASTA, or
    /// roughly 4x the compressed size for gzip. Skipping it costs a doubling realloc
    /// that transiently needs 3x the final buffer.
    #[wasm_bindgen(js_name = reserveBases)]
    pub fn reserve_bases(&mut self, expected_total: f64) -> Result<(), JsValue> {
        self.builder
            .as_mut()
            .ok_or_else(|| js_err("index build already finished"))?
            .reserve_bases(expected_total.max(0.0) as usize);
        Ok(())
    }

    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        let builder = self
            .builder
            .as_mut()
            .ok_or_else(|| js_err("index build already finished"))?;
        self.bytes_in += chunk.len() as u64;
        self.parser.push(chunk);
        while let Some((name, seq)) = self.parser.next_record() {
            if self.cancel.is_set() {
                return Err(js_err("cancelled"));
            }
            builder.add_sequence(name, seq);
            post_progress(
                "buildIndex",
                builder.total_bases() as f64,
                0.0,
                Some(&format!("{} sequence(s)", builder.num_sequences())),
                false,
            );
        }
        Ok(())
    }

    /// Flush the trailing record, sort the buckets, and build the lookup backend.
    ///
    /// `IndexBuilder::finish` is the one genuinely long opaque call in the pipeline —
    /// it sorts every bucket with no callback hook — so progress can only bracket it.
    pub fn finish(&mut self) -> Result<RammapIndex, JsValue> {
        let mut builder = self
            .builder
            .take()
            .ok_or_else(|| js_err("index build already finished"))?;
        self.parser.finalize();
        while let Some((name, seq)) = self.parser.next_record() {
            builder.add_sequence(name, seq);
        }
        if builder.num_sequences() == 0 {
            return Err(js_err(
                "no FASTA records found in the reference — is this really a FASTA file?",
            ));
        }
        post_progress(
            "buildIndex",
            builder.total_bases() as f64,
            0.0,
            Some("sorting minimizers"),
            true,
        );
        let idx = builder.finish();
        post_progress("buildIndex", 0.0, 0.0, Some("index ready"), true);
        Ok(RammapIndex::from_index(idx))
    }

    pub fn cancel(&self) {
        self.cancel.set();
    }

    pub fn stats(&self) -> Result<JsValue, JsValue> {
        let o = Object::new();
        set_num(&o, "bytesIn", self.bytes_in as f64)?;
        let (seqs, bases) = match &self.builder {
            Some(b) => (b.num_sequences() as f64, b.total_bases() as f64),
            None => (0.0, 0.0),
        };
        set_num(&o, "nSeqs", seqs)?;
        set_num(&o, "totalBases", bases)?;
        Ok(o.into())
    }
}

pub(crate) fn set_num(obj: &Object, key: &str, value: f64) -> Result<(), JsValue> {
    Reflect::set(obj, &JsValue::from_str(key), &JsValue::from_f64(value))?;
    Ok(())
}
