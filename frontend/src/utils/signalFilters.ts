/**
 * Shift-artefact removal for the throttle trace.
 *
 * A paddle-shift car cuts ignition for the upshift and blips for the downshift,
 * so the logged throttle channel is full of 50-150ms notches the driver never
 * asked for. At lap scale they swamp the trace and hide the real pedal work.
 *
 * Rather than smoothing (which would round off genuine pedal edges), the filter
 * looks only at the neighbourhood of an actual gear change and bridges an
 * excursion there when it carries every signature of an engine cut:
 *
 *   - it recovers fast enough to be a cut, not a lift (`maxCutSeconds`);
 *   - both its edges are near-vertical (`maxEdgeSeconds`) -- an ankle cannot
 *     move a pedal that fast, an ignition cut is instant;
 *   - it comes back to the level it left from (`shoulderTolerance`), and that
 *     level is one the trace actually settles at rather than a passing peak,
 *     which is what makes it an interruption rather than a change of intent.
 *
 * Anything failing a test is left bit-identical: a real lift into a downshift, a
 * mid-corner stab, throttle modulation on exit. Bridged dips are clamped so they
 * can only ever raise the trace, and blips only lower it, so the filter can
 * never invent or erase pedal application beyond the notch it targets.
 *
 * Cost is O(n + shifts x window): tens of microseconds for a full lap.
 */

export interface ShiftCutOptions {
    /** Longest excursion still treated as a shift artefact, in seconds. */
    maxCutSeconds?: number;
    /** Longest rise/fall still treated as an instant cut, in seconds. */
    maxEdgeSeconds?: number;
    /** Excursion must be at least this deep/tall, in throttle %. */
    minDepth?: number;
    /** How far the level either side of the excursion may differ, in throttle %. */
    shoulderTolerance?: number;
    /** Brake % above which a spike counts as a downshift blip. */
    blipBrakeThreshold?: number;
}

const DEFAULTS: Required<ShiftCutOptions> = {
    maxCutSeconds: 0.15,
    maxEdgeSeconds: 0.05,
    minDepth: 8,
    shoulderTolerance: 12,
    blipBrakeThreshold: 40,
};

/** Throttle % either side of the floor still counted as part of the cut. */
const FLOOR_TOLERANCE = 2;
/** Samples the trace must hold a level for it to count as a shoulder. */
const PLATEAU_SAMPLES = 3;

/** Mean sample interval; NaN when the time channel is unusable. */
const sampleInterval = (time: Float64Array): number => {
    const n = time.length;
    if (n < 2) return NaN;
    const span = time[n - 1] - time[0];
    return Number.isFinite(span) && span > 0 ? span / (n - 1) : NaN;
};

