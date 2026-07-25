import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    Radio, AlertTriangle, Loader2, X, Play, Square, Search, Check, PauseCircle, Film, LineChart,
} from 'lucide-react';
import { useTelemetryStore, LIVE_SESSION_ID } from '../store/telemetryStore';
import type { LiveStateKind } from '../types';
import { Tooltip } from './ui/Tooltip';

/**
 * ACC live telemetry control (real-time UDP broadcasting feed).
 *
 * Sits beside the sync icon in the ACC Track Library header: shows whether the
 * game is streaming, what it is streaming (track / car / lap / speed), and lets
 * the user point the reader at ACC's broadcasting port and start/stop it.
 *
 * The UDP feed carries position, speed, gear, lap fraction and lap times for the
 * driven car -- pedals/steering/rpm/tyres need the Proton shared-memory bridge
 * (design Tier A) and are intentionally absent here.
 */

const STATE_META: Record<LiveStateKind, { label: string; tone: string; ring: string }> = {
    driving: { label: 'Live', tone: 'text-emerald-400', ring: 'border-emerald-500/40 bg-emerald-500/10' },
    connected: { label: 'In Garage', tone: 'text-blue-400', ring: 'border-blue-500/40 bg-blue-500/10' },
    waiting: { label: 'Waiting for ACC', tone: 'text-amber-400', ring: 'border-amber-500/40 bg-amber-500/10' },
    paused: { label: 'Session Paused', tone: 'text-gray-400', ring: 'border-white/10 bg-white/5' },
    replay: { label: 'Replay', tone: 'text-purple-400', ring: 'border-purple-500/40 bg-purple-500/10' },
    stopped: { label: 'Live Telemetry', tone: 'text-gray-400', ring: 'border-white/10 bg-white/5' },
};

const StateIcon = ({ state }: { state: LiveStateKind }) => {
    switch (state) {
        case 'driving': return <Radio size={16} className="animate-pulse" />;
        case 'waiting': return <Loader2 size={16} className="animate-spin" />;
        case 'replay': return <Film size={16} />;
        case 'paused': return <PauseCircle size={16} />;
        default: return <Radio size={16} />;
    }
};

