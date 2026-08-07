// Thin message router, following sparrowhawk's two-file worker convention: this file
// only dispatches, and RammapAligner.ts holds the wasm handle and the logic.
//
// Messages are duck-typed on the presence of a boolean flag key, as in sparrowhawk's
// Depleter.worker.ts.

import { RammapAligner } from "./RammapAligner";
import type { OptsPayload } from "@/types";

interface InitMessage { init: true }
interface BuildIndexMessage { buildIndex: true; file: File; opts: OptsPayload }
interface LoadIndexMessage { loadIndex: true; file: File }
interface SaveIndexMessage { saveIndex: true; name: string; fileHandle?: FileSystemFileHandle }
interface MapMessage {
    map: true;
    queryFile: File;
    opts: OptsPayload;
    dpCacheMb?: number;
    fileHandle?: FileSystemFileHandle;
}
interface CancelMessage { cancel: true }
interface ResetMessage { reset: true }

type WorkerMessage =
    | InitMessage | BuildIndexMessage | LoadIndexMessage
    | SaveIndexMessage | MapMessage | CancelMessage | ResetMessage;

const ctx: Worker = self as unknown as Worker;
const aligner = new RammapAligner(ctx);

// Jobs run one at a time, in arrival order.
//
// This queue is load-bearing, not tidiness: an async message handler does NOT delay
// delivery of the next message, so a page posting {buildIndex} then {map} back to back
// would otherwise start both concurrently and map before an index existed.
let queue: Promise<void> = Promise.resolve();

ctx.onmessage = (evt: MessageEvent<WorkerMessage>) => {
    const data = evt.data;
    if (!(data instanceof Object)) return;

    // Deliberately outside the queue: a cancel must affect the job already running,
    // not the one after it. It is cheap and synchronous, so there is nothing to
    // serialise.
    if ("cancel" in data && data.cancel) {
        aligner.cancel();
        return;
    }

    queue = queue
        .then(() => {
            if ("init" in data && data.init) return aligner.initWasm();
            if ("reset" in data && data.reset) return aligner.resetAll();
            if ("buildIndex" in data && data.buildIndex) return aligner.buildIndex(data.file, data.opts);
            if ("loadIndex" in data && data.loadIndex) return aligner.loadIndex(data.file);
            if ("saveIndex" in data && data.saveIndex) return aligner.saveIndex(data.fileHandle, data.name);
            if ("map" in data && data.map) return aligner.map(data);
            return undefined;
        })
        .catch((err) => aligner.reportError(err));
};
