// Save/download helpers.
//
// Adapted from sparrowhawk's www/src/platform/files.ts, minus the Electron IPC branch
// (there is no desktop wrapper here yet). The File System Access branch is the
// addition: it streams to disk instead of materialising the whole output as a Blob.

/** Anchor + object URL: the universal fallback. */
export function triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}

/**
 * Whether this browser can stream output straight to a file the user picks.
 *
 * Chromium desktop only as of 2026: Firefox and Safari implement OPFS but not
 * showSaveFilePicker, and Chrome on Android does not have it. Everything still works
 * without it, via triggerDownload.
 */
export function canPickSaveFile(): boolean {
    return typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

/**
 * Ask for an output file. Must be called from a user gesture: the picker needs
 * transient activation, and it is not exposed in workers — which is why the resulting
 * handle is postMessage'd to the worker rather than opened there.
 *
 * Returns undefined if unsupported or dismissed, meaning "fall back to a download".
 */
export async function pickSaveFile(
    suggestedName: string,
    description: string,
    extensions: string[],
): Promise<FileSystemFileHandle | undefined> {
    if (!canPickSaveFile()) return undefined;
    const picker = (window as unknown as {
        showSaveFilePicker: (o: object) => Promise<FileSystemFileHandle>;
    }).showSaveFilePicker;
    try {
        return await picker({
            suggestedName,
            types: [{ description, accept: { "application/octet-stream": extensions } }],
        });
    } catch {
        return undefined;
    }
}
