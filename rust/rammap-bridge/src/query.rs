//! Chunked FASTA/FASTQ parser that preserves quality strings and comments.
//!
//! # Why this exists
//!
//! rammap's `FastqStreamer::next_record()` returns `Option<(String, Vec<u8>)>` — it
//! discards the quality string and the header comment. That is why rammap's own web
//! demo emits `*` in every SAM QUAL column, unlike the native CLI. `wasm_lib`'s
//! private `QueryParser` has the same shape, so neither is reusable here.
//!
//! Shaped after sparrowhawk's `SeqChunkParser` (rust/deacon-bridge/src/lib.rs): a push
//! interface that buffers a partial record across chunk boundaries, with the format
//! sniffed from the first non-whitespace byte.

use memchr::memchr;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Fasta,
    Fastq,
}

pub struct QueryRecord {
    pub name: String,
    pub comment: Option<String>,
    pub seq: Vec<u8>,
    pub qual: Option<String>,
}

pub struct QueryParser {
    pending: Vec<u8>,
    /// Offset into `pending` of the first unconsumed byte. Consuming by advancing an
    /// index and compacting occasionally, rather than draining from the front, keeps
    /// this linear instead of quadratic over a multi-GB file.
    consumed: usize,
    format: Option<Format>,
    finalized: bool,
}

