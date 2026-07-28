// Helpers for preparing telemetry file uploads.
//
// ACC MoTeC exports come as a pair: the binary log (.ld) plus a sibling lap-index
// file (.ldx) that carries the lap-boundary beacons. Without the .ldx a multi-lap
// stint collapses into a single lap, so when the user selects both we pair them
// and send the .ldx as the .ld's sidecar. A standalone .ldx is not a session and
// is dropped from the upload set.

export interface UploadItem {
    file: File;
    sidecar: File | null;
}

const baseStem = (name: string): string => name.replace(/\.[^.]+$/, '').toLowerCase();
const hasExt = (name: string, ext: string): boolean => name.toLowerCase().endsWith(ext);

/**
 * Pair each importable file with its matching `.ldx` sidecar (by base name).
 * `.ldx` files are consumed as sidecars and never uploaded on their own.
 */
export function pairTelemetryUploads(files: File[]): UploadItem[] {
    const sidecars = new Map<string, File>();
    for (const f of files) {
        if (hasExt(f.name, '.ldx')) sidecars.set(baseStem(f.name), f);
    }

    const items: UploadItem[] = [];
    for (const f of files) {
        if (hasExt(f.name, '.ldx')) continue; // consumed as a sidecar below
        const sidecar = hasExt(f.name, '.ld') ? sidecars.get(baseStem(f.name)) ?? null : null;
        items.push({ file: f, sidecar });
    }
    return items;
}
