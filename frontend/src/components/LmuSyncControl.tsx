import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    RefreshCw, PauseCircle, FolderSearch, AlertTriangle, Check, Loader2, X, Play,
} from 'lucide-react';
import { useTelemetryStore } from '../store/telemetryStore';
import type { LmuSyncStatusKind } from '../types';
import { Tooltip } from './ui/Tooltip';

/**
 * LMU game-directory sync control.
 *
 * A status icon in the LMU Track Library header. It auto-detects the
 * UserData/Telemetry export folder, lets the user (re)point it, enable/disable
 * sync, and run an on-demand import ("Sync now"). Only rendered for the LMU
 * library. Kept as a separate component from AccSyncControl so the two sync
 * paths stay decoupled -- LMU copies native .duckdb files, ACC converts MoTeC.
 */

const STATUS_META: Record<LmuSyncStatusKind, { label: string; tone: string; ring: string }> = {
    active: { label: 'Sync Active', tone: 'text-emerald-400', ring: 'border-emerald-500/40 bg-emerald-500/10' },
    scanning: { label: 'Syncing…', tone: 'text-blue-400', ring: 'border-blue-500/40 bg-blue-500/10' },
    paused: { label: 'Sync Paused', tone: 'text-gray-400', ring: 'border-white/10 bg-white/5' },
    'folder-not-found': { label: 'Folder Missing', tone: 'text-amber-400', ring: 'border-amber-500/40 bg-amber-500/10' },
    unconfigured: { label: 'Set Up Sync', tone: 'text-amber-400', ring: 'border-amber-500/40 bg-amber-500/10' },
    error: { label: 'Sync Error', tone: 'text-red-400', ring: 'border-red-500/40 bg-red-500/10' },
};

const StatusIcon = ({ status, scanning }: { status: LmuSyncStatusKind; scanning: boolean }) => {
    if (scanning) return <RefreshCw size={16} className="animate-spin" />;
    switch (status) {
        case 'active': return <RefreshCw size={16} />;
        case 'paused': return <PauseCircle size={16} />;
        case 'error': return <AlertTriangle size={16} />;
        default: return <FolderSearch size={16} />;
    }
};

const timeAgo = (ts: number | null) => {
    if (!ts) return 'never';
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
};