impl QueryParser {
    pub fn new() -> Self {
        QueryParser { pending: Vec::new(), consumed: 0, format: None, finalized: false }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<(), String> {
        self.compact();
        self.pending.extend_from_slice(chunk);
        if self.format.is_none() {
            self.sniff_format()?;
        }
        Ok(())
    }

    /// No more input is coming; release the trailing record.
    pub fn finalize(&mut self) {
        self.finalized = true;
    }

    /// Bytes buffered awaiting a record boundary — the UI's "stuck, or mid-record?"
    /// signal.
    pub fn pending_bytes(&self) -> usize {
        self.pending.len() - self.consumed
    }

    fn compact(&mut self) {
        // Only pay the copy once the dead prefix is worth reclaiming.
        if self.consumed > 0 && self.consumed >= self.pending.len() / 2 {
            self.pending.drain(..self.consumed);
            self.consumed = 0;
        }
    }

    fn sniff_format(&mut self) -> Result<(), String> {
        for &b in &self.pending[self.consumed..] {
            match b {
                b'>' => {
                    self.format = Some(Format::Fasta);
                    return Ok(());
                }
                b'@' => {
                    self.format = Some(Format::Fastq);
                    return Ok(());
                }
                // Leading whitespace is tolerated; anything else is not a sequence file.
                b' ' | b'\t' | b'\r' | b'\n' => continue,
                _ => {
                    return Err(
                        "query input is not FASTA (starts with '>') or FASTQ (starts with '@')"
                            .to_string(),
                    );
                }
            }
        }
        // Only whitespace so far — wait for more bytes.
        Ok(())
    }

    pub fn next_record(&mut self) -> Result<Option<QueryRecord>, String> {
        match self.format {
            Some(Format::Fastq) => self.next_fastq(),
            Some(Format::Fasta) => self.next_fasta(),
            None => Ok(None),
        }
    }

    /// FASTQ: exactly four lines per record. Sequence wrapping is not supported, which
    /// matches rammap's own parser and every FASTQ emitted by real instruments.
    fn next_fastq(&mut self) -> Result<Option<QueryRecord>, String> {
        let buf = &self.pending[self.consumed..];
        if buf.is_empty() {
            return Ok(None);
        }

        let mut starts = [0usize; 4];
        let mut pos = 0usize;
        for (i, slot) in starts.iter_mut().enumerate() {
            *slot = pos;
            match memchr(b'\n', &buf[pos..]) {
                Some(off) => pos += off + 1,
                None => {
                    if !self.finalized {
                        return Ok(None); // incomplete record; wait for more bytes
                    }
                    // At EOF a final line without a trailing newline is still valid,
                    // but a record short of four lines is not.
                    if i < 3 || buf[pos..].is_empty() {
                        return Err(format!(
                            "truncated FASTQ record at end of input ({} of 4 lines)",
                            i + if buf[pos..].is_empty() { 0 } else { 1 }
                        ));
                    }
                    pos = buf.len();
                    break;
                }
            }
        }

        let line = |start: usize, end: usize| trim_eol(&buf[start..end]);
        let header = line(starts[0], starts[1]);
        let seq = line(starts[1], starts[2]);
        let qual = line(starts[3], pos.min(buf.len()));

        if header.first() != Some(&b'@') {
            return Err("malformed FASTQ: record does not start with '@'".to_string());
        }
        if seq.len() != qual.len() {
            return Err(format!(
                "malformed FASTQ record '{}': sequence is {} bases but quality is {}",
                String::from_utf8_lossy(&header[1..]),
                seq.len(),
                qual.len()
            ));
        }

        let (name, comment) = split_header(&header[1..]);
        let record = QueryRecord {
            name,
            comment,
            seq: seq.to_vec(),
            qual: Some(String::from_utf8_lossy(qual).into_owned()),
        };
        self.consumed += pos;
        Ok(Some(record))
    }

    /// FASTA: `\n>`-delimited, sequence accumulated across any number of lines.
    fn next_fasta(&mut self) -> Result<Option<QueryRecord>, String> {
        let buf = &self.pending[self.consumed..];
        if buf.is_empty() {
            return Ok(None);
        }

        // Find the end of this record: the next line that begins with '>'.
        let mut end = None;
        let mut search = 0usize;
        while let Some(off) = memchr(b'\n', &buf[search..]) {
            let next_line = search + off + 1;
            if buf.get(next_line) == Some(&b'>') {
                end = Some(next_line);
                break;
            }
            search = next_line;
        }

        let end = match end {
            Some(e) => e,
            None if self.finalized => buf.len(),
            // The next record may start in a chunk we have not seen yet.
            None => return Ok(None),
        };

        let record_bytes = &buf[..end];
        let header_end = memchr(b'\n', record_bytes).unwrap_or(record_bytes.len());
        let header = trim_eol(&record_bytes[..header_end]);
        if header.first() != Some(&b'>') {
            return Err("malformed FASTA: record does not start with '>'".to_string());
        }

        let mut seq = Vec::new();
        let mut pos = header_end;
        while pos < record_bytes.len() {
            let line_end = memchr(b'\n', &record_bytes[pos..])
                .map(|o| pos + o)
                .unwrap_or(record_bytes.len());
            seq.extend_from_slice(trim_eol(&record_bytes[pos..line_end]));
            pos = line_end + 1;
        }

        let (name, comment) = split_header(&header[1..]);
        let record = QueryRecord { name, comment, seq, qual: None };
        self.consumed += end;
        Ok(Some(record))
    }
}

fn trim_eol(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && (line[end - 1] == b'\n' || line[end - 1] == b'\r') {
        end -= 1;
    }
    &line[..end]
}

/// Split a header into the read name and the optional trailing description, on the
/// first run of whitespace — the same convention samtools and minimap2 use.
fn split_header(header: &[u8]) -> (String, Option<String>) {
    let text = String::from_utf8_lossy(header);
    match text.find(|c: char| c == ' ' || c == '\t') {
        Some(i) => {
            let comment = text[i + 1..].trim_start();
            (
                text[..i].to_string(),
                (!comment.is_empty()).then(|| comment.to_string()),
            )
        }
        None => (text.into_owned(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect_at(data: &[u8], chunk: usize) -> Vec<(String, Vec<u8>, Option<String>)> {
        let mut p = QueryParser::new();
        let mut out = Vec::new();
        for part in data.chunks(chunk.max(1)) {
            p.push(part).unwrap();
            while let Some(r) = p.next_record().unwrap() {
                out.push((r.name, r.seq, r.qual));
            }
        }
        p.finalize();
        while let Some(r) = p.next_record().unwrap() {
            out.push((r.name, r.seq, r.qual));
        }
        out
    }

    /// Chunk-boundary off-by-ones are the main hazard in a parser like this, so the
    /// record stream must be identical however the bytes are split.
    fn assert_chunk_invariant(data: &[u8], expected: usize) {
        let whole = collect_at(data, data.len());
        assert_eq!(whole.len(), expected, "record count from a single chunk");
        for size in [1usize, 2, 3, 7, 13, 64, 4096] {
            assert_eq!(collect_at(data, size), whole, "chunk size {size} diverged");
        }
    }

    #[test]
    fn fastq_keeps_quality_across_chunk_sizes() {
        let data = b"@r1 desc here\nACGTACGT\n+\nIIIIIIII\n@r2\nTTTT\n+\n!!!!\n";
        assert_chunk_invariant(data, 2);
        let recs = collect_at(data, data.len());
        assert_eq!(recs[0].0, "r1");
        assert_eq!(recs[0].2.as_deref(), Some("IIIIIIII"));
        assert_eq!(recs[1].2.as_deref(), Some("!!!!"));
    }

    #[test]
    fn fasta_joins_wrapped_sequence_lines() {
        let data = b">chr1 first\nACGT\nACGT\n>chr2\nTTTT\n";
        assert_chunk_invariant(data, 2);
        let recs = collect_at(data, data.len());
        assert_eq!(recs[0].1, b"ACGTACGT");
        assert_eq!(recs[0].2, None);
    }

    #[test]
    fn tolerates_crlf_and_missing_final_newline() {
        assert_chunk_invariant(b">a\r\nACGT\r\n>b\r\nTT", 2);
        assert_chunk_invariant(b"@a\nACGT\n+\nIIII\n@b\nTT\n+\n!!", 2);
    }

    #[test]
    fn rejects_mismatched_quality_length() {
        let mut p = QueryParser::new();
        p.push(b"@r1\nACGT\n+\nII\n").unwrap();
        assert!(p.next_record().is_err());
    }

    #[test]
    fn rejects_non_sequence_input() {
        let mut p = QueryParser::new();
        assert!(p.push(b"this is not a sequence file").is_err());
    }
}
