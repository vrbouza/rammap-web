// Result and state shapes, mirroring sparrowhawk's www/src/types.ts.

export interface RammapIndexInfo {
    k: number;
    w: number;
    hpc: boolean;
    nSeqs: number;
    totalBases: number;
    hasSequences: boolean;
}

export interface RammapResult {
    stats: { reads: number; mapped: number; bases: number };
    outputBytes: number;
    seconds: number;
    savedToFile: boolean;
    cancelled: boolean;
    preview: string;
    truncated: boolean;
    blob: Blob | null;
    outputName: string;
}

export interface AllResultsRammap {
    indexInfo: RammapIndexInfo | null;
    indexSource: string | null;
    indexLoaded: boolean;
    result: RammapResult | null;
    error: string | null;
    log: string[];
    status: string;
    progress: { completed: number; total: number } | null;
}

export interface ProcessingStateRammap {
    isRunning: boolean;
    isSavingIndex: boolean;
}

/** Mapping options as sent to the worker. Lives here rather than in the worker module
 *  because workers.d.ts declares that specifier as a bare Worker constructor, which
 *  exports no types. */
export interface OptsPayload {
    preset: string;
    outputSam: boolean;
    cigar: boolean;
    cs: boolean;
    md: boolean;
    eqx: boolean;
    copyComment: boolean;
    indexMaxOcc: number;
    k: number;
    w: number;
}
