<template>
    <div class="panel">
        <div class="row">
            <div style="flex:1; min-width:16rem">
                <div class="drop" :class="{ set: refFile, over: overRef }" tabindex="0"
                     @click="refInput?.click()" @keydown.enter.prevent="refInput?.click()"
                     @dragover.prevent="overRef = true" @dragleave="overRef = false"
                     @drop.prevent="onDropRef">
                    <strong>Reference</strong><br>
                    <template v-if="refFile">{{ refFile.name }} ({{ mb(refFile.size) }})</template>
                    <template v-else>FASTA, or a prebuilt <code>.rmi</code> index</template>
                </div>
                <input ref="refInput" type="file" hidden accept=".fa,.fasta,.fna,.gz,.rmi"
                       @change="onPickRef">
            </div>
            <div style="flex:1; min-width:16rem">
                <div class="drop" :class="{ set: queryFile, over: overQuery }" tabindex="0"
                     @click="queryInput?.click()" @keydown.enter.prevent="queryInput?.click()"
                     @dragover.prevent="overQuery = true" @dragleave="overQuery = false"
                     @drop.prevent="onDropQuery">
                    <strong>Reads</strong><br>
                    <template v-if="queryFile">{{ queryFile.name }} ({{ mb(queryFile.size) }})</template>
                    <template v-else>FASTA or FASTQ, optionally gzipped</template>
                </div>
                <input ref="queryInput" type="file" hidden accept=".fa,.fasta,.fna,.fq,.fastq,.gz"
                       @change="onPickQuery">
            </div>
        </div>
        <p v-if="sizeWarning" class="note warn">{{ sizeWarning }}</p>
        <div v-if="indexInfo" class="row" style="margin-top:.75rem">
            <span class="note ok">
                Index {{ results.indexSource }}: k={{ indexInfo.k }} w={{ indexInfo.w }},
                {{ indexInfo.nSeqs }} sequence(s), {{ indexInfo.totalBases.toLocaleString() }} bases
            </span>
            <button class="secondary" :disabled="savingIndex" @click="onSaveIndex">
                Save index (.rmi)
            </button>
        </div>
    </div>

    <div class="panel">
        <div class="row">
            <label>Preset
                <select v-model="opts.preset">
                    <option v-for="p in presets" :key="p" :value="p">{{ p }}</option>
                </select>
            </label>
            <label>Output
                <select v-model="format">
                    <option value="paf">PAF</option>
                    <option value="sam">SAM</option>
                </select>
            </label>
            <label>k <span class="note">(0 = preset)</span>
                <input v-model.number="opts.k" type="number" min="0" max="28" style="width:5rem">
            </label>
            <label>w <span class="note">(0 = preset)</span>
                <input v-model.number="opts.w" type="number" min="0" style="width:5rem">
            </label>
            <label>DP cache MB
                <input v-model.number="dpCacheMb" type="number" min="0" style="width:6rem">
            </label>
        </div>
        <div class="checks" style="margin-top:.75rem">
            <label><input v-model="opts.cigar" type="checkbox"> CIGAR</label>
            <label><input v-model="opts.cs" type="checkbox"> cs tag</label>
            <label><input v-model="opts.md" type="checkbox"> MD tag</label>
            <label><input v-model="opts.eqx" type="checkbox"> =/X CIGAR</label>
            <label><input v-model="opts.copyComment" type="checkbox"> copy comments</label>
        </div>
        <p class="note" style="margin:.75rem 0 0">
            The occurrence cap during index construction is uncapped, matching the CLI.
            rammap's own web demo hardcodes 50&nbsp;000, which changes output on repetitive
            references. Changing preset or output format re-maps without rebuilding the index.
        </p>
    </div>

    <div class="panel">
        <div class="row">
            <button :disabled="!canRun || !refFile || !queryFile" @click="onRun">Map reads</button>
            <button v-if="running" class="secondary" @click="onCancel">Stop</button>
            <button v-if="showForceStop" class="danger" @click="onForceStop">Force stop</button>
            <button v-if="downloadable" class="secondary" @click="onDownload">Download output</button>
            <span class="note">{{ results.status }}</span>
        </div>
        <progress v-if="running" :max="100" :value="progressPercent" />
        <pre v-if="results.log.length" class="log" style="margin-top:.75rem">{{ results.log.join("\n") }}</pre>
        <p v-if="results.error" class="note warn">{{ results.error }}</p>
    </div>

    <div v-if="result" class="panel">
        <div class="row" style="justify-content:space-between">
            <strong>
                {{ result.stats.mapped.toLocaleString() }} of
                {{ result.stats.reads.toLocaleString() }} reads mapped in
                {{ result.seconds.toFixed(1) }}s — {{ mb(result.outputBytes) }} of output
                <template v-if="result.cancelled"> (stopped early)</template>
            </strong>
            <span class="note">{{ previewNote }}</span>
        </div>
        <pre style="margin-top:.5rem">{{ result.preview }}</pre>
    </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useStore } from "vuex";
import { canPickSaveFile, pickSaveFile, triggerDownload } from "@/platform/files";
import type { RootState } from "@/store";

const store = useStore<RootState>();

