import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    ArrowLeft, Search, Upload, Loader2, Timer, Trash2, MapPin, Layers, Car,
    ChevronDown, CalendarDays, CheckSquare, Square, MinusSquare, X, AlertTriangle,
    RefreshCw, Globe, Trophy, Flag, Clock, Route,
} from 'lucide-react';
import { useTelemetryStore } from '../store/telemetryStore';
import type { Session } from '../types';
import { handleGlassMouseMove } from '../utils/glassEffect';
import { getClassAccent, getCarClassBucket, getCompactCarName, CAR_CLASS_ORDER, RECORD_CLASS_ORDER } from '../utils/carHelpers';
import { getCountryFlagPath, getTrackImagePath, getLayoutKey, getLayoutLabel, matchTrack, ACC_TRACK_ROSTER } from '../utils/trackHelpers';
import { pairTelemetryUploads } from '../utils/uploadHelpers';
import { Tooltip } from './ui/Tooltip';
import { CarBrandLogo } from './ui/CarBrandLogo';
import { AccSyncControl } from './AccSyncControl';
import { LmuSyncControl } from './LmuSyncControl';

/**
 * Full-page track / session browser for a single sim.
 *
 * One row per track (with its map outline + stats). Clicking a track expands
 * its recorded sessions; clicking a session opens the telemetry + map view.
 */

const GAME_META: Record<'LMU' | 'ACC', { name: string; logo: string }> = {
    LMU: { name: 'Le Mans Ultimate', logo: '/games/lmu.svg' },
    ACC: { name: 'Assetto Corsa Competizione', logo: '/games/acc.svg' },
};

interface TrackLibraryProps {
    game: 'LMU' | 'ACC';
    onBack: () => void;
    onOpenSession: (sessionId: string) => void;
}

interface TrackRow {
    /** Circuit *and* layout: `${trackKey}::${layoutKey}`. */
    key: string;
    /** Circuit alone, shared by every layout row of the same track. */
    trackKey: string;
    name: string;
    /** Short label ("Daytona", "Spa") for the track filter chips. */
    short: string;
    /** Resolved layout key, e.g. "Default" or "Short Circuit". */
    layoutKey: string;
    /** "Short Circuit" / "Full Circuit" -- set only when it needs saying. */
    layoutLabel?: string;
    country?: string;
    image: string;
    sessions: Session[];
    bestLap: number;
    lastDriven: number;
    carCount: number;
}

/**
 * A circuit's variants are separate rows, so tell them apart -- but don't
 * label the common case. The layout is named when the track has more than one
 * variant in view, or when it isn't the full circuit (a lone "Short Circuit"
 * row still has to say so).
 */
const applyLayoutLabels = (rows: TrackRow[]) => {
    const perTrack = new Map<string, number>();
    rows.forEach(r => perTrack.set(r.trackKey, (perTrack.get(r.trackKey) || 0) + 1));
    rows.forEach(r => {
        const variant = r.layoutKey.toLowerCase() !== 'default';
        r.layoutLabel = (variant || (perTrack.get(r.trackKey) || 0) > 1)
            ? getLayoutLabel(r.layoutKey)
            : undefined;
    });
};

