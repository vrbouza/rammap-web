// Vuex store, sliced the way sparrowhawk slices its per-tool state: one
// allResults_<tool> object, one processing-state object, and all worker messaging in
// actions.
//
// Kept in a single file because there is one tool here; splitting into
// state/getters/mutations/actions modules is the sparrowhawk layout and is the obvious
// change if more tools land alongside.

import { createStore } from "vuex";
import type { ActionContext } from "vuex";
import type { AllResultsRammap, OptsPayload, ProcessingStateRammap, RammapResult } from "@/types";
import WorkerRammap from "@/workers/RammapAligner.worker";

/** Vuex does not infer the context inside a plain object literal, so annotate it. */
type Ctx = ActionContext<RootState, RootState>;

export interface RootState {
    allResults_rammap: AllResultsRammap;
    processingState: ProcessingStateRammap;
    workerState: { worker_rammap: Worker | null };
    ready: boolean;
    version: string;
    presets: string[];
}

function emptyResults(): AllResultsRammap {
    return {
        indexInfo: null,
        indexSource: null,
        indexLoaded: false,
        result: null,
        error: null,
        log: [],
        status: "Loading the wasm module…",
        progress: null,
    };
}

export const store = createStore<RootState>({
    state: (): RootState => ({
        allResults_rammap: emptyResults(),
        processingState: { isRunning: false, isSavingIndex: false },
        workerState: { worker_rammap: null },
        ready: false,
        version: "",
        presets: [],
    }),

    getters: {
        indexLoaded: (s: RootState) => s.allResults_rammap.indexLoaded,
        isRunning: (s: RootState) => s.processingState.isRunning,
        canRun: (s: RootState) => s.ready && !s.processingState.isRunning,
    },

    mutations: {
        SET_WORKER_RAMMAP(state: RootState, worker: Worker) {
            state.workerState.worker_rammap = worker;
        },
        setReady(state: RootState, payload: { version: string; presets: string[] }) {
            state.ready = true;
            state.version = payload.version;
            state.presets = payload.presets;
            state.allResults_rammap.status = `rammap ${payload.version} ready`;
        },
        appendLog(state: RootState, line: string) {
            state.allResults_rammap.log.push(line);
        },
        setStatus(state: RootState, text: string) {
            state.allResults_rammap.status = text;
        },
        setProgress(state: RootState, p: { completed: number; total: number } | null) {
            state.allResults_rammap.progress = p;
        },
        setIndex(state: RootState, payload: { info: AllResultsRammap["indexInfo"]; source: string }) {
            state.allResults_rammap.indexInfo = payload.info;
            state.allResults_rammap.indexSource = payload.source;
            state.allResults_rammap.indexLoaded = true;
        },
        clearIndex(state: RootState) {
            state.allResults_rammap.indexInfo = null;
            state.allResults_rammap.indexSource = null;
            state.allResults_rammap.indexLoaded = false;
        },
        setRunning(state: RootState, running: boolean) {
            state.processingState.isRunning = running;
        },
        setSavingIndex(state: RootState, saving: boolean) {
            state.processingState.isSavingIndex = saving;
        },
        saveResult(state: RootState, result: RammapResult) {
            state.allResults_rammap.result = result;
        },
        setError(state: RootState, message: string) {
            state.allResults_rammap.error = message;
        },
        clearRun(state: RootState) {
            state.allResults_rammap.result = null;
            state.allResults_rammap.error = null;
            state.allResults_rammap.log = [];
            state.allResults_rammap.progress = null;
        },
        resetAllResults_rammap(state: RootState) {
            const status = state.allResults_rammap.status;
            state.allResults_rammap = emptyResults();
            state.allResults_rammap.status = status;
            state.processingState = { isRunning: false, isSavingIndex: false };
        },
    },

    actions: {
        initWorker({ commit, dispatch, state }: Ctx) {
            if (!window.Worker) throw new Error("Web Workers are not supported by this browser.");
            const worker = new WorkerRammap();
            worker.onmessage = (msg) => dispatch("onWorkerMessage", msg.data);
            commit("SET_WORKER_RAMMAP", worker);
            worker.postMessage({ init: true });
            return state.workerState.worker_rammap;
        },

        /** Replace the worker. A Rust panic poisons the module, so it cannot be reused. */
        respawnWorker({ commit, dispatch, state }: Ctx) {
            state.workerState.worker_rammap?.terminate();
            commit("clearIndex");
            commit("setRunning", false);
            dispatch("initWorker");
        },

        onWorkerMessage({ commit, dispatch }: Ctx, d: Record<string, any>) {
            if (d.ready) {
                commit("setReady", { version: d.version, presets: d.presets });
                return;
            }
            if (d.log) {
                commit("appendLog", d.log);
                return;
            }
            if (d.indexReady) {
                commit("setIndex", { info: d.indexReady.info, source: d.indexReady.source });
                return;
            }
            if (d.indexSaved) {
                commit("setSavingIndex", false);
                dispatch("handleIndexSaved", d.indexSaved);
                return;
            }
            // Two progress sources: the worker's byte counters, and the bridge's own
            // postMessage from inside Rust (phase transitions, per-record counts).
            if (d.progress) {
                commit("setProgress", { completed: d.progress.completed, total: d.progress.total });
                return;
            }
            if (d.rammapProgress) {
                if (d.detail) commit("setStatus", `${d.phase}: ${d.detail}`);
                return;
            }
            if (d.cancelledBeforeStart) {
                commit("setRunning", false);
                commit("setStatus", "Stopped");
                return;
            }
            if (d.error) {
                commit("setRunning", false);
                commit("setSavingIndex", false);
                commit("setError", d.error);
                commit("setStatus", "Failed");
                if (d.fatal) {
                    commit("appendLog", "Restarting the worker; the index was discarded.");
                    dispatch("respawnWorker");
                }
                return;
            }
            if (d.done) {
                commit("setRunning", false);
                commit("setProgress", null);
                commit("setStatus", d.done.cancelled ? "Stopped" : "Done");
                commit("saveResult", d.done);
                dispatch("handleResult", d.done);
            }
        },

        // Filled in by the page, which owns the download side effects.
        handleResult(_ctx: Ctx) { /* overridden via subscribeAction in the page */ },
        handleIndexSaved(_ctx: Ctx) { /* overridden via subscribeAction in the page */ },

        runRammap({ commit, state }: Ctx, payload: {
            refFile: File | null;
            queryFile: File;
            opts: OptsPayload;
            dpCacheMb: number;
            fileHandle?: FileSystemFileHandle;
        }) {
            const worker = state.workerState.worker_rammap;
            if (!worker) return;
            commit("clearRun");
            commit("setRunning", true);

            // Posted as two messages; the worker serialises them through its own job
            // queue, so the map never starts before the index exists.
            if (!state.allResults_rammap.indexLoaded && payload.refFile) {
                worker.postMessage({ buildIndex: true, file: payload.refFile, opts: payload.opts });
            }
            worker.postMessage({
                map: true,
                queryFile: payload.queryFile,
                opts: payload.opts,
                dpCacheMb: payload.dpCacheMb,
                fileHandle: payload.fileHandle,
            });
        },

        saveIndex({ commit, state }: Ctx, payload: { name: string; fileHandle?: FileSystemFileHandle }) {
            const worker = state.workerState.worker_rammap;
            if (!worker) return;
            commit("setSavingIndex", true);
            worker.postMessage({ saveIndex: true, name: payload.name, fileHandle: payload.fileHandle });
        },

        cancelRammap({ commit, state }: Ctx) {
            state.workerState.worker_rammap?.postMessage({ cancel: true });
            commit("setStatus", "Stopping at the next chunk boundary…");
        },

        /**
         * The only true mid-chunk abort available without SharedArrayBuffer. It
         * destroys the wasm instance, so the index is lost and must be rebuilt.
         */
        forceStopRammap({ commit, dispatch }: Ctx) {
            commit("appendLog", "Worker terminated. The index was discarded and must be rebuilt.");
            commit("setStatus", "Force stopped");
            dispatch("respawnWorker");
        },

        newReference({ commit, state }: Ctx) {
            commit("clearIndex");
            state.workerState.worker_rammap?.postMessage({ reset: true });
        },
    },
});

export default store;