const lapTime = (ms: number | null | undefined) => {
    if (!ms || ms <= 0) return '--:--.---';
    const total = Math.floor(ms);
    const m = Math.floor(total / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const milli = total % 1000;
    return `${m}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
};

/** Requested broadcast intervals. ACC does this work while rendering, so a
 *  faster feed costs in-game frames -- 20 Hz is the sweet spot for a live map. */
const RATE_OPTIONS: { ms: number; label: string }[] = [
    { ms: 100, label: '10 Hz' },
    { ms: 50, label: '20 Hz' },
    { ms: 16, label: '60 Hz' },
];

const Stat = ({ label, value, tone = 'text-gray-200' }: { label: string; value: string; tone?: string }) => (
    <div>
        <div className="text-[9px] font-black uppercase tracking-widest text-gray-600">{label}</div>
        <div className={`text-[13px] font-black tabular-nums leading-tight ${tone}`}>{value}</div>
    </div>
);

/** `align` places the popover under the button; use 'left' when the control sits
 *  on the left of a bar (the analysis navbar) so the panel stays on screen. */
export const LiveTelemetryControl = ({ align = 'right' }: { align?: 'left' | 'right' }) => {
    const live = useTelemetryStore(s => s.liveStatus);
    const latest = useTelemetryStore(s => s.liveLatest);
    const lastLap = useTelemetryStore(s => s.liveLastLap);
    const fetchStatus = useTelemetryStore(s => s.fetchLiveStatus);
    const detectConfig = useTelemetryStore(s => s.detectLiveConfig);
    const setConfig = useTelemetryStore(s => s.setLiveConfig);
    const startLive = useTelemetryStore(s => s.startLive);
    const stopLive = useTelemetryStore(s => s.stopLive);
    const connectStream = useTelemetryStore(s => s.connectLiveStream);
    const enterLiveView = useTelemetryStore(s => s.enterLiveView);
    const livePauseOnBlur = useTelemetryStore(s => s.livePauseOnBlur);
    const setLivePauseOnBlur = useTelemetryStore(s => s.setLivePauseOnBlur);
    const liveRenderEnabled = useTelemetryStore(s => s.liveRenderEnabled);
    const inLiveView = useTelemetryStore(s => s.currentSessionId === LIVE_SESSION_ID);
    const speedUnit = useTelemetryStore(s => s.speedUnit);

    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [port, setPort] = useState('');
    const [password, setPassword] = useState('');
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => { if (!live) fetchStatus(); }, [live, fetchStatus]);

    // A reader left running (autostart, or the user navigated away and back)
    // should re-attach its stream rather than sit there looking dead.
    useEffect(() => { if (live?.running) connectStream(); }, [live?.running, connectStream]);

    useEffect(() => { if (live?.config) setPort(String(live.config.port ?? '')); }, [live?.config?.port]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    if (!live) return null;

    const state = live.state;
    const meta = STATE_META[state] ?? STATE_META.stopped;
    const isMock = live.config.source === 'mock';

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setErrorMsg(null);
        try { await fn(); }
        catch (e) { setErrorMsg((e as Error).message || 'Something went wrong'); }
        finally { setBusy(false); }
    };

    const handleStart = () => run(async () => { await startLive(); });
    const handleStop = () => run(async () => { await stopLive(); });

    const handleDetect = () => run(async () => {
        const found = await detectConfig();
        if (!found?.path) {
            setErrorMsg("Couldn't find ACC's broadcasting.json. Enter the port (and password, if set) manually.");
        }
    });

    const handleSaveConnection = () => run(async () => {
        const parsed = parseInt(port, 10);
        if (!parsed || parsed < 1 || parsed > 65535) throw new Error('Enter a valid UDP port (1-65535).');
        await setConfig({ port: parsed, password });
        setPassword('');
    });

    const setRate = (ms: number) => run(async () => { await setConfig({ updateMs: ms }); });

    const toggleSource = () => run(async () => {
        await setConfig({ source: isMock ? 'acc_udp' : 'mock' });
    });

    const speed = latest?.['Ground Speed'] ?? 0;
    const gear = latest?.['Gear'];
    const displaySpeed = speedUnit === 'mph' ? speed * 0.621371 : speed;

    return (
        <div ref={rootRef} className="relative">
            <Tooltip text={meta.label} position="bottom">
                <button
                    onClick={() => setOpen(o => !o)}
                    className={`flex items-center gap-2 h-10 px-3 rounded-xl border transition-all font-black text-[10px] uppercase tracking-widest ${meta.ring} ${meta.tone} hover:brightness-125`}
                >
                    <StateIcon state={state} />
                    <span className="hidden xl:inline">{state === 'driving' && live.car ? `Live · ${Math.round(displaySpeed)}` : meta.label}</span>
                </button>
            </Tooltip>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: -6, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.98 }}
                        transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                        className={`absolute ${align === 'left' ? 'left-0' : 'right-0'} top-12 z-50 w-[340px] rounded-2xl border border-white/10 bg-[#14141b] shadow-2xl p-4`}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                                <div className={`w-8 h-8 rounded-lg border flex items-center justify-center ${meta.ring} ${meta.tone}`}>
                                    <StateIcon state={state} />
                                </div>
                                <div>
                                    <h3 className="text-[13px] font-black uppercase tracking-tight text-white leading-none">Live Telemetry</h3>
                                    <p className={`text-[10px] font-bold uppercase tracking-widest mt-1 ${meta.tone}`}>
                                        {meta.label}{live.running && live.hz > 0 ? ` · ${live.hz.toFixed(0)} Hz` : ''}
                                    </p>
                                </div>
                            </div>
                            <button onClick={() => setOpen(false)} className="p-1 text-gray-500 hover:text-white rounded-md">
                                <X size={15} />
                            </button>
                        </div>

                        {live.running ? (
                            <div className="mb-3 rounded-xl border border-white/5 bg-black/25 p-3 grid grid-cols-3 gap-y-3">
                                <Stat label="Track" value={live.track || '—'} />
                                <Stat label="Car" value={live.car || '—'} />
                                <Stat label="Lap" value={live.lap != null ? String(live.lap + 1) : '—'} />
                                <Stat label={speedUnit === 'mph' ? 'MPH' : 'KM/H'} value={String(Math.round(displaySpeed))}
                                    tone={state === 'driving' ? 'text-emerald-400' : 'text-gray-400'} />
                                <Stat label="Gear" value={gear == null ? '—' : gear < 0 ? 'R' : gear === 0 ? 'N' : String(gear)} />
                                <Stat label="Last Lap" value={lapTime(live.lastLapMs)} />
                                <div className="col-span-3 pt-2 border-t border-white/5 flex items-center justify-between">
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-gray-600">
                                        Best {lapTime(live.bestLapMs)}
                                        {live.packetsPerSec !== undefined && (
                                            <span className="ml-2 text-gray-700 normal-case tracking-normal font-mono">
                                                udp {live.packetsPerSec}/s · car {live.carUpdatesPerSec}/s
                                            </span>
                                        )}
                                    </span>
                                    {lastLap && (
                                        <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400/80">
                                            Lap {lastLap.lap + 1} done {lapTime(lastLap.timeMs)}{lastLap.invalid ? ' (invalid)' : ''}
                                        </span>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <p className="text-[11px] text-gray-500 mb-3 leading-snug">
                                Streams the driven car's position, speed, gear and lap times straight from a running
                                ACC session over its UDP broadcasting API — no Windows helper needed.
                                Enable it in ACC's <span className="font-mono text-gray-400">Config/broadcasting.json</span>.
                            </p>
                        )}

                        <p className="text-[10px] text-gray-600 mb-3 leading-snug">
                            The UDP feed carries <span className="text-gray-400">speed, gear, track position, lap
                            times and deltas</span> — ACC does not broadcast throttle, brake, steering, RPM or tyre
                            data, so those charts stay empty until the shared-memory bridge lands.
                        </p>

        {/* Rendering pause — the other lever on in-game FPS */}
                        <button
                            onClick={() => setLivePauseOnBlur(!livePauseOnBlur)}
                            className="w-full mb-4 flex items-start gap-2 text-left group/pause"
                        >
                            <span className={`mt-0.5 w-4 h-4 flex-shrink-0 rounded border flex items-center justify-center transition-all ${
                                livePauseOnBlur ? 'border-blue-500/60 bg-blue-600/30 text-blue-200' : 'border-white/15 bg-white/5 text-transparent'
                            }`}>
                                <Check size={11} />
                            </span>
                            <span className="text-[10px] leading-snug text-gray-500 group-hover/pause:text-gray-400">
                                <span className="font-black uppercase tracking-widest text-gray-400">Pause charts while driving</span>
                                <br />
                                Stops redrawing whenever ACC has focus — the app and the game share a GPU.
                                Data keeps buffering and catches up when you switch back.
                                {inLiveView && !liveRenderEnabled && (
                                    <span className="text-amber-400/80"> · suspended now</span>
                                )}
                            </span>
                        </button>

                        {/* Update rate — the main lever on in-game FPS */}
                        <label className="block text-[9px] font-black uppercase tracking-widest text-gray-500 mb-1.5">
                            Update Rate <span className="text-gray-600">· higher costs in-game FPS</span>
                        </label>
                        <div className="flex items-center gap-1.5 mb-4">
                            {RATE_OPTIONS.map(opt => (
                                <button
                                    key={opt.ms}
                                    onClick={() => setRate(opt.ms)}
                                    disabled={busy}
                                    className={`flex-1 h-8 rounded-lg border text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-40 ${
                                        live.config.updateMs === opt.ms
                                            ? 'border-blue-500/50 bg-blue-600/25 text-blue-200'
                                            : 'border-white/10 bg-white/5 text-gray-400 hover:text-white hover:border-white/20'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>

                        {/* Connection */}
                        <label className="block text-[9px] font-black uppercase tracking-widest text-gray-500 mb-1.5">
                            UDP Port {live.config.hasPassword && <span className="text-emerald-400/70">· password set</span>}
                        </label>
                        <div className="flex items-center gap-2 mb-1">
                            <input
                                value={port}
                                onChange={(e) => setPort(e.target.value)}
                                placeholder="9000"
                                inputMode="numeric"
                                spellCheck={false}
                                className="w-[86px] flex-shrink-0 h-9 px-2.5 rounded-lg bg-black/30 border border-white/10 text-[11px] font-mono text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50"
                            />
                            <input
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={live.config.hasPassword ? '•••••• (unchanged)' : 'connection password'}
                                type="password"
                                spellCheck={false}
                                className="flex-1 min-w-0 h-9 px-2.5 rounded-lg bg-black/30 border border-white/10 text-[11px] font-mono text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50"
                            />
                            <button
                                onClick={handleSaveConnection}
                                disabled={busy}
                                className="flex-shrink-0 h-9 px-2.5 rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-all disabled:opacity-40"
                                title="Save connection"
                            >
                                <Check size={14} />
                            </button>
                        </div>
                        <div className="flex items-center justify-between mb-4">
                            <button onClick={handleDetect} disabled={busy} className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300 disabled:opacity-40">
                                <Search size={11} /> Read from game config
                            </button>
                            <button onClick={toggleSource} disabled={busy} className="text-[10px] font-bold uppercase tracking-widest text-gray-500 hover:text-gray-300 disabled:opacity-40">
                                {isMock ? 'Demo feed' : 'Use demo feed'}
                            </button>
                        </div>

                        {(errorMsg || live.error) && (
                            <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-2">
                                <AlertTriangle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
                                <span className="text-[11px] text-red-300 leading-snug">{errorMsg || live.error}</span>
                            </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-2">
                            {live.running && !inLiveView && (
                                <button
                                    onClick={() => { enterLiveView(); setOpen(false); }}
                                    className="flex-1 h-10 rounded-xl bg-blue-600/25 border border-blue-500/40 text-blue-200 hover:bg-blue-600/35 hover:text-white transition-all font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2"
                                >
                                    <LineChart size={14} /> Live View
                                </button>
                            )}
                            {live.running ? (
                                <button
                                    onClick={handleStop}
                                    disabled={busy}
                                    className="flex-1 h-10 rounded-xl bg-white/5 border border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-all font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-40"
                                >
                                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />} Stop
                                </button>
                            ) : (
                                <button
                                    onClick={handleStart}
                                    disabled={busy}
                                    className="flex-1 h-10 rounded-xl bg-emerald-600/25 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-600/35 hover:text-white transition-all font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-40"
                                >
                                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Go Live
                                </button>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