export const smoothShiftCuts = (
    throttle: Float64Array,
    gear: Float64Array | null | undefined,
    time: Float64Array | null | undefined,
    brake?: Float64Array | null,
    opts: ShiftCutOptions = {},
): Float64Array => {
    const n = throttle.length;
    if (!gear || !time || gear.length !== n || time.length !== n || n < 8) return throttle;

    const cfg = { ...DEFAULTS, ...opts };
    const dt = sampleInterval(time);
    if (!Number.isFinite(dt) || dt <= 0) return throttle;

    const maxWidth = Math.max(2, Math.round(cfg.maxCutSeconds / dt));
    const maxEdge = Math.max(1, Math.round(cfg.maxEdgeSeconds / dt));
    // Search a little past the widest artefact so its shoulders are in range.
    const pad = maxWidth + maxEdge;
    const hasBrake = !!brake && brake.length === n;

    let out: Float64Array | null = null;

    /**
     * Try to bridge one excursion around the gear change at `k`.
     * `dip` selects a downward notch (upshift cut) or an upward one (blip).
     */
    const bridge = (k: number, dip: boolean) => {
        const lo = Math.max(0, k - pad);
        const hi = Math.min(n - 1, k + pad);

        // Floor of the excursion: the most extreme sample beside the shift,
        // widened across the flat bottom the cut holds.
        let m = -1;
        let extreme = NaN;
        for (let i = lo; i <= hi; i++) {
            const v = throttle[i];
            if (Number.isNaN(v)) continue;
            if (m === -1 || (dip ? v < extreme : v > extreme)) { extreme = v; m = i; }
        }
        if (m === -1) return;
        let mL = m;
        while (mL > lo && Math.abs(throttle[mL - 1] - extreme) <= FLOOR_TOLERANCE) mL--;
        let mR = m;
        while (mR < hi && Math.abs(throttle[mR + 1] - extreme) <= FLOOR_TOLERANCE) mR++;

        /**
         * Walk out of the excursion to the level the trace recovers to, and
         * report whether it actually settles there.
         *
         * Settling is what separates a cut from noise: an upshift interrupts a
         * throttle position the driver was already holding and hands it back to
         * the same place. A momentary peak that immediately falls away again --
         * the gap between two downshift blips, say -- never settles, and is left
         * alone.
         */
        const shoulder = (from: number, dir: -1 | 1) => {
            let best = from;
            let i = from;
            let flat = 0;
            while (true) {
                const j = i + dir;
                if (j < lo || j > hi) break;
                const v = throttle[j];
                if (Number.isNaN(v)) break;
                if (dip ? v > throttle[best] + 0.5 : v < throttle[best] - 0.5) {
                    best = j;
                    flat = 0;
                } else if (Math.abs(v - throttle[best]) <= cfg.shoulderTolerance) {
                    if (++flat >= PLATEAU_SAMPLES) break;
                } else {
                    break; // turned away again -- never a stable level
                }
                i = j;
            }
            return { idx: best, settled: flat >= PLATEAU_SAMPLES };
        };

        const left = shoulder(mL, -1);
        const right = shoulder(mR, 1);
        if (!left.settled || !right.settled) return;

        const a = left.idx;
        const b = right.idx;
        if (a === mL || b === mR) return;

        const from = throttle[a];
        const to = throttle[b];
        const depth = dip ? Math.min(from, to) - extreme : extreme - Math.max(from, to);

        // A cut interrupts the throttle and hands it straight back; anything
        // that changes level, takes too long, or eases in is the driver.
        if (b - a > maxWidth) return;
        if (depth < cfg.minDepth) return;
        if (Math.abs(from - to) > cfg.shoulderTolerance) return;

        // Edges: an ignition cut is instant, an ankle is not. A blip's tail is
        // the engine coming back down, so it may decay more slowly than it rose.
        const edgeAllowance = dip ? maxEdge : maxEdge * 2;
        if (mL - a > maxEdge || b - mR > edgeAllowance) return;

        // Bridge the notch, clamped so a dip can only raise and a blip only lower.
        if (!out) out = new Float64Array(throttle);
        const span = b - a;
        for (let i = a + 1; i < b; i++) {
            const lerp = from + ((to - from) * (i - a)) / span;
            out[i] = dip ? Math.max(throttle[i], lerp) : Math.min(throttle[i], lerp);
        }
    };

    // Logs pass through neutral on the way between gears (4 -> 0 -> 3), so the
    // shift is the sample where the next real gear appears.
    let prevGear = 0;
    for (let i = 0; i < n; i++) {
        const g = gear[i];
        if (Number.isNaN(g) || g === 0) continue;
        if (prevGear === 0) { prevGear = g; continue; }
        if (g === prevGear) continue;
        const wasGear = prevGear;
        prevGear = g;

        bridge(i, true);
        // Blips are only credible while the brake is applied; on exit a narrow
        // spike is the driver's own and must survive.
        if (g < wasGear && hasBrake && brake![i] > cfg.blipBrakeThreshold) bridge(i, false);
    }

    return out ?? throttle;
};
