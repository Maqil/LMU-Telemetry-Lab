import { useEffect, useMemo, useRef, useState } from 'react';
import { useTelemetryStore } from '../store/telemetryStore';
import { apiClient } from '../api/client';
import {
    Film, Crosshair, Minus, Plus, Volume2, VolumeX,
    FolderOpen, Trash2, AlertTriangle, X, GripVertical,
} from 'lucide-react';

// Drift thresholds (seconds) while the telemetry is playing. Telemetry is master;
// the video plays natively and we only intervene when it drifts, to stay smooth.
const SOFT_DRIFT = 0.12;   // gentle rate-nudge back into sync
const HARD_DRIFT = 0.30;   // snap-seek
const PAUSED_EPS = 0.033;  // ~1 frame: exact align when paused/scrubbing

// Default overlay geometry: top-right of the map, just below the track minimap.
const DEFAULT_TOP = 158;
const DEFAULT_RIGHT = 16;
const DEFAULT_W = 320;
const DEFAULT_H = 200;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Floating, draggable + resizable video overlay that lives inside the map panel.
 * The <video> is a pure follower: it reads playbackElapsed/isPlaying/playbackSpeed
 * from the store and NEVER writes back, so there is no feedback loop.
 */
export const VideoPanel = () => {
    const currentSessionId = useTelemetryStore(s => s.currentSessionId);
    const selectedLapIdx = useTelemetryStore(s => s.selectedLapIdx);
    const activeProfileId = useTelemetryStore(s => s.activeProfileId);
    const videoAssociation = useTelemetryStore(s => s.videoAssociation);
    const pickAndAssociateVideo = useTelemetryStore(s => s.pickAndAssociateVideo);
    const setLapVideoOffset = useTelemetryStore(s => s.setLapVideoOffset);
    const clearVideoAssociation = useTelemetryStore(s => s.clearVideoAssociation);
    const toggleVideoPanel = useTelemetryStore(s => s.toggleVideoPanel);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
    const [muted, setMuted] = useState(true);
    const [outOfRange, setOutOfRange] = useState(false);
    // null => anchored to the default top-right spot; once dragged we use left/top px.
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

    const profileId = activeProfileId || 'guest';
    const hasVideo = !!(videoAssociation && videoAssociation.videoPath);
    const fileMissing = hasVideo && videoAssociation?.exists === false;

    const currentOffset = useMemo(() => {
        if (!videoAssociation || selectedLapIdx === null) return 0;
        return videoAssociation.perLapOffsets?.[String(selectedLapIdx)] ?? 0;
    }, [videoAssociation, selectedLapIdx]);

    const src = useMemo(() => {
        if (!hasVideo || !currentSessionId || fileMissing) return null;
        const base = apiClient.getVideoStreamUrl(currentSessionId, profileId);
        return `${base}&v=${encodeURIComponent(videoAssociation!.videoPath!)}`;
    }, [hasVideo, fileMissing, currentSessionId, profileId, videoAssociation]);

    // The single follower loop. Reads everything imperatively from the store so it
    // never triggers a per-frame re-render and never uses stale values.
    useEffect(() => {
        if (!src) return;
        let raf = 0;
        let cancelled = false;
        const tick = () => {
            if (cancelled) return;
            const video = videoRef.current;
            if (video && video.readyState >= 1) {
                const st = useTelemetryStore.getState();
                const offset = st.videoAssociation?.perLapOffsets?.[String(st.selectedLapIdx)] ?? 0;
                const target = offset + st.playbackElapsed;
                const dur = isFinite(video.duration) ? video.duration : target;

                if (st.isPlaying && video.paused) video.play().catch(() => {});
                if (!st.isPlaying && !video.paused) video.pause();

                const oob = target < 0 || target > dur;
                if (oob !== outOfRange) setOutOfRange(oob);
                const clampedTarget = clamp(target, 0, dur);
                const drift = video.currentTime - clampedTarget;
                const rate = clamp(st.playbackSpeed, 0.0625, 16);

                if (!st.isPlaying) {
                    if (Math.abs(drift) > PAUSED_EPS) video.currentTime = clampedTarget;
                    video.playbackRate = rate;
                } else if (Math.abs(drift) > HARD_DRIFT) {
                    video.currentTime = clampedTarget;
                    video.playbackRate = rate;
                } else if (Math.abs(drift) > SOFT_DRIFT) {
                    video.playbackRate = clamp(st.playbackSpeed * (drift > 0 ? 0.9 : 1.1), 0.0625, 16);
                } else {
                    video.playbackRate = rate;
                }
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => { cancelled = true; cancelAnimationFrame(raf); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src]);

    // --- Dragging (via the header grip) ---
    const onDragMove = (e: PointerEvent) => {
        const el = overlayRef.current;
        const drag = dragRef.current;
        if (!el || !drag) return;
        const parent = el.offsetParent as HTMLElement | null;
        const pw = parent?.clientWidth ?? window.innerWidth;
        const ph = parent?.clientHeight ?? window.innerHeight;
        const left = clamp(drag.ox + (e.clientX - drag.sx), 0, Math.max(0, pw - el.offsetWidth));
        const top = clamp(drag.oy + (e.clientY - drag.sy), 0, Math.max(0, ph - 32));
        setPos({ left, top });
    };
    const onDragEnd = () => {
        dragRef.current = null;
        window.removeEventListener('pointermove', onDragMove);
        window.removeEventListener('pointerup', onDragEnd);
    };
    const onDragStart = (e: React.PointerEvent) => {
        const el = overlayRef.current;
        const parent = el?.offsetParent as HTMLElement | null;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const prect = parent?.getBoundingClientRect();
        dragRef.current = {
            sx: e.clientX, sy: e.clientY,
            ox: prect ? rect.left - prect.left : rect.left,
            oy: prect ? rect.top - prect.top : rect.top,
        };
        window.addEventListener('pointermove', onDragMove);
        window.addEventListener('pointerup', onDragEnd);
    };
    useEffect(() => () => onDragEnd(), []);

    const handleSetSyncPoint = () => {
        const video = videoRef.current;
        if (!video || selectedLapIdx === null) return;
        const off = video.currentTime - useTelemetryStore.getState().playbackElapsed;
        setLapVideoOffset(selectedLapIdx, Math.round(off * 1000) / 1000);
    };
    const nudge = (delta: number) => {
        if (selectedLapIdx === null) return;
        setLapVideoOffset(selectedLapIdx, Math.round((currentOffset + delta) * 1000) / 1000);
    };
    const pick = () => pickAndAssociateVideo({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });

    if (selectedLapIdx === null || !currentSessionId) return null;

    const overlayStyle: React.CSSProperties = pos
        ? { left: pos.left, top: pos.top, width: DEFAULT_W, height: DEFAULT_H }
        : { top: DEFAULT_TOP, right: DEFAULT_RIGHT, width: DEFAULT_W, height: DEFAULT_H };

    const iconBtn = "h-6 w-6 flex items-center justify-center rounded border border-white/10 bg-white/5 text-gray-300 hover:text-white transition-all";

    return (
        <div
            ref={overlayRef}
            className="absolute z-[150] flex flex-col rounded-md overflow-hidden border border-white/15 bg-[#0b0b0e]/95 shadow-[0_10px_40px_rgba(0,0,0,0.6)] backdrop-blur-sm pointer-events-auto resize"
            style={{ ...overlayStyle, minWidth: 220, minHeight: 150, maxWidth: 720, maxHeight: 460 }}
        >
            {/* Header (drag handle) */}
            <div
                className="flex items-center gap-2 px-2 h-8 flex-shrink-0 border-b border-white/10 bg-[#111115] cursor-move select-none"
                onPointerDown={onDragStart}
            >
                <GripVertical size={12} className="text-gray-600" />
                <Film size={12} className="text-blue-400" />
                <span className="text-[9px] font-black uppercase tracking-widest text-gray-300">Lap Video</span>
                {hasVideo && !fileMissing && (
                    <span className="text-[9px] text-gray-500 truncate max-w-[90px]" title={videoAssociation?.filename || ''}>
                        {videoAssociation?.filename}
                    </span>
                )}
                <button onClick={() => toggleVideoPanel()} title="Close video" className={`${iconBtn} ml-auto`} onPointerDown={e => e.stopPropagation()}>
                    <X size={12} />
                </button>
            </div>

            {/* Controls row (only when a video is loaded) */}
            {hasVideo && !fileMissing && (
                <div className="flex items-center gap-1 px-2 h-8 flex-shrink-0 border-b border-white/10 bg-[#0e0e13]" onPointerDown={e => e.stopPropagation()}>
                    <button onClick={handleSetSyncPoint} title="Set current video frame as lap start"
                        className="flex items-center gap-1 h-6 px-1.5 rounded border border-white/10 bg-white/5 text-gray-300 hover:text-white hover:border-blue-500/50 text-[9px] font-bold uppercase tracking-wider transition-all">
                        <Crosshair size={11} /> Sync
                    </button>
                    <button onClick={() => nudge(-0.1)} title="Shift video 0.1s earlier" className={iconBtn}><Minus size={11} /></button>
                    <span className="text-[10px] font-mono text-gray-400 w-12 text-center tabular-nums">
                        {currentOffset >= 0 ? '+' : ''}{currentOffset.toFixed(2)}s
                    </span>
                    <button onClick={() => nudge(0.1)} title="Shift video 0.1s later" className={iconBtn}><Plus size={11} /></button>
                    <div className="ml-auto flex items-center gap-1">
                        <button onClick={() => setMuted(m => !m)} title={muted ? 'Unmute' : 'Mute'} className={iconBtn}>
                            {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                        </button>
                        <button onClick={pick} title="Change video" className={iconBtn}><FolderOpen size={12} /></button>
                        <button onClick={() => clearVideoAssociation()} title="Remove video" className={`${iconBtn} hover:text-red-400`}><Trash2 size={12} /></button>
                    </div>
                </div>
            )}

            {/* Body */}
            {fileMissing ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-3" onPointerDown={e => e.stopPropagation()}>
                    <AlertTriangle size={20} className="text-amber-400" />
                    <p className="text-[11px] text-gray-400">Video file is missing (moved or deleted).</p>
                    <button onClick={pick} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-white/15 bg-white/5 text-gray-200 hover:text-white hover:border-blue-500/50 text-[11px] font-bold transition-all">
                        <FolderOpen size={13} /> Re-select
                    </button>
                </div>
            ) : !hasVideo ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-3" onPointerDown={e => e.stopPropagation()}>
                    <Film size={22} className="text-gray-600" />
                    <p className="text-[11px] text-gray-500">No video for this session.</p>
                    <button onClick={pick} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-white/15 bg-blue-500/10 text-blue-300 hover:text-white hover:bg-blue-500/20 text-[11px] font-bold transition-all">
                        <FolderOpen size={13} /> Load lap video
                    </button>
                </div>
            ) : (
                <div className="flex-1 min-h-0 relative bg-black flex items-center justify-center" onPointerDown={e => e.stopPropagation()}>
                    <video ref={videoRef} src={src || undefined} muted={muted} playsInline preload="auto" className="max-h-full max-w-full" />
                    {outOfRange && (
                        <div className="absolute top-1.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-black/70 border border-amber-500/40 text-[9px] font-bold uppercase tracking-wider text-amber-300">
                            Outside video range
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