/** Dates render as DD/MM/YY -- fixed width, and never ambiguous about the year. */
const formatShortDate = (epochSec?: number | null) => {
    if (!epochSec) return '—';
    const d = new Date(epochSec * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)}`;
};

const formatLapTime = (sec?: number) => {
    if (sec === undefined || sec === null || isNaN(sec)) return '--:--.---';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
};

const formatDuration = (sec?: number) => {
    if (!sec || sec < 60) return sec && sec > 0 ? '<1m' : '';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
};

/** Native session types only; MoTeC imports don't carry one. */
const SESSION_TYPE_LABEL: Record<string, string> = {
    race: 'Race',
    qualify: 'Quali',
    qualifying: 'Quali',
    practice: 'Practice',
    warmup: 'Warmup',
    testday: 'Test Day',
};

/** Drivers read by surname alone -- the given name crowds an already busy row. */
const surname = (name?: string) => {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
};

/** Track outline SVG rendered as a CSS mask so we control its colour. */
const TrackMapImage = ({ src, active }: { src: string; active: boolean }) => {
    if (!src) {
        return <MapPin size={22} className="text-gray-600" />;
    }
    return (
        <div
            aria-hidden
            className={`w-full h-full transition-colors duration-300 ${active ? 'text-blue-400' : 'text-gray-500 group-hover/track:text-gray-300'}`}
            style={{
                backgroundColor: 'currentColor',
                WebkitMaskImage: `url(${src})`,
                maskImage: `url(${src})`,
                WebkitMaskRepeat: 'no-repeat',
                maskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center',
                maskPosition: 'center',
                WebkitMaskSize: 'contain',
                maskSize: 'contain',
            }}
        />
    );
};

const Stat = ({ icon: Icon, value, label, tone = 'text-gray-300' }: { icon: any; value: React.ReactNode; label: string; tone?: string }) => (
    <div className="flex flex-col items-center min-w-[64px]">
        <div className="flex items-center gap-1.5">
            <Icon size={12} className="text-gray-500" />
            <span className={`text-[13px] font-mono font-black ${tone}`}>{value}</span>
        </div>
        <span className="text-[8px] font-black uppercase tracking-[0.18em] text-gray-600 mt-0.5">{label}</span>
    </div>
);

/**
 * One cell in the track / class / car filter grids.
 *
 * Chips fill their grid cell rather than sizing to their text: a ragged
 * wrap of 30 circuits is unreadable, an aligned grid scans down a column.
 * `accent` gives the class chips the same hue they carry on the record board.
 */
const FilterChip = ({ active, onClick, leading, label, count, accent, activeClass = 'bg-blue-600/25 border-blue-500/40 text-blue-100' }: {
    active: boolean;
    onClick: () => void;
    leading?: React.ReactNode;
    label: string;
    count?: number;
    accent?: string;
    activeClass?: string;
}) => (
    <button
        type="button"
        onClick={onClick}
        style={accent && active ? {
            backgroundColor: `${accent}24`,
            borderColor: `${accent}88`,
            color: accent,
            boxShadow: `inset 0 0 20px ${accent}1a`,
        } : undefined}
        className={`flex items-center gap-2 w-full h-9 px-2.5 rounded-lg border font-black text-[10px] uppercase tracking-widest transition-all ${
            active
                ? (accent ? '' : activeClass)
                : 'bg-black/20 border-white/[0.07] text-gray-400 hover:text-gray-100 hover:border-white/20 hover:bg-white/[0.03]'
        }`}
    >
        {leading && <span className="flex-shrink-0 flex items-center justify-center w-4">{leading}</span>}
        <span className="flex-1 min-w-0 truncate text-left">{label}</span>
        {count !== undefined && (
            <span className={`text-[9px] font-mono flex-shrink-0 ${active ? 'opacity-70' : 'text-gray-600'}`}>{count}</span>
        )}
    </button>
);

const FilterStrip = ({ label, hint, className = '', cols = 'grid-cols-2 md:grid-cols-3', children }: {
    label: string;
    hint?: string;
    className?: string;
    /** Column count for the chip grid, as Tailwind grid-cols classes. */
    cols?: string;
    children: React.ReactNode;
}) => (
    <div className={`min-w-0 ${className}`}>
        <div className="flex items-baseline gap-2 mb-2.5">
            <span className="text-[9px] font-black uppercase tracking-[0.18em] text-gray-600">{label}</span>
            {hint && <span className="text-[9px] font-bold uppercase tracking-widest text-gray-700 truncate">{hint}</span>}
        </div>
        <div className={`grid gap-1.5 ${cols}`}>{children}</div>
    </div>
);

const SessionRow = ({ s, onOpen, onDelete, selectMode, selected, onToggleSelect, fastestClass }: {
    s: Session;
    onOpen: () => void;
    onDelete: () => void;
    selectMode: boolean;
    selected: boolean;
    onToggleSelect: () => void;
    /** Set when this session holds the quickest valid lap in its class here. */
    fastestClass?: string;
}) => {
    // When the session was driven (backend: RecordingTime / SessionTime). Only
    // falls back to the file mtime -- the import date -- if neither was readable.
    const dateEpoch = s.recordedAt ?? s.created;
    const driven = !!s.recordedAt;
    const stamp = dateEpoch ? new Date(dateEpoch * 1000) : null;
    const date = stamp ? formatShortDate(dateEpoch) : 'Unknown';
    const time = stamp && driven ? stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const when = `${driven ? 'DRIVEN' : 'IMPORTED'} ${date}${time ? ` · ${time}` : ''}`;
    const sessionType = s.sessionType
        ? SESSION_TYPE_LABEL[s.sessionType.toLowerCase().replace(/\s+/g, '')] || s.sessionType
        : '';
    const duration = formatDuration(s.sessionDuration);
    // No layout chip here: sessions are listed under the layout row they were
    // driven on, which names it once for all of them.
    return (
        <div
            onClick={selectMode ? onToggleSelect : onOpen}
            onMouseMove={(e) => handleGlassMouseMove(e, 0.2)}
            className={`group/row relative flex items-center gap-3 rounded-lg p-2.5 cursor-pointer border ring-1 ring-inset transition-all duration-200 min-w-0 ${
                selected
                    ? 'bg-blue-600/20 border-blue-500/50 ring-blue-500/30'
                    : 'bg-black/20 border-white/5 ring-white/5 hover:bg-blue-600/10 hover:border-blue-500/30'
            }`}
        >
            {selectMode && (
                <div className="flex-shrink-0 flex items-center justify-center">
                    {selected
                        ? <CheckSquare size={17} className="text-blue-400" />
                        : <Square size={17} className="text-gray-600 group-hover/row:text-gray-400" />}
                </div>
            )}
            <div className="relative flex-shrink-0 w-8 h-8 flex items-center justify-center">
                <CarBrandLogo name={s.carModel} carClass={s.carClass} size={28} />
            </div>
            <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[12px] font-black tracking-tight text-gray-200 group-hover/row:text-white truncate">
                        {s.carModel || s.trackLayout || 'Session'}
                    </span>
                    {sessionType && (
                        <span className="text-[7px] font-black uppercase px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-gray-300 flex-shrink-0">
                            {sessionType}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                    {s.bestLapTime != null && (() => {
                        // Fastest in its class here: purple time + trophy. The PB chip
                        // further along the row names the class it won.
                        const tone = fastestClass ? 'text-fuchsia-400' : s.bestLapValid ? 'text-blue-400' : 'text-red-400/80';
                        const Icon = fastestClass ? Trophy : Timer;
                        return (
                            <span className="flex items-center gap-1">
                                <Icon size={10} className={tone} />
                                <span className={`text-[10px] font-mono font-bold ${tone}`}>{formatLapTime(s.bestLapTime)}</span>
                            </span>
                        );
                    })()}
                    {s.lapCount != null && (
                        <Tooltip
                            text={s.lapCount === 0
                                ? 'NO COMPLETED LAPS'
                                : `${s.validLapCount ?? 0} OF ${s.lapCount} TIMED LAPS CLEAN`}
                            position="top"
                        >
                            <span className="flex items-center gap-1 text-[9px] font-mono font-bold text-gray-400">
                                <Flag size={10} className="text-gray-500" />
                                {s.lapCount} {s.lapCount === 1 ? 'Lap' : 'Laps'}
                            </span>
                        </Tooltip>
                    )}
                    {duration && (
                        <Tooltip text="SESSION LENGTH" position="top">
                            <span className="flex items-center gap-1 text-[9px] font-mono font-bold text-gray-400">
                                <Clock size={10} className="text-gray-500" />
                                {duration}
                            </span>
                        </Tooltip>
                    )}
                    {stamp && (
                        <Tooltip text={when} position="top">
                            <span className="flex items-center gap-1 text-[9px] font-mono font-bold text-gray-400">
                                <CalendarDays size={10} className="text-gray-500" />
                                {date}
                            </span>
                        </Tooltip>
                    )}
                    <Tooltip
                        text={fastestClass
                            ? `FASTEST ${fastestClass} LAP ON THIS LAYOUT · ${when}`
                            : `NOT THE CLASS BEST ON THIS LAYOUT · ${when}`}
                        position="top"
                    >
                        {fastestClass ? (
                            <span className="text-[7px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300">
                                PB {fastestClass}
                            </span>
                        ) : (
                            <span className="text-[9px] font-mono font-bold text-gray-600 px-1">—</span>
                        )}
                    </Tooltip>
                    {surname(s.driverName) && (
                        <Tooltip text={s.driverName!.toUpperCase()} position="left">
                            <span className="text-[9px] uppercase tracking-widest text-blue-400/60 font-bold truncate ml-auto">{surname(s.driverName)}</span>
                        </Tooltip>
                    )}
                </div>
            </div>
            {!selectMode && (
                <Tooltip text="DELETE SESSION" position="left">
                    <button
                        onClick={(e) => { e.stopPropagation(); onDelete(); }}
                        className="flex-shrink-0 p-1.5 rounded-md text-gray-500 opacity-0 group-hover/row:opacity-100 hover:text-red-400 hover:bg-red-500/10 transition-all"
                    >
                        <Trash2 size={13} />
                    </button>
                </Tooltip>
            )}
        </div>
    );
};

const TrackListRow = ({
    row,
    expanded,
    onToggle,
    onOpenSession,
    onDelete,
    selectMode,
    selectedIds,
    onToggleSelect,
    onToggleTrack,
    groupByClass,
}: {
    row: TrackRow;
    expanded: boolean;
    onToggle: () => void;
    onOpenSession: (id: string) => void;
    onDelete: (id: string) => void;
    selectMode: boolean;
    selectedIds: Set<string>;
    onToggleSelect: (id: string) => void;
    onToggleTrack: (row: TrackRow) => void;
    /** Split the expanded session list into one section per car class. */
    groupByClass: boolean;
}) => {
    const flag = getCountryFlagPath(row.country);
    const hasSessions = row.sessions.length > 0;

    // Quickest valid lap per car class among the sessions listed for this track.
    // Compared within a class only -- a GT3 lap against a Hypercar lap says
    // nothing -- so every class driven here gets its own best. Ordered by the
    // usual class hierarchy so the strip below the header reads top-class first.
    const classBests = useMemo(() => {
        const best = new Map<string, { id: string; time: number; key: string; label: string; car?: string }>();
        row.sessions.forEach(s => {
            if (!s.bestLapValid || s.bestLapTime == null) return;
            const bucket = getCarClassBucket(s.carClass);
            if (!bucket) return;
            const cur = best.get(bucket.key);
            if (!cur || s.bestLapTime < cur.time) {
                best.set(bucket.key, { id: s.id, time: s.bestLapTime, key: bucket.key, label: bucket.label, car: s.carModel });
            }
        });
        return [...best.values()].sort((a, b) => {
            const ai = CAR_CLASS_ORDER.indexOf(a.key);
            const bi = CAR_CLASS_ORDER.indexOf(b.key);
            if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
            return a.label.localeCompare(b.label);
        });
    }, [row.sessions]);
    // Session id -> class label, so the expanded list can mark the class best.
    const fastestByClass = useMemo(
        () => new Map(classBests.map(c => [c.id, c.label])),
        [classBests],
    );

    // With no class filter narrowing the library, the expanded list is split
    // into one section per car class -- a mixed-class circuit reads class by
    // class instead of as one interleaved date list. Ordered like the record
    // board's columns, so a class sits in the same place in both views.
    // Filtered views (and single-class tracks) stay flat: the heading would
    // only repeat what the chips already say.
    const sessionGroups = useMemo(() => {
        if (!groupByClass) return null;
        const groups = new Map<string, { key: string; label: string; sessions: Session[] }>();
        row.sessions.forEach(s => {
            const bucket = getCarClassBucket(s.carClass) || { key: 'UNKNOWN', label: 'Unclassified' };
            const g = groups.get(bucket.key) || { ...bucket, sessions: [] };
            g.sessions.push(s);
            groups.set(bucket.key, g);
        });
        if (groups.size < 2) return null;
        return [...groups.values()].sort((a, b) => {
            const ai = RECORD_CLASS_ORDER.indexOf(a.key);
            const bi = RECORD_CLASS_ORDER.indexOf(b.key);
            if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
            return a.label.localeCompare(b.label);
        });
    }, [row.sessions, groupByClass]);

    const lastDate = formatShortDate(row.lastDriven);

    // Classes start open; collapsing one folds its pane away so the other column
    // (or the next track) comes up the page. Kept per track row, so it survives
    // collapsing and reopening the track itself.
    const [collapsedClasses, setCollapsedClasses] = useState<Set<string>>(new Set());
    const toggleClassOpen = (key: string) => setCollapsedClasses(prev => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
    });

    // Two independent columns rather than a two-up grid: in a grid every cell in
    // a row is as tall as its tallest sibling, so collapsing one class left a
    // hole until the class beside it was collapsed too. Alternating the classes
    // between columns keeps the first row reading left-to-right in class order
    // while letting each column close up on its own.
    const sessionColumns = useMemo(
        () => (sessionGroups
            ? [sessionGroups.filter((_, i) => i % 2 === 0), sessionGroups.filter((_, i) => i % 2 === 1)]
                .filter(col => col.length > 0)
            : null),
        [sessionGroups]);

    const renderSession = (s: Session) => (
        <SessionRow
            key={s.id}
            s={s}
            onOpen={() => onOpenSession(s.id)}
            onDelete={() => onDelete(s.id)}
            selectMode={selectMode}
            selected={selectedIds.has(s.id)}
            onToggleSelect={() => onToggleSelect(s.id)}
            fastestClass={fastestByClass.get(s.id)}
        />
    );

    const selectedCount = hasSessions ? row.sessions.reduce((n, s) => n + (selectedIds.has(s.id) ? 1 : 0), 0) : 0;
    const allSelected = hasSessions && selectedCount === row.sessions.length;
    const someSelected = selectedCount > 0 && !allSelected;

    return (
        <div className={`rounded-2xl border overflow-hidden transition-colors duration-300 ${expanded ? 'border-blue-500/30 bg-[#14141b]' : 'border-white/[0.07] bg-[#16161c]'}`}>
            {/* Track header row */}
            <div className="flex items-stretch">
                {selectMode && hasSessions && (
                    <button
                        type="button"
                        onClick={() => onToggleTrack(row)}
                        className="flex-shrink-0 flex items-center justify-center pl-4 text-gray-500 hover:text-blue-400 transition-colors"
                        title={allSelected ? 'Deselect all sessions on this track' : 'Select all sessions on this track'}
                    >
                        {allSelected
                            ? <CheckSquare size={18} className="text-blue-400" />
                            : someSelected
                                ? <MinusSquare size={18} className="text-blue-400" />
                                : <Square size={18} />}
                    </button>
                )}
            <button
                type="button"
                onClick={hasSessions ? onToggle : undefined}
                onMouseMove={(e) => handleGlassMouseMove(e, 0.12)}
                className={`group/track w-full flex items-center gap-4 px-4 py-4 text-left transition-colors duration-200 ${hasSessions ? 'cursor-pointer hover:bg-white/[0.03]' : 'cursor-default'}`}
            >
                {/* Map outline */}
                <div className="flex-shrink-0 w-[136px] h-[84px] rounded-lg bg-black/30 border border-white/5 flex items-center justify-center p-2">
                    <TrackMapImage src={row.image} active={expanded} />
                </div>

                {/* Name + layout + country */}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                        {flag && <img src={flag} alt={row.country} className="w-5 h-auto rounded-[1px] border border-white/15 flex-shrink-0" onError={(e) => (e.currentTarget.style.display = 'none')} />}
                        <h3 className={`text-[15px] font-black uppercase tracking-tight truncate ${hasSessions ? 'text-white' : 'text-gray-400'}`}>{row.name}</h3>
                        {/* The variant is part of the row's identity, not a
                            detail: these stats and laps are its alone. */}
                        {row.layoutLabel && (
                            <Tooltip text="CIRCUIT LAYOUT · TIMED SEPARATELY" position="top">
                                <span className="flex items-center gap-1 flex-shrink-0 text-[8px] font-black uppercase tracking-[0.18em] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300/90">
                                    <Route size={9} />
                                    {row.layoutLabel}
                                </span>
                            </Tooltip>
                        )}
                    </div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mt-0.5">
                        {row.country || 'Circuit'}{hasSessions ? '' : ' · No recorded sessions'}
                    </p>
                </div>

                {/* Stats */}
                {hasSessions ? (
                    <div className="hidden sm:flex items-center gap-5 flex-shrink-0">
                        <Stat icon={Layers} value={row.sessions.length} label="Sessions" tone="text-white" />
                        <Stat icon={Car} value={row.carCount} label="Cars" tone="text-white" />
                        <Stat icon={Timer} value={formatLapTime(row.bestLap === Infinity ? undefined : row.bestLap)} label="Best" tone="text-amber-400" />
                        <Stat icon={CalendarDays} value={lastDate} label="Last" tone="text-gray-300" />
                    </div>
                ) : (
                    <span className="hidden sm:block text-[10px] font-black uppercase tracking-widest text-gray-600 px-3 py-1 rounded-full border border-white/5 flex-shrink-0">
                        Empty
                    </span>
                )}

                {/* Chevron */}
                <div className="flex-shrink-0 w-6 flex justify-center">
                    {hasSessions && (
                        <ChevronDown size={18} className={`text-gray-500 transition-transform duration-300 ${expanded ? 'rotate-180 text-blue-400' : 'group-hover/track:text-gray-300'}`} />
                    )}
                </div>
            </button>
            </div>

            {/* Class bests -- one segment per car class driven at this circuit, so
                a track's pace per class reads without expanding the session list.
                Same pill + mono-time language as the session rows below. */}
            {hasSessions && classBests.length > 0 && (
                <div className="px-4 pb-3.5 -mt-1.5">
                    <div className="flex flex-wrap items-stretch rounded-xl border border-white/[0.06] bg-black/25 divide-x divide-white/[0.06] overflow-hidden">
                        <div className="flex items-center gap-1.5 px-3 py-2.5 text-gray-600">
                            <Trophy size={11} />
                            <span className="hidden md:inline text-[8px] font-black uppercase tracking-[0.18em]">Class Best</span>
                        </div>
                        {classBests.map(c => {
                            // Same language as the record board: a hue rail over the
                            // class name, the lap time in white mono beside it.
                            const accent = getClassAccent(c.key);
                            return (
                                <Tooltip key={c.key} text={c.car ? `FASTEST ${c.label} LAP · ${c.car}` : `FASTEST ${c.label} LAP`} position="top">
                                    <div
                                        className="relative flex items-center gap-2.5 px-3.5 pt-2.5 pb-2 overflow-hidden"
                                        style={{ background: `linear-gradient(180deg, ${accent}14, transparent 90%)` }}
                                    >
                                        <span className="absolute inset-x-0 top-0 h-[2px]" style={{ backgroundColor: accent, opacity: 0.65 }} />
                                        <span
                                            className="text-[10px] font-black uppercase tracking-[0.14em] leading-none whitespace-nowrap"
                                            style={{ color: accent, textShadow: `0 0 16px ${accent}55` }}
                                        >
                                            {c.label}
                                        </span>
                                        <span className="text-[13px] font-mono font-black text-white tabular-nums">{formatLapTime(c.time)}</span>
                                        <CarBrandLogo name={c.car} carClass={c.key} size={16} />
                                        {getCompactCarName(c.car, c.key) && (
                                            <span className="hidden lg:inline text-[9px] font-bold uppercase tracking-widest text-gray-500 truncate max-w-[130px]">
                                                {getCompactCarName(c.car, c.key)}
                                            </span>
                                        )}
                                    </div>
                                </Tooltip>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Expanded sessions */}
            <AnimatePresence initial={false}>
                {expanded && hasSessions && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                        className="overflow-hidden"
                    >
                        {/* One session per line -- side-by-side columns made the
                            lap times hard to scan against each other. Grouped by
                            class, two classes sit side by side (one column until
                            there's width for it), which keeps a long mixed-class
                            list from pushing the next track off-screen. */}
                        <div className={`px-3 pb-3 pt-1 border-t border-white/5 flex gap-3 ${sessionColumns ? 'flex-col lg:flex-row lg:items-start' : 'flex-col gap-2'}`}>
                            {sessionColumns
                                ? sessionColumns.map((col, i) => (
                                    <div key={i} className="flex-1 min-w-0 flex flex-col gap-2">
                                        {col.map(g => {
                                            const accent = getClassAccent(g.key);
                                            const open = !collapsedClasses.has(g.key);
                                            return (
                                                <div key={g.key} className="flex flex-col gap-2 min-w-0">
                                                    {/* Class heading: a hue rail and a wash of the
                                                        class colour behind it, same language as the
                                                        record board -- it has to hold its own as the
                                                        only place the class is named now. Doubles as
                                                        the class's collapse toggle. */}
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleClassOpen(g.key)}
                                                        title={open ? `Collapse ${g.label}` : `Expand ${g.label}`}
                                                        className="group/class relative w-full flex items-baseline gap-3 rounded-lg border border-white/[0.06] px-3.5 py-2.5 mt-1 text-left overflow-hidden transition-colors hover:border-white/[0.14]"
                                                        style={{ background: `linear-gradient(90deg, ${accent}1f, transparent 72%)` }}
                                                    >
                                                        <span className="absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: accent, opacity: 0.8 }} />
                                                        <span
                                                            className="text-[15px] font-black uppercase tracking-[0.14em] leading-none whitespace-nowrap"
                                                            style={{ color: accent, textShadow: `0 0 20px ${accent}55` }}
                                                        >
                                                            {g.label}
                                                        </span>
                                                        <span className="text-[9px] font-black uppercase tracking-[0.18em] text-gray-500 whitespace-nowrap">
                                                            {g.sessions.length} {g.sessions.length === 1 ? 'Session' : 'Sessions'}
                                                        </span>
                                                        <ChevronDown
                                                            size={15}
                                                            className={`ml-auto self-center transition-transform duration-300 ${open ? 'rotate-180 text-gray-400' : 'text-gray-600 group-hover/class:text-gray-400'}`}
                                                        />
                                                    </button>
                                                    {/* Each class scrolls in its own pane, so one
                                                        heavily-driven class can't run the expanded
                                                        track to full page height. Header stays put. */}
                                                    <AnimatePresence initial={false}>
                                                        {open && (
                                                            <motion.div
                                                                initial={{ height: 0, opacity: 0 }}
                                                                animate={{ height: 'auto', opacity: 1 }}
                                                                exit={{ height: 0, opacity: 0 }}
                                                                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                                                                className="overflow-hidden"
                                                            >
                                                                <div className="flex flex-col gap-2 max-h-[528px] overflow-y-auto pr-1">
                                                                    {g.sessions.map(renderSession)}
                                                                </div>
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </div>
                                            );
                                        })}
                                    </div>
                                ))
                                : row.sessions.map(renderSession)}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

/** A track's quickest clean lap in one car class. */
interface ClassRecord {
    key: string;
    label: string;
    time: number;
    car?: string;
    driver?: string;
    sessionId: string;
    recordedAt?: number;
    /** Sessions run in this class here -- valid lap or not. */
    attempts: number;
}

interface RecordRow {
    key: string;
    name: string;
    short: string;
    /** Named only where the circuit has more than one variant in view. */
    layoutLabel?: string;
    country?: string;
    image: string;
    byClass: Map<string, ClassRecord>;
    /** Class holding the track's outright best lap. */
    bestKey?: string;
    sessionCount: number;
    lastDriven: number;
}

/** 'track' | 'recent' | a car-class key. */
type RecordSort = { key: string; dir: 'asc' | 'desc' };

const RecordCell = ({ rec, isBest, onOpen }: { rec?: ClassRecord; isBest: boolean; onOpen: () => void }) => {
    if (!rec) {
        return (
            <div className="flex items-center justify-center px-3 py-2.5 min-h-[52px]">
                <span className="text-[11px] font-mono font-bold text-gray-700">—</span>
            </div>
        );
    }
    const car = getCompactCarName(rec.car);
    const when = formatShortDate(rec.recordedAt);
    return (
        <Tooltip
            className="w-full"
            position="top"
            text={`${rec.car || 'UNKNOWN CAR'} · ${when}${rec.driver ? ` · ${rec.driver}` : ''} · ${rec.attempts} ${rec.attempts === 1 ? 'SESSION' : 'SESSIONS'}`}
        >
            <button
                type="button"
                onClick={onOpen}
                onMouseMove={(e) => handleGlassMouseMove(e, 0.15)}
                className="w-full flex flex-col items-start gap-1 px-3 py-2 min-h-[52px] rounded-lg border border-transparent hover:border-blue-500/30 hover:bg-blue-600/10 transition-all text-left"
            >
                <span className="flex items-center gap-1.5">
                    {isBest && <Trophy size={10} className="text-amber-400 flex-shrink-0" />}
                    <span className={`text-[13px] font-mono font-black tabular-nums ${isBest ? 'text-amber-300' : 'text-white'}`}>
                        {formatLapTime(rec.time)}
                    </span>
                </span>
                <span className="flex items-center gap-1.5 min-w-0 w-full">
                    <CarBrandLogo name={rec.car} carClass={rec.key} size={14} />
                    <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400 truncate">{car || '—'}</span>
                </span>
            </button>
        </Tooltip>
    );
};

/** Sort caret on a record-board column header; hidden until that column sorts. */
const SortMark = ({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) => (
    <ChevronDown
        size={11}
        className={`transition-all ${active ? `text-blue-400 ${dir === 'asc' ? 'rotate-180' : ''}` : 'text-transparent group-hover/head:text-gray-600'}`}
    />
);

/**
 * Record board: one row per circuit, one column per car class, each cell the
 * quickest clean lap there and the car that set it.
 *
 * Lap times only compare within a column -- a Hypercar lap against a GT3 lap
 * says nothing -- so the classes stay side by side rather than merged into a
 * single "best" number, and a column header sorts by that class alone.
 */
const TrackRecordsTable = ({ rows, classes, sort, onSort, onOpenSession }: {
    rows: RecordRow[];
    classes: { key: string; label: string }[];
    sort: RecordSort;
    onSort: (key: string) => void;
    onOpenSession: (id: string) => void;
}) => {
    const gridTemplate = `minmax(220px, 1.6fr) repeat(${classes.length}, minmax(150px, 1fr))`;
    // Each class owns a hue: it rails its column header and tints that column's
    // left edge all the way down, so a cell's category reads without tracing
    // back up to the header.
    const accentOf = new Map(classes.map(c => [c.key, getClassAccent(c.key)]));

    return (
        <div className="rounded-2xl border border-white/[0.07] bg-[#16161c] overflow-hidden">
            <div className="overflow-x-auto custom-scrollbar">
                <div style={{ minWidth: `${220 + classes.length * 150}px` }}>
                    {/* Column headers -- click to sort */}
                    <div
                        className="grid items-stretch border-b border-white/[0.07] bg-black/25"
                        style={{ gridTemplateColumns: gridTemplate }}
                    >
                        <button
                            type="button"
                            onClick={() => onSort('track')}
                            className="group/head relative flex items-center gap-1.5 px-4 pt-4 pb-3.5 text-left"
                        >
                            <span className="absolute inset-x-0 top-0 h-[2px] bg-white/10" />
                            <span className={`text-[10px] font-black uppercase tracking-[0.18em] leading-none ${sort.key === 'track' ? 'text-white' : 'text-gray-500 group-hover/head:text-gray-300'}`}>
                                Circuit
                            </span>
                            <SortMark active={sort.key === 'track'} dir={sort.dir} />
                        </button>
                        {classes.map(c => {
                            const accent = accentOf.get(c.key) as string;
                            const active = sort.key === c.key;
                            return (
                                <button
                                    key={c.key}
                                    type="button"
                                    onClick={() => onSort(c.key)}
                                    className="group/head relative flex items-center gap-2 px-3.5 pt-4 pb-3.5 border-l border-white/[0.05] overflow-hidden"
                                    style={{ background: `linear-gradient(180deg, ${accent}${active ? '2e' : '14'}, transparent 90%)` }}
                                >
                                    {/* Colour rail: the class identity, at a size you can actually see. */}
                                    <span
                                        className="absolute inset-x-0 top-0 h-[2px] transition-opacity"
                                        style={{ backgroundColor: accent, opacity: active ? 1 : 0.6 }}
                                    />
                                    <span className="absolute inset-0 bg-white/[0.03] opacity-0 group-hover/head:opacity-100 transition-opacity" />
                                    <span
                                        className="relative text-[11px] font-black uppercase tracking-[0.14em] leading-none whitespace-nowrap"
                                        style={{ color: accent, textShadow: `0 0 16px ${accent}55` }}
                                    >
                                        {c.label}
                                    </span>
                                    <SortMark active={active} dir={sort.dir} />
                                </button>
                            );
                        })}
                    </div>

                    {/* One row per circuit */}
                    {rows.map(row => {
                        const flag = getCountryFlagPath(row.country);
                        return (
                            <div
                                key={row.key}
                                className="group/rec grid items-center border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.02] transition-colors"
                                style={{ gridTemplateColumns: gridTemplate }}
                            >
                                <div className="flex items-center gap-3 px-4 py-2.5 min-w-0">
                                    <div className="flex-shrink-0 w-12 h-9 rounded-md bg-black/30 border border-white/5 flex items-center justify-center p-1">
                                        <TrackMapImage src={row.image} active={false} />
                                    </div>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                            {flag && (
                                                <img
                                                    src={flag}
                                                    alt={row.country}
                                                    className="w-4 h-auto rounded-[1px] border border-white/15 flex-shrink-0"
                                                    onError={(e) => (e.currentTarget.style.display = 'none')}
                                                />
                                            )}
                                            <span className="text-[12px] font-black uppercase tracking-tight text-gray-100 truncate">{row.name}</span>
                                            {/* Each layout is its own record: a
                                                short-circuit lap is not a record
                                                on the full one. */}
                                            {row.layoutLabel && (
                                                <span className="flex-shrink-0 text-[7px] font-black uppercase tracking-[0.18em] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300/90">
                                                    {row.layoutLabel}
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-[9px] font-bold uppercase tracking-widest text-gray-600">
                                            {row.sessionCount} {row.sessionCount === 1 ? 'Session' : 'Sessions'} · {formatShortDate(row.lastDriven)}
                                        </span>
                                    </div>
                                </div>
                                {classes.map(c => {
                                    const rec = row.byClass.get(c.key);
                                    return (
                                        <div
                                            key={c.key}
                                            className="px-1 py-1 min-w-0 border-l"
                                            style={{ borderLeftColor: `${accentOf.get(c.key)}22` }}
                                        >
                                            <RecordCell
                                                rec={rec}
                                                isBest={!!rec && row.bestKey === c.key}
                                                onOpen={() => rec && onOpenSession(rec.sessionId)}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export const TrackLibrary = memo(({ game, onBack, onOpenSession }: TrackLibraryProps) => {
    const sessions = useTelemetryStore(state => state.sessions);
    const uploadSession = useTelemetryStore(state => state.uploadSession);
    const deleteSession = useTelemetryStore(state => state.deleteSession);
    const deleteSessions = useTelemetryStore(state => state.deleteSessions);
    const isListLoading = useTelemetryStore(state => state.isListLoading);

    const [searchQuery, setSearchQuery] = useState('');
    // Two ways into the same library: the session browser, and the record board
    // (fastest lap per track per car class).
    const [view, setView] = useState<'sessions' | 'records'>('sessions');
    const [recordSort, setRecordSort] = useState<RecordSort>({ key: 'track', dir: 'asc' });
    const [sourceFilter, setSourceFilter] = useState<'all' | 'sync' | 'manual'>('all');
    // Track index + car-class chips above the list. Track is single-select (it
    // narrows to one circuit); class is multi-select (GT3 *and* GTE is useful).
    const [trackFilter, setTrackFilter] = useState<string | null>(null);
    const [classFilter, setClassFilter] = useState<Set<string>>(new Set());
    // Cars are a drill-down of the class selection: pick GT3, then narrow to the
    // GT3 cars you actually ran. Empty until at least one class is picked.
    const [carFilter, setCarFilter] = useState<Set<string>>(new Set());
    // Default: only driven tracks. Toggling "Driven" reveals the rest of the
    // (undriven) roster too.
    const [showUndriven, setShowUndriven] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [expandedKey, setExpandedKey] = useState<string | null>(null);
    const [selectMode, setSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const meta = GAME_META[game];

    const rows = useMemo<TrackRow[]>(() => {
        const scoped = sessions.filter(s =>
            (s.game || 'LMU') === game &&
            (sourceFilter === 'all' || (s.source || 'manual') === sourceFilter) &&
            (classFilter.size === 0 || classFilter.has(getCarClassBucket(s.carClass)?.key || 'UNKNOWN')) &&
            (carFilter.size === 0 || carFilter.has(s.carModel || '')));
        const q = searchQuery.trim().toLowerCase();

        const map = new Map<string, TrackRow>();
        const ensure = (trackKey: string, layoutKey: string, name: string, short: string, country: string | undefined, image: string): TrackRow => {
            const key = `${trackKey}::${layoutKey}`;
            let row = map.get(key);
            if (!row) {
                row = { key, trackKey, layoutKey, name, short, country, image, sessions: [], bestLap: Infinity, lastDriven: 0, carCount: 0 };
                map.set(key, row);
            }
            return row;
        };

        // When "Driven" is toggled off, also seed the full ACC roster so the
        // undriven tracks (0 sessions) show. Skipped when filtering by source --
        // a roster track has no sessions of either provenance.
        if (game === 'ACC' && showUndriven && sourceFilter === 'all') {
            ACC_TRACK_ROSTER.forEach(t => ensure(t.key, 'Default', t.name, t.name, t.country, `/acc-tracks/${t.key}.svg`));
        }

        scoped.forEach(s => {
            const rawName = s.displayName || s.commonTrackName || s.trackName || 'Unknown Track';
            const info = matchTrack(rawName);
            // One row per circuit *layout*: a lap of Lusail's short circuit
            // belongs in neither the session list nor the best-lap column of
            // the full circuit, and vice versa.
            const row = ensure(
                info ? info.key : rawName.toLowerCase(),
                getLayoutKey(s),
                info ? info.name : rawName,
                // The backend's display_name is already the short form.
                s.displayName || rawName,
                info ? info.country : s.country,
                info ? `/acc-tracks/${info.key}.svg` : getTrackImagePath(rawName),
            );
            row.sessions.push(s);
            if (s.bestLapValid && s.bestLapTime != null && s.bestLapTime < row.bestLap) row.bestLap = s.bestLapTime;
            const epoch = s.recordedAt ?? s.created ?? 0;
            if (epoch > row.lastDriven) row.lastDriven = epoch;
        });

        let list = Array.from(map.values());

        // When searching, keep only tracks whose name matches or that have
        // sessions matching the query (car / driver / class / layout).
        if (q) {
            list = list.filter(r => {
                if (r.name.toLowerCase().includes(q) || r.layoutKey.toLowerCase().includes(q)) return true;
                r.sessions = r.sessions.filter(s =>
                    (s.carModel || '').toLowerCase().includes(q) ||
                    (s.carClass || '').toLowerCase().includes(q) ||
                    (s.driverName || '').toLowerCase().includes(q) ||
                    (s.trackLayout || '').toLowerCase().includes(q));
                return r.sessions.length > 0;
            });
        }

        list.forEach(r => {
            r.sessions.sort((a, b) => (b.recordedAt ?? b.created ?? 0) - (a.recordedAt ?? a.created ?? 0));
            r.carCount = new Set(r.sessions.map(s => s.carModel).filter(Boolean)).size;
        });
        applyLayoutLabels(list);

        // Recorded tracks first (by most-recently driven), then the rest A-Z.
        // Circuits are ranked by their most recent lap on *any* layout, so a
        // track's variants stay adjacent instead of scattering down the list.
        const trackRecency = new Map<string, number>();
        list.forEach(r => trackRecency.set(r.trackKey, Math.max(trackRecency.get(r.trackKey) || 0, r.lastDriven)));
        list.sort((a, b) => {
            const aHas = a.sessions.length > 0 ? 1 : 0;
            const bHas = b.sessions.length > 0 ? 1 : 0;
            if (aHas !== bHas) return bHas - aHas;
            if (a.trackKey !== b.trackKey) {
                if (aHas && bHas) return (trackRecency.get(b.trackKey) || 0) - (trackRecency.get(a.trackKey) || 0);
                return a.name.localeCompare(b.name);
            }
            return b.lastDriven - a.lastDriven || a.layoutKey.localeCompare(b.layoutKey);
        });

        return list;
    }, [sessions, game, searchQuery, sourceFilter, showUndriven, classFilter, carFilter]);

    // Track index chips: every driven circuit layout, A-Z, with the count left
    // after the class/source/search filters. Selecting one narrows the list to
    // that layout -- the chip names it whenever the track has more than one.
    const trackChips = useMemo(
        () => rows.filter(r => r.sessions.length > 0)
            .map(r => ({
                key: r.key,
                label: r.layoutLabel ? `${r.short} · ${r.layoutLabel}` : r.short,
                country: r.country,
                count: r.sessions.length,
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        [rows]);

    // Class chips are counted across the whole sim (not the current track), so
    // the numbers don't jump around as you click through circuits.
    const classChips = useMemo(() => {
        const counts = new Map<string, { key: string; label: string; count: number }>();
        sessions.forEach(s => {
            if ((s.game || 'LMU') !== game) return;
            if (sourceFilter !== 'all' && (s.source || 'manual') !== sourceFilter) return;
            const bucket = getCarClassBucket(s.carClass);
            if (!bucket) return;
            const entry = counts.get(bucket.key) || { ...bucket, count: 0 };
            entry.count++;
            counts.set(bucket.key, entry);
        });
        return Array.from(counts.values()).sort((a, b) => {
            const ai = CAR_CLASS_ORDER.indexOf(a.key);
            const bi = CAR_CLASS_ORDER.indexOf(b.key);
            if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
            return a.label.localeCompare(b.label);
        });
    }, [sessions, game, sourceFilter]);

    // Cars belonging to the selected class(es), most-driven first. Counts ignore
    // the car selection itself so the chips never shrink out from under you.
    const carChips = useMemo(() => {
        // A sim with a single class (ACC = GT3) has no class strip to click, so
        // its cars are offered straight away.
        const active = classFilter.size > 0
            ? classFilter
            : classChips.length === 1 ? new Set([classChips[0].key]) : null;
        if (!active) return [];
        const counts = new Map<string, number>();
        sessions.forEach(s => {
            if ((s.game || 'LMU') !== game) return;
            if (sourceFilter !== 'all' && (s.source || 'manual') !== sourceFilter) return;
            if (!active.has(getCarClassBucket(s.carClass)?.key || 'UNKNOWN')) return;
            const car = s.carModel;
            if (!car) return;
            counts.set(car, (counts.get(car) || 0) + 1);
        });
        return Array.from(counts.entries())
            .map(([label, count]) => ({ key: label, label, count }))
            .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    }, [sessions, game, sourceFilter, classFilter, classChips]);

    // The list itself, after the track chip selection.
    const visibleRows = useMemo(
        () => (trackFilter ? rows.filter(r => r.key === trackFilter) : rows),
        [rows, trackFilter]);

    // ---- Record board -------------------------------------------------------
    // Built from the same filtered rows as the session list, so the search /
    // source / class / car chips narrow both views identically.

    const recordRows = useMemo<RecordRow[]>(() => visibleRows
        .filter(r => r.sessions.length > 0)
        .map(r => {
            const byClass = new Map<string, ClassRecord>();
            const attempts = new Map<string, number>();
            r.sessions.forEach(s => {
                const bucket = getCarClassBucket(s.carClass);
                if (!bucket) return;
                attempts.set(bucket.key, (attempts.get(bucket.key) || 0) + 1);
                // Invalid laps still count as an attempt, but never as a record.
                if (!s.bestLapValid || s.bestLapTime == null) return;
                const cur = byClass.get(bucket.key);
                if (cur && cur.time <= s.bestLapTime) return;
                byClass.set(bucket.key, {
                    key: bucket.key,
                    label: bucket.label,
                    time: s.bestLapTime,
                    car: s.carModel,
                    driver: s.driverName,
                    sessionId: s.id,
                    recordedAt: s.recordedAt ?? s.created,
                    attempts: 0,
                });
            });
            let bestKey: string | undefined;
            byClass.forEach(rec => {
                rec.attempts = attempts.get(rec.key) || 0;
                const best = bestKey ? byClass.get(bestKey) : undefined;
                if (!best || rec.time < best.time) bestKey = rec.key;
            });
            return {
                key: r.key,
                name: r.name,
                short: r.short,
                layoutLabel: r.layoutLabel,
                country: r.country,
                image: r.image,
                byClass,
                bestKey,
                sessionCount: r.sessions.length,
                lastDriven: r.lastDriven,
            };
        })
        .filter(r => r.byClass.size > 0),
        [visibleRows]);

    // Columns: every class that actually holds a record in the current view.
    const recordClasses = useMemo(() => {
        const seen = new Map<string, string>();
        recordRows.forEach(r => r.byClass.forEach(rec => seen.set(rec.key, rec.label)));
        return Array.from(seen.entries())
            .map(([key, label]) => ({ key, label }))
            .sort((a, b) => {
                const ai = RECORD_CLASS_ORDER.indexOf(a.key);
                const bi = RECORD_CLASS_ORDER.indexOf(b.key);
                if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
                return a.label.localeCompare(b.label);
            });
    }, [recordRows]);

    const sortedRecordRows = useMemo(() => {
        const list = [...recordRows];
        const flip = recordSort.dir === 'asc' ? 1 : -1;
        // Two rows of one circuit share a name, so the layout breaks the tie --
        // and does so in the same direction, keeping them adjacent.
        const byName = (a: RecordRow, b: RecordRow) =>
            a.name.localeCompare(b.name) || (a.layoutLabel || '').localeCompare(b.layoutLabel || '');
        if (recordSort.key === 'track') {
            list.sort((a, b) => byName(a, b) * flip);
        } else {
            // Sorting by a class ranks on that class's lap alone; circuits with
            // no lap in it drop to the bottom either way rather than sorting as
            // if they were infinitely slow (or fast).
            list.sort((a, b) => {
                const at = a.byClass.get(recordSort.key)?.time;
                const bt = b.byClass.get(recordSort.key)?.time;
                if (at == null && bt == null) return byName(a, b);
                if (at == null) return 1;
                if (bt == null) return -1;
                return (at - bt) * flip;
            });
        }
        return list;
    }, [recordRows, recordSort]);

    const recordCount = useMemo(
        () => recordRows.reduce((n, r) => n + r.byClass.size, 0),
        [recordRows]);

    // Clicking the active column flips direction; a new column starts fastest-first.
    const toggleRecordSort = (key: string) => {
        setRecordSort(prev => prev.key === key
            ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
            : { key, dir: 'asc' });
    };

    // The record board has nothing to select or delete.
    useEffect(() => {
        if (view === 'records' && selectMode) {
            setSelectMode(false);
            setSelectedIds(new Set());
        }
    }, [view, selectMode]);

    // A column that filtered away (class chip, game switch) can't stay the sort key.
    useEffect(() => {
        if (recordSort.key === 'track') return;
        if (!recordClasses.some(c => c.key === recordSort.key)) setRecordSort({ key: 'track', dir: 'asc' });
    }, [recordClasses, recordSort]);

    const filtersActive = !!trackFilter || classFilter.size > 0 || carFilter.size > 0;

    const clearFilters = () => {
        setTrackFilter(null);
        setClassFilter(new Set());
        setCarFilter(new Set());
    };

    const selectTrack = (key: string | null) => {
        setTrackFilter(key);
        // A single-track view is only useful already opened.
        setExpandedKey(key);
    };

    const toggleClass = (key: string) => {
        setClassFilter(prev => {
            const next = new Set(prev);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });
    };

    const toggleCar = (key: string) => {
        setCarFilter(prev => {
            const next = new Set(prev);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });
    };

    // Drop a selection that no longer exists (game switch, class filter change,
    // last session on that track deleted) so the list can never come up empty.
    useEffect(() => {
        if (trackFilter && !rows.some(r => r.key === trackFilter)) setTrackFilter(null);
    }, [rows, trackFilter]);

    useEffect(() => {
        if (classFilter.size === 0) return;
        const available = new Set(classChips.map(c => c.key));
        if (Array.from(classFilter).some(k => !available.has(k))) {
            setClassFilter(prev => new Set(Array.from(prev).filter(k => available.has(k))));
        }
    }, [classChips, classFilter]);

    // Dropping a class (or clearing them all) drops the cars that came with it.
    useEffect(() => {
        if (carFilter.size === 0) return;
        const available = new Set(carChips.map(c => c.key));
        if (Array.from(carFilter).some(k => !available.has(k))) {
            setCarFilter(prev => new Set(Array.from(prev).filter(k => available.has(k))));
        }
    }, [carChips, carFilter]);

    const totalSessions = useMemo(() => sessions.filter(s => (s.game || 'LMU') === game).length, [sessions, game]);
    const recordedTracks = useMemo(() => rows.filter(r => r.sessions.length > 0).length, [rows]);

    // Provenance counts (per game) for the Synced / Manual filter.
    const sourceCounts = useMemo(() => {
        let sync = 0, manual = 0;
        sessions.forEach(s => {
            if ((s.game || 'LMU') !== game) return;
            if ((s.source || 'manual') === 'sync') sync++; else manual++;
        });
        return { all: sync + manual, sync, manual };
    }, [sessions, game]);

    // The Synced/Manual split shows once a sim has at least one synced session
    // (both ACC and LMU support game-folder sync).
    const showSourceFilter = sourceCounts.sync > 0;

    // Reset to "All" whenever the filter is no longer available (game switch,
    // or the last synced session was removed) so we never show an empty list.
    useEffect(() => {
        if (!showSourceFilter && sourceFilter !== 'all') setSourceFilter('all');
    }, [showSourceFilter, sourceFilter]);

    // Flat list of every session id currently visible (respects search filter).
    const visibleIds = useMemo(() => visibleRows.flatMap(r => r.sessions.map(s => s.id)), [visibleRows]);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));
    const selectedCount = selectedIds.size;

    const toggleSelect = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const toggleTrack = (row: TrackRow) => {
        const ids = row.sessions.map(s => s.id);
        const everySelected = ids.every(id => selectedIds.has(id));
        setSelectedIds(prev => {
            const next = new Set(prev);
            ids.forEach(id => (everySelected ? next.delete(id) : next.add(id)));
            return next;
        });
    };

    const toggleSelectAll = () => {
        setSelectedIds(allSelected ? new Set() : new Set(visibleIds));
    };

    const exitSelectMode = () => {
        setSelectMode(false);
        setSelectedIds(new Set());
    };

    const handleConfirmDelete = async () => {
        setIsDeleting(true);
        try {
            await deleteSessions(Array.from(selectedIds));
        } finally {
            setIsDeleting(false);
            setConfirmOpen(false);
            exitSelectMode();
        }
    };

    const handleFiles = async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        setIsUploading(true);
        try {
            // Pair each .ld with its .ldx sidecar so multi-lap stints keep their
            // lap boundaries; standalone .ldx files are dropped.
            for (const { file, sidecar } of pairTelemetryUploads(Array.from(files))) {
                await uploadSession(file, sidecar);
            }
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    return (
        <div className="relative flex-1 min-h-0 overflow-y-auto custom-scrollbar bg-[#0a0a0f]">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(37,99,235,0.10),transparent_70%)]" />

            {/* Wide shell: the session rows and the two class columns both want the
                room. Still capped, so the header and chips don't sprawl on an
                ultrawide. */}
            <div className="relative max-w-[1800px] mx-auto px-6 xl:px-10 py-8">
                {/* Header */}
                <div className="flex items-center gap-4 mb-2">
                    <Tooltip text="BACK TO SIM SELECT" position="bottom">
                        <button
                            onClick={onBack}
                            className="flex items-center justify-center w-10 h-10 rounded-xl border border-white/10 bg-[#16161c] text-gray-400 hover:text-white hover:border-white/20 transition-all glass-container"
                            onMouseMove={(e) => handleGlassMouseMove(e, 0.2)}
                        >
                            <div className="glass-content"><ArrowLeft size={18} /></div>
                        </button>
                    </Tooltip>
                    <img src={meta.logo} alt={meta.name} className="h-8 w-8 object-contain [filter:brightness(0)_invert(1)]" />
                    <div>
                        <h1 className="text-2xl md:text-3xl font-black uppercase tracking-tight text-white leading-none">{meta.name}</h1>
                        <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest mt-1">Track Library</p>
                    </div>

                    {/* Game-folder sync lives beside the sim title. */}
                    <div className="ml-auto flex items-center">
                        {game === 'ACC' && <AccSyncControl />}
                        {game === 'LMU' && <LmuSyncControl />}
                    </div>
                </div>

                {/* Views: browse the sessions, or read the record board. */}
                <div className="flex items-center gap-1 mt-6 border-b border-white/[0.07]">
                    {([
                        { key: 'sessions', label: 'Sessions', icon: Layers, count: totalSessions },
                        { key: 'records', label: 'Records', icon: Trophy, count: recordCount },
                    ] as const).map(tab => {
                        const active = view === tab.key;
                        const Icon = tab.icon;
                        return (
                            <button
                                key={tab.key}
                                type="button"
                                onClick={() => setView(tab.key)}
                                className={`relative flex items-center gap-2 h-10 px-4 font-black text-[10px] uppercase tracking-widest transition-colors ${
                                    active ? 'text-white' : 'text-gray-500 hover:text-gray-200'
                                }`}
                            >
                                <Icon size={13} className={active ? 'text-blue-400' : undefined} />
                                {tab.label}
                                <span className={`text-[9px] font-mono ${active ? 'text-blue-300/70' : 'text-gray-600'}`}>{tab.count}</span>
                                {active && <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-blue-500" />}
                            </button>
                        );
                    })}
                </div>

                {/* Toolbar */}
                <div className="flex items-center gap-3 mt-5 mb-6">
                    {view === 'sessions' && (selectMode ? (
                        <Tooltip text={allSelected ? 'DESELECT ALL' : 'SELECT ALL'} position="bottom">
                            <button
                                onClick={toggleSelectAll}
                                disabled={visibleIds.length === 0}
                                className="flex items-center justify-center w-10 h-10 rounded-xl bg-[#16161c] border border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-all disabled:opacity-40"
                            >
                                {allSelected ? <CheckSquare size={16} className="text-blue-400" /> : <Square size={16} />}
                            </button>
                        </Tooltip>
                    ) : (
                        <Tooltip text="SELECT" position="bottom">
                            <button
                                onClick={() => setSelectMode(true)}
                                disabled={totalSessions === 0}
                                className="flex items-center justify-center w-10 h-10 rounded-xl bg-[#16161c] border border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-all disabled:opacity-40"
                            >
                                <CheckSquare size={16} />
                            </button>
                        </Tooltip>
                    ))}
                    <div className="relative flex-1 max-w-md xl:max-w-xl">
                        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                        <input
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search tracks, cars, drivers..."
                            className="w-full h-10 pl-9 pr-3 rounded-xl bg-[#16161c] border border-white/10 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                    </div>

                    {/* Source filter: All / Synced / Manual (ACC only) */}
                    {showSourceFilter && (
                        <div className="flex items-center h-10 p-1 rounded-xl bg-[#16161c] border border-white/10">
                            {([
                                { key: 'all', label: 'All', count: sourceCounts.all, icon: Layers },
                                { key: 'sync', label: 'Synced', count: sourceCounts.sync, icon: RefreshCw },
                                { key: 'manual', label: 'Manual', count: sourceCounts.manual, icon: Upload },
                            ] as const).map(opt => {
                                const active = sourceFilter === opt.key;
                                const Icon = opt.icon;
                                return (
                                    <button
                                        key={opt.key}
                                        onClick={() => setSourceFilter(opt.key)}
                                        className={`flex items-center gap-1.5 h-8 px-3 rounded-lg font-black text-[10px] uppercase tracking-widest transition-all ${
                                            active
                                                ? 'bg-blue-600/25 text-blue-200 border border-blue-500/40'
                                                : 'text-gray-500 hover:text-gray-200 border border-transparent'
                                        }`}
                                    >
                                        <Icon size={12} className={opt.key === 'sync' && active ? 'text-blue-300' : undefined} />
                                        {opt.label}
                                        <span className={`text-[9px] ${active ? 'text-blue-300/70' : 'text-gray-600'}`}>{opt.count}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {view === 'sessions' && (
                    <Tooltip text={showUndriven ? 'SHOWING ALL TRACKS' : 'SHOW ALL TRACKS'} position="bottom">
                        <button
                            onClick={() => setShowUndriven(v => !v)}
                            className={`hidden lg:flex items-center gap-1.5 px-3 h-10 rounded-xl border font-black text-[10px] uppercase tracking-widest transition-all ${
                                !showUndriven
                                    ? 'bg-blue-600/25 border-blue-500/40 text-blue-200'
                                    : 'bg-[#16161c] border-white/10 text-gray-500 hover:text-gray-200 hover:border-white/20'
                            }`}
                        >
                            <MapPin size={12} className={!showUndriven ? 'text-blue-300' : 'text-blue-400'} /> {recordedTracks} Driven
                        </button>
                    </Tooltip>
                    )}

                    <input ref={fileInputRef} type="file" multiple accept=".duckdb,.ld,.ldx,.csv" className="hidden" onChange={(e) => handleFiles(e.target.files)} />

                    <div className="flex items-center gap-2 ml-auto">
                    {selectMode ? (
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setConfirmOpen(true)}
                                disabled={selectedCount === 0}
                                className="flex items-center gap-2 h-10 px-4 rounded-xl bg-red-600/20 border border-red-500/40 text-red-300 hover:bg-red-600/30 hover:text-white transition-all font-black text-[10px] uppercase tracking-widest disabled:opacity-40 disabled:hover:bg-red-600/20"
                            >
                                <Trash2 size={14} />
                                Delete{selectedCount > 0 ? ` (${selectedCount})` : ''}
                            </button>
                            <Tooltip text="CANCEL SELECTION" position="bottom">
                                <button
                                    onClick={exitSelectMode}
                                    className="flex items-center justify-center w-10 h-10 rounded-xl bg-[#16161c] border border-white/10 text-gray-400 hover:text-white hover:border-white/20 transition-all"
                                >
                                    <X size={16} />
                                </button>
                            </Tooltip>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isUploading}
                                className="flex items-center gap-2 h-10 px-4 rounded-xl bg-blue-600/20 border border-blue-500/30 text-blue-300 hover:bg-blue-600/30 hover:text-white transition-all font-black text-[10px] uppercase tracking-widest disabled:opacity-50 glass-container"
                                onMouseMove={(e) => handleGlassMouseMove(e, 0.2)}
                            >
                                <div className="glass-content flex items-center gap-2">
                                    {isUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                                    Upload
                                </div>
                            </button>
                        </div>
                    )}
                    </div>
                </div>

                {/* Track index + class filters, side by side: a browsable list of
                    every circuit (with its flag) rather than only a most-recent-first
                    feed, and the car classes beside it. Picking a class opens a third
                    strip with that class's cars. */}
                {(trackChips.length > 1 || classChips.length > 1 || carChips.length > 0) && (
                    <div className="mb-6 rounded-2xl border border-white/[0.07] bg-[#121218] p-4">
                        <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-y-4 gap-x-5">
                            {trackChips.length > 1 && (
                                <FilterStrip
                                    label="Tracks"
                                    hint={trackFilter ? '1 selected' : `${trackChips.length} circuits`}
                                    cols={classChips.length > 1
                                        ? 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4'
                                        : 'grid-cols-2 md:grid-cols-4 xl:grid-cols-6'}
                                    className={classChips.length > 1 ? '' : 'lg:col-span-2'}
                                >
                                    <FilterChip
                                        active={!trackFilter}
                                        onClick={() => selectTrack(null)}
                                        leading={<Globe size={11} />}
                                        label="All"
                                        count={trackChips.reduce((n, t) => n + t.count, 0)}
                                    />
                                    {trackChips.map(t => {
                                        const flag = getCountryFlagPath(t.country);
                                        return (
                                            <FilterChip
                                                key={t.key}
                                                active={trackFilter === t.key}
                                                onClick={() => selectTrack(trackFilter === t.key ? null : t.key)}
                                                leading={flag
                                                    ? <img src={flag} alt={t.country} className="w-4 h-auto rounded-[1px] border border-white/15" onError={(e) => (e.currentTarget.style.display = 'none')} />
                                                    : <MapPin size={11} />}
                                                label={t.label}
                                                count={t.count}
                                            />
                                        );
                                    })}
                                </FilterStrip>
                            )}

                            {classChips.length > 1 && (
                                <FilterStrip
                                    label="Class"
                                    hint={classFilter.size ? `${classFilter.size} selected` : 'pick one to see its cars'}
                                    cols={trackChips.length > 1 ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-2 md:grid-cols-4 xl:grid-cols-6'}
                                    className={trackChips.length > 1
                                        ? 'lg:border-l lg:border-white/[0.06] lg:pl-5'
                                        : 'lg:col-span-2'}
                                >
                                    <FilterChip
                                        active={classFilter.size === 0}
                                        onClick={() => { setClassFilter(new Set()); setCarFilter(new Set()); }}
                                        leading={<Car size={11} />}
                                        label="All"
                                        count={classChips.reduce((n, c) => n + c.count, 0)}
                                    />
                                    {classChips.map(c => {
                                        const accent = getClassAccent(c.key);
                                        const on = classFilter.has(c.key);
                                        return (
                                            <FilterChip
                                                key={c.key}
                                                active={on}
                                                onClick={() => toggleClass(c.key)}
                                                accent={accent}
                                                // The hue is the class -- it stays lit whether the
                                                // chip is on or off, so the strip reads as a legend.
                                                leading={
                                                    <span
                                                        className="w-2 h-2 rounded-full transition-all"
                                                        style={{
                                                            backgroundColor: accent,
                                                            opacity: on ? 1 : 0.8,
                                                            boxShadow: `0 0 ${on ? 10 : 6}px ${accent}`,
                                                        }}
                                                    />
                                                }
                                                label={c.label}
                                                count={c.count}
                                            />
                                        );
                                    })}
                                </FilterStrip>
                            )}
                        </div>

                        {/* Cars in the selected class(es). */}
                        <AnimatePresence initial={false}>
                            {carChips.length > 0 && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                                    className="overflow-hidden"
                                >
                                    <FilterStrip
                                        label="Cars"
                                        hint={carFilter.size ? `${carFilter.size} selected` : undefined}
                                        cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-4"
                                        className="mt-4 pt-4 border-t border-white/[0.06]"
                                    >
                                        <FilterChip
                                            active={carFilter.size === 0}
                                            onClick={() => setCarFilter(new Set())}
                                            leading={<Car size={11} />}
                                            label="All"
                                            count={carChips.reduce((n, c) => n + c.count, 0)}
                                        />
                                        {carChips.map(c => (
                                            <FilterChip
                                                key={c.key}
                                                active={carFilter.has(c.key)}
                                                onClick={() => toggleCar(c.key)}
                                                leading={<CarBrandLogo name={c.label} size={16} />}
                                                label={c.label}
                                                count={c.count}
                                            />
                                        ))}
                                    </FilterStrip>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                )}

                {/* Track list */}
                {isListLoading && rows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-32 text-gray-500">
                        <Loader2 size={28} className="animate-spin mb-3" />
                        <span className="text-sm font-bold uppercase tracking-widest">Loading Sessions...</span>
                    </div>
                ) : view === 'records' ? (
                    sortedRecordRows.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-32 text-center">
                            <div className="w-16 h-16 rounded-2xl bg-[#16161c] border border-white/10 flex items-center justify-center mb-4">
                                <Trophy size={26} className="text-gray-600" />
                            </div>
                            <p className="text-lg font-black text-gray-300 uppercase tracking-tight">No records yet</p>
                            <p className="text-sm text-gray-500 mt-1 max-w-sm">
                                {searchQuery || filtersActive
                                    ? 'Nothing matches the current search or filters.'
                                    : 'Records come from clean laps -- run a valid lap in any class to put a time on the board.'}
                            </p>
                            {filtersActive && (
                                <button
                                    onClick={clearFilters}
                                    className="mt-5 h-9 px-4 rounded-xl bg-[#16161c] border border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-all font-black text-[10px] uppercase tracking-widest"
                                >
                                    Clear Filters
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            <div className="flex items-center gap-2 flex-wrap text-[9px] font-black uppercase tracking-[0.18em] text-gray-600">
                                <span className="text-gray-400">{sortedRecordRows.length} {sortedRecordRows.length === 1 ? 'Circuit' : 'Circuits'}</span>
                                <span>·</span>
                                <span className="text-gray-400">{recordCount} {recordCount === 1 ? 'Record' : 'Records'}</span>
                                <span>·</span>
                                <span className="text-gray-400">{recordClasses.length} {recordClasses.length === 1 ? 'Class' : 'Classes'}</span>
                                <span className="ml-auto normal-case tracking-widest text-gray-700">Clean laps only · click a time to open the session</span>
                            </div>
                            <TrackRecordsTable
                                rows={sortedRecordRows}
                                classes={recordClasses}
                                sort={recordSort}
                                onSort={toggleRecordSort}
                                onOpenSession={onOpenSession}
                            />
                        </div>
                    )
                ) : visibleRows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-32 text-center">
                        <div className="w-16 h-16 rounded-2xl bg-[#16161c] border border-white/10 flex items-center justify-center mb-4">
                            <MapPin size={26} className="text-gray-600" />
                        </div>
                        <p className="text-lg font-black text-gray-300 uppercase tracking-tight">
                            {searchQuery ? 'No matches found'
                                : filtersActive ? 'Nothing matches these filters'
                                : sourceFilter !== 'all' ? `No ${sourceFilter === 'sync' ? 'auto-synced' : 'manually uploaded'} sessions`
                                : 'No sessions yet'}
                        </p>
                        <p className="text-sm text-gray-500 mt-1 max-w-sm">
                            {searchQuery ? 'Try a different search term.'
                                : filtersActive ? 'Clear the track or class filter to see your other sessions.'
                                : sourceFilter !== 'all' ? 'Switch the filter back to All to see your other sessions.'
                                : `Upload a ${game} telemetry file to start building your library.`}
                        </p>
                        {filtersActive && (
                            <button
                                onClick={clearFilters}
                                className="mt-5 h-9 px-4 rounded-xl bg-[#16161c] border border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-all font-black text-[10px] uppercase tracking-widest"
                            >
                                Clear Filters
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="flex flex-col gap-2.5">
                        {visibleRows.map(row => (
                            <TrackListRow
                                key={row.key}
                                row={row}
                                expanded={expandedKey === row.key}
                                onToggle={() => setExpandedKey(prev => (prev === row.key ? null : row.key))}
                                onOpenSession={onOpenSession}
                                onDelete={deleteSession}
                                selectMode={selectMode}
                                selectedIds={selectedIds}
                                onToggleSelect={toggleSelect}
                                onToggleTrack={toggleTrack}
                                groupByClass={classFilter.size === 0}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Delete confirmation */}
            <AnimatePresence>
                {confirmOpen && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
                        onClick={() => !isDeleting && setConfirmOpen(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.94, opacity: 0, y: 8 }}
                            animate={{ scale: 1, opacity: 1, y: 0 }}
                            exit={{ scale: 0.94, opacity: 0, y: 8 }}
                            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full max-w-sm rounded-2xl border border-red-500/20 bg-[#141419] p-6 shadow-2xl"
                        >
                            <div className="flex items-center gap-3 mb-4">
                                <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center">
                                    <AlertTriangle size={20} className="text-red-400" />
                                </div>
                                <div>
                                    <h3 className="text-base font-black uppercase tracking-tight text-white leading-none">Delete Sessions</h3>
                                    <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest mt-1">This cannot be undone</p>
                                </div>
                            </div>
                            <p className="text-sm text-gray-300 mb-6">
                                Permanently delete <span className="font-black text-white">{selectedCount}</span> selected session{selectedCount === 1 ? '' : 's'}?
                            </p>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setConfirmOpen(false)}
                                    disabled={isDeleting}
                                    className="flex-1 h-10 rounded-xl bg-[#1c1c24] border border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-all font-black text-[10px] uppercase tracking-widest disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleConfirmDelete}
                                    disabled={isDeleting}
                                    className="flex-1 h-10 rounded-xl bg-red-600/90 hover:bg-red-600 text-white transition-all font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-60"
                                >
                                    {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                                    Delete
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
});
