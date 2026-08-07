//! SAM header emission.
//!
//! rammap's wasm build emits alignment records only — `@HD`/`@SQ`/`@PG` are written
//! by the CLI in `map_one_part`, so SAM downloaded from the existing web demo is
//! headerless and samtools rejects it. This reproduces the CLI's block byte for byte.

use rammap::align::index::Index;

use crate::opts::RammapOptions;

/// rammap-core's version, for `@PG VN:`.
///
/// `env!("CARGO_PKG_VERSION")` would give *our* version, and cargo exposes no `DEP_*`
/// variable for a plain (non-`links`) dependency. Keep this in lockstep with the
/// `rev =` pin in Cargo.toml.
pub const RAMMAP_VERSION: &str = "1.1.2";

/// Build the header block. `index.seqs` is the same `Vec<TargetSequence>` the record
/// writer resolves RNAME through, so `@SQ SN:` and RNAME cannot drift apart.
pub fn sam_header(idx: &Index, opts: &RammapOptions) -> Vec<u8> {
    use std::fmt::Write as _;

    let mut h = String::with_capacity(64 + idx.seqs.len() * 48);
    h.push_str("@HD\tVN:1.6\tSO:unsorted\tGO:query\n");
    for s in &idx.seqs {
        let _ = writeln!(h, "@SQ\tSN:{}\tLN:{}", s.name, s.len);
    }
    // There is no argv in a browser. An empty CL: would be legal but useless, so we
    // record the resolved knobs instead — that is what a reader wants for provenance.
    let _ = writeln!(
        h,
        "@PG\tID:rammap\tPN:rammap\tVN:{}\tCL:{}",
        RAMMAP_VERSION,
        opts.pseudo_cmdline()
    );
    h.into_bytes()
}