const refInput = ref<HTMLInputElement | null>(null);
const queryInput = ref<HTMLInputElement | null>(null);
const overRef = ref(false);
const overQuery = ref(false);
const refFile = ref<File | null>(null);
const queryFile = ref<File | null>(null);
const format = ref<"paf" | "sam">("paf");
const dpCacheMb = ref(128);
const showForceStop = ref(false);
let forceStopTimer: ReturnType<typeof setTimeout> | undefined;
let outputName = "alignments.paf";

const opts = reactive({
    preset: "map-ont",
    k: 0,
    w: 0,
    cigar: true,
    cs: false,
    md: false,
    eqx: false,
    copyComment: false,
});

const results = computed(() => store.state.allResults_rammap);
const presets = computed(() => store.state.presets);
const indexInfo = computed(() => results.value.indexInfo);
const result = computed(() => results.value.result);
const running = computed(() => store.state.processingState.isRunning);
const savingIndex = computed(() => store.state.processingState.isSavingIndex);
const canRun = computed(() => store.getters.canRun);

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const progressPercent = computed(() => {
    const p = results.value.progress;
    return p && p.total ? (p.completed / p.total) * 100 : undefined;
});

const downloadable = computed(() => !!result.value?.blob);
const previewNote = computed(() => {
    if (!result.value) return "";
    const base = result.value.savedToFile ? `written to ${outputName}` : "ready to download";
    return result.value.truncated ? `${base} — preview truncated, full output is complete` : base;
});

/**
 * wasm32 caps linear memory at 4 GB, and the minimizer table dominates at roughly
 * 2.5-3 bytes per reference base, so warn well before the trap rather than letting the
 * user discover it as "unreachable executed".
 */
const sizeWarning = computed(() => {
    const f = refFile.value;
    if (!f || f.name.endsWith(".rmi")) return "";
    const bases = f.name.endsWith(".gz") ? f.size * 4 : f.size;
    if (bases > 1e9) {
        return `This reference is roughly ${(bases / 1e9).toFixed(1)} Gb. wasm32 caps memory at ` +
            `4 GB and the index needs ~2.5-3 bytes per base, so indexing will probably fail. ` +
            `Use the native rammap CLI instead.`;
    }
    if (bases > 5e8) {
        return `This reference is large (~${(bases / 1e6).toFixed(0)} Mb). Indexing may approach ` +
            `the 4 GB wasm memory cap.`;
    }
    return "";
});

function setRef(file: File) {
    refFile.value = file;
    // A new reference invalidates the index cached in the worker.
    store.dispatch("newReference");
}

const onPickRef = (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) setRef(f);
};
const onPickQuery = (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) queryFile.value = f;
};
const onDropRef = (e: DragEvent) => {
    overRef.value = false;
    const f = e.dataTransfer?.files[0];
    if (f) setRef(f);
};
const onDropQuery = (e: DragEvent) => {
    overQuery.value = false;
    const f = e.dataTransfer?.files[0];
    if (f) queryFile.value = f;
};

async function onRun() {
    if (!queryFile.value) return;
    const sam = format.value === "sam";
    const base = queryFile.value.name.replace(/\.gz$/, "").replace(/\.(fa|fasta|fna|fq|fastq)$/, "");
    outputName = `${base}.${sam ? "sam" : "paf"}`;

    // The picker needs transient user activation and is not exposed in workers, so it
    // must be called here, inside the click handler.
    const fileHandle = await pickSaveFile(outputName, "Alignments", [".paf", ".sam"]);

    store.dispatch("runRammap", {
        refFile: refFile.value,
        queryFile: queryFile.value,
        opts: { ...opts, outputSam: sam, indexMaxOcc: 0 },
        dpCacheMb: dpCacheMb.value,
        fileHandle,
    });
}

async function onSaveIndex() {
    const name = (refFile.value?.name ?? "reference").replace(/\.(fa|fasta|fna)(\.gz)?$/, "") + ".rmi";
    const fileHandle = await pickSaveFile(name, "rammap index", [".rmi"]);
    store.dispatch("saveIndex", { name, fileHandle });
}

function onCancel() {
    store.dispatch("cancelRammap");
    // A soft cancel is only observed between chunks, and one pathological read can hold
    // the worker for seconds. Offer the hard exit once waiting has clearly gone on.
    forceStopTimer = setTimeout(() => { showForceStop.value = true; }, 3000);
}

function onForceStop() {
    store.dispatch("forceStopRammap");
    showForceStop.value = false;
}

function onDownload() {
    if (result.value?.blob) triggerDownload(result.value.blob, outputName);
}

// The store owns state; the download side effects live here, where the DOM is.
watch(result, (r) => {
    clearTimeout(forceStopTimer);
    showForceStop.value = false;
    if (r && !r.savedToFile && !canPickSaveFile() && r.blob) {
        // No picker in this browser, so the file never reached disk during the run.
        // Hand it over immediately rather than making the user hunt for a button.
        triggerDownload(r.blob, outputName);
    }
});

store.subscribeAction((action) => {
    if (action.type === "handleIndexSaved") {
        const payload = action.payload as { savedToFile: boolean; blob?: Blob; name: string };
        if (!payload.savedToFile && payload.blob) triggerDownload(payload.blob, payload.name);
    }
});
</script>