export const LmuSyncControl = () => {
    const lmuSync = useTelemetryStore(s => s.lmuSync);
    const isScanning = useTelemetryStore(s => s.isLmuScanning);
    const fetchStatus = useTelemetryStore(s => s.fetchLmuSyncStatus);
    const detectFolder = useTelemetryStore(s => s.detectLmuFolder);
    const setConfig = useTelemetryStore(s => s.setLmuSyncConfig);
    const triggerScan = useTelemetryStore(s => s.triggerLmuScan);

    const [open, setOpen] = useState(false);
    const [folderInput, setFolderInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => { if (!lmuSync) fetchStatus(); }, [lmuSync, fetchStatus]);
    useEffect(() => { setFolderInput(lmuSync?.folder || ''); }, [lmuSync?.folder]);

    // Close popover on outside click.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    if (!lmuSync) return null;

    const status = isScanning ? 'scanning' : lmuSync.status;
    const meta = STATUS_META[status] ?? STATUS_META.unconfigured;
    const configured = !!lmuSync.folder;

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setErrorMsg(null);
        try { await fn(); }
        catch (e) { setErrorMsg((e as Error).message || 'Something went wrong'); }
        finally { setBusy(false); }
    };

    const handleSaveFolder = () => run(async () => {
        await setConfig({ folder: folderInput.trim() || null });
    });

    const handleDetect = () => run(async () => {
        const path = await detectFolder();
        if (!path) setErrorMsg('Could not auto-detect the LMU Telemetry folder. Enter it manually below.');
    });

    const handleStart = () => run(async () => {
        await setConfig({ enabled: true });
        await triggerScan();
    });

    const handlePause = () => run(async () => { await setConfig({ enabled: false }); });
    const handleSyncNow = () => run(async () => { await triggerScan(); });

    const result = lmuSync.lastResult;

    return (
        <div ref={rootRef} className="relative">
            <Tooltip text={meta.label} position="bottom">
                <button
                    onClick={() => setOpen(o => !o)}
                    className={`flex items-center gap-2 h-10 px-3 rounded-xl border transition-all font-black text-[10px] uppercase tracking-widest ${meta.ring} ${meta.tone} hover:brightness-125`}
                >
                    <StatusIcon status={status} scanning={isScanning} />
                    <span className="hidden xl:inline">{meta.label}</span>
                </button>
            </Tooltip>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: -6, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.98 }}
                        transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                        className="absolute right-0 top-12 z-50 w-[340px] rounded-2xl border border-white/10 bg-[#14141b] shadow-2xl p-4"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                                <div className={`w-8 h-8 rounded-lg border flex items-center justify-center ${meta.ring} ${meta.tone}`}>
                                    <StatusIcon status={status} scanning={isScanning} />
                                </div>
                                <div>
                                    <h3 className="text-[13px] font-black uppercase tracking-tight text-white leading-none">Game Sync</h3>
                                    <p className={`text-[10px] font-bold uppercase tracking-widest mt-1 ${meta.tone}`}>{meta.label}</p>
                                </div>
                            </div>
                            <button onClick={() => setOpen(false)} className="p-1 text-gray-500 hover:text-white rounded-md">
                                <X size={15} />
                            </button>
                        </div>

                        <p className="text-[11px] text-gray-500 mb-3 leading-snug">
                            Automatically imports LMU <span className="font-mono text-gray-400">.duckdb</span> recordings from your game's UserData/Telemetry folder.
                        </p>

                        {/* Folder path */}
                        <label className="block text-[9px] font-black uppercase tracking-widest text-gray-500 mb-1.5">Telemetry Folder</label>
                        <div className="flex items-center gap-2 mb-1">
                            <input
                                value={folderInput}
                                onChange={(e) => setFolderInput(e.target.value)}
                                placeholder="/path/to/…/Le Mans Ultimate/UserData/Telemetry"
                                spellCheck={false}
                                className="flex-1 min-w-0 h-9 px-2.5 rounded-lg bg-black/30 border border-white/10 text-[11px] font-mono text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50"
                            />
                            <button
                                onClick={handleSaveFolder}
                                disabled={busy || folderInput.trim() === (lmuSync.folder || '')}
                                className="flex-shrink-0 h-9 px-2.5 rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-all disabled:opacity-40"
                                title="Save folder"
                            >
                                <Check size={14} />
                            </button>
                        </div>
                        <div className="flex items-center justify-between mb-4">
                            <button onClick={handleDetect} disabled={busy} className="text-[10px] font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300 disabled:opacity-40">
                                Auto-detect
                            </button>
                            {lmuSync.autoDetected && configured && (
                                <span className="text-[9px] font-bold uppercase tracking-widest text-emerald-400/70">Auto-detected</span>
                            )}
                        </div>

                        {errorMsg && (
                            <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-2">
                                <AlertTriangle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
                                <span className="text-[11px] text-red-300 leading-snug">{errorMsg}</span>
                            </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-2">
                            {lmuSync.enabled ? (
                                <>
                                    <button
                                        onClick={handleSyncNow}
                                        disabled={busy || isScanning || !configured}
                                        className="flex-1 h-10 rounded-xl bg-blue-600/25 border border-blue-500/40 text-blue-200 hover:bg-blue-600/35 hover:text-white transition-all font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-40"
                                    >
                                        {isScanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                        Sync Now
                                    </button>
                                    <button
                                        onClick={handlePause}
                                        disabled={busy}
                                        className="h-10 px-3 rounded-xl bg-white/5 border border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-all font-black text-[10px] uppercase tracking-widest flex items-center gap-2 disabled:opacity-40"
                                    >
                                        <PauseCircle size={14} /> Pause
                                    </button>
                                </>
                            ) : (
                                <button
                                    onClick={handleStart}
                                    disabled={busy || !configured}
                                    className="flex-1 h-10 rounded-xl bg-emerald-600/25 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-600/35 hover:text-white transition-all font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-40"
                                >
                                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                                    {configured ? 'Start Sync' : 'Set a folder first'}
                                </button>
                            )}
                        </div>

                        {/* Last result */}
                        <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between text-[10px]">
                            <span className="text-gray-500 font-bold uppercase tracking-widest">
                                {result
                                    ? <>Imported <span className="text-emerald-400">{result.imported}</span> · {result.skipped} up to date{result.errors ? <> · <span className="text-red-400">{result.errors} failed</span></> : ''}</>
                                    : 'Not synced yet'}
                            </span>
                            <span className="text-gray-600 font-mono">{timeAgo(lmuSync.lastScanAt)}</span>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
