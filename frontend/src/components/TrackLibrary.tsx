import { memo, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    ArrowLeft, Search, Upload, Loader2, Timer, Trash2, MapPin, Layers, Car,
    ChevronDown, CalendarDays,
} from 'lucide-react';
import { useTelemetryStore } from '../store/telemetryStore';
import type { Session } from '../types';
import { handleGlassMouseMove } from '../utils/glassEffect';
import { getBrandLogoPath, getClassColor } from '../utils/carHelpers';
import { getCountryFlagPath, getTrackImagePath, matchTrack, ACC_TRACK_ROSTER } from '../utils/trackHelpers';
import { Tooltip } from './ui/Tooltip';

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
    key: string;
    name: string;
    country?: string;
    image: string;
    sessions: Session[];
    bestLap: number;
    lastDriven: number;
    carCount: number;
}

const formatLapTime = (sec?: number) => {
    if (sec === undefined || sec === null || isNaN(sec)) return '--:--.---';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
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

const SessionRow = ({ s, onOpen, onDelete }: { s: Session; onOpen: () => void; onDelete: () => void }) => {
    const brand = getBrandLogoPath(s.carModel || '');
    const date = s.created ? new Date(s.created * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown';
    return (
        <div
            onClick={onOpen}
            onMouseMove={(e) => handleGlassMouseMove(e, 0.2)}
            className="group/row relative flex items-center gap-3 rounded-lg p-2.5 cursor-pointer border border-white/5 bg-black/20 ring-1 ring-inset ring-white/5 hover:bg-blue-600/10 hover:border-blue-500/30 transition-all duration-200 min-w-0"
        >
            <div className="relative flex-shrink-0 w-8 h-8 flex items-center justify-center">
                {brand ? (
                    <img src={brand} className="w-7 h-7 object-contain" onError={(e) => (e.currentTarget.style.display = 'none')} />
                ) : (
                    <div className="p-1.5 rounded-lg bg-white/5"><Car size={14} className="text-gray-500" /></div>
                )}
            </div>
            <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[12px] font-black tracking-tight text-gray-200 group-hover/row:text-white truncate">
                        {s.carModel || s.trackLayout || 'Session'}
                    </span>
                    {s.carClass && (
                        <span className={`text-[7px] font-black uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${getClassColor(s.carClass)}`}>{s.carClass}</span>
                    )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                    {s.bestLapTime != null && (
                        <span className="flex items-center gap-1">
                            <Timer size={10} className={s.bestLapValid ? 'text-blue-400' : 'text-red-400/80'} />
                            <span className={`text-[10px] font-mono font-bold ${s.bestLapValid ? 'text-blue-400' : 'text-red-400/80'}`}>{formatLapTime(s.bestLapTime)}</span>
                        </span>
                    )}
                    <span className="text-[9px] font-mono font-bold text-gray-500">{date}</span>
                    {s.driverName && <span className="text-[9px] uppercase tracking-widest text-blue-400/60 font-bold truncate ml-auto">{s.driverName}</span>}
                </div>
            </div>
            <Tooltip text="DELETE SESSION" position="left">
                <button
                    onClick={(e) => { e.stopPropagation(); onDelete(); }}
                    className="flex-shrink-0 p-1.5 rounded-md text-gray-500 opacity-0 group-hover/row:opacity-100 hover:text-red-400 hover:bg-red-500/10 transition-all"
                >
                    <Trash2 size={13} />
                </button>
            </Tooltip>
        </div>
    );
};

const TrackListRow = ({
    row,
    expanded,
    onToggle,
    onOpenSession,
    onDelete,
}: {
    row: TrackRow;
    expanded: boolean;
    onToggle: () => void;
    onOpenSession: (id: string) => void;
    onDelete: (id: string) => void;
}) => {
    const flag = getCountryFlagPath(row.country);
    const hasSessions = row.sessions.length > 0;
    const lastDate = row.lastDriven ? new Date(row.lastDriven * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—';

    return (
        <div className={`rounded-2xl border overflow-hidden transition-colors duration-300 ${expanded ? 'border-blue-500/30 bg-[#14141b]' : 'border-white/[0.07] bg-[#16161c]'}`}>
            {/* Track header row */}
            <button
                type="button"
                onClick={hasSessions ? onToggle : undefined}
                onMouseMove={(e) => handleGlassMouseMove(e, 0.12)}
                className={`group/track w-full flex items-center gap-4 px-4 py-3 text-left transition-colors duration-200 ${hasSessions ? 'cursor-pointer hover:bg-white/[0.03]' : 'cursor-default'}`}
            >
                {/* Map outline */}
                <div className="flex-shrink-0 w-[112px] h-[64px] rounded-lg bg-black/30 border border-white/5 flex items-center justify-center p-2">
                    <TrackMapImage src={row.image} active={expanded} />
                </div>

                {/* Name + country */}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                        {flag && <img src={flag} alt={row.country} className="w-5 h-auto rounded-[1px] border border-white/15 flex-shrink-0" onError={(e) => (e.currentTarget.style.display = 'none')} />}
                        <h3 className={`text-[15px] font-black uppercase tracking-tight truncate ${hasSessions ? 'text-white' : 'text-gray-400'}`}>{row.name}</h3>
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
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 px-3 pb-3 pt-1 border-t border-white/5">
                            {row.sessions.map(s => (
                                <SessionRow key={s.id} s={s} onOpen={() => onOpenSession(s.id)} onDelete={() => onDelete(s.id)} />
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export const TrackLibrary = memo(({ game, onBack, onOpenSession }: TrackLibraryProps) => {
    const sessions = useTelemetryStore(state => state.sessions);
    const uploadSession = useTelemetryStore(state => state.uploadSession);
    const deleteSession = useTelemetryStore(state => state.deleteSession);
    const isListLoading = useTelemetryStore(state => state.isListLoading);

    const [searchQuery, setSearchQuery] = useState('');
    const [isUploading, setIsUploading] = useState(false);
    const [expandedKey, setExpandedKey] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const meta = GAME_META[game];

    const rows = useMemo<TrackRow[]>(() => {
        const scoped = sessions.filter(s => (s.game || 'LMU') === game);
        const q = searchQuery.trim().toLowerCase();

        const map = new Map<string, TrackRow>();
        const ensure = (key: string, name: string, country: string | undefined, image: string): TrackRow => {
            let row = map.get(key);
            if (!row) {
                row = { key, name, country, image, sessions: [], bestLap: Infinity, lastDriven: 0, carCount: 0 };
                map.set(key, row);
            }
            return row;
        };

        // Seed the full ACC roster so every track shows (even with 0 sessions).
        if (game === 'ACC') {
            ACC_TRACK_ROSTER.forEach(t => ensure(t.key, t.name, t.country, `/acc-tracks/${t.key}.svg`));
        }

        scoped.forEach(s => {
            const rawName = s.displayName || s.commonTrackName || s.trackName || 'Unknown Track';
            const info = matchTrack(rawName);
            const key = info ? info.key : rawName.toLowerCase();
            const row = ensure(
                key,
                info ? info.name : rawName,
                info ? info.country : s.country,
                info ? `/acc-tracks/${info.key}.svg` : getTrackImagePath(rawName),
            );
            row.sessions.push(s);
            if (s.bestLapValid && s.bestLapTime != null && s.bestLapTime < row.bestLap) row.bestLap = s.bestLapTime;
            if ((s.created || 0) > row.lastDriven) row.lastDriven = s.created || 0;
        });

        let list = Array.from(map.values());

        // When searching, keep only tracks whose name matches or that have
        // sessions matching the query (car / driver / class / layout).
        if (q) {
            list = list.filter(r => {
                if (r.name.toLowerCase().includes(q)) return true;
                r.sessions = r.sessions.filter(s =>
                    (s.carModel || '').toLowerCase().includes(q) ||
                    (s.carClass || '').toLowerCase().includes(q) ||
                    (s.driverName || '').toLowerCase().includes(q) ||
                    (s.trackLayout || '').toLowerCase().includes(q));
                return r.sessions.length > 0;
            });
        }

        list.forEach(r => {
            r.sessions.sort((a, b) => (b.created || 0) - (a.created || 0));
            r.carCount = new Set(r.sessions.map(s => s.carModel).filter(Boolean)).size;
        });

        // Recorded tracks first (by most-recently driven), then the rest A-Z.
        list.sort((a, b) => {
            const aHas = a.sessions.length > 0 ? 1 : 0;
            const bHas = b.sessions.length > 0 ? 1 : 0;
            if (aHas !== bHas) return bHas - aHas;
            if (aHas && bHas) return b.lastDriven - a.lastDriven;
            return a.name.localeCompare(b.name);
        });

        return list;
    }, [sessions, game, searchQuery]);

    const totalSessions = useMemo(() => sessions.filter(s => (s.game || 'LMU') === game).length, [sessions, game]);
    const recordedTracks = useMemo(() => rows.filter(r => r.sessions.length > 0).length, [rows]);

    const handleFiles = async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        setIsUploading(true);
        try {
            for (const file of Array.from(files)) await uploadSession(file);
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    return (
        <div className="relative flex-1 min-h-0 overflow-y-auto custom-scrollbar bg-[#0a0a0f]">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(37,99,235,0.10),transparent_70%)]" />

            <div className="relative max-w-[1200px] mx-auto px-8 py-8">
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
                </div>

                {/* Toolbar */}
                <div className="flex items-center gap-3 mt-6 mb-6">
                    <div className="relative flex-1 max-w-md">
                        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                        <input
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search tracks, cars, drivers..."
                            className="w-full h-10 pl-9 pr-3 rounded-xl bg-[#16161c] border border-white/10 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                    </div>

                    <div className="hidden md:flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                        <span className="flex items-center gap-1.5 px-3 h-10 rounded-xl bg-[#16161c] border border-white/10">
                            <MapPin size={12} className="text-blue-400" /> {recordedTracks} Driven
                        </span>
                        <span className="flex items-center gap-1.5 px-3 h-10 rounded-xl bg-[#16161c] border border-white/10">
                            <Layers size={12} className="text-blue-400" /> {totalSessions} Sessions
                        </span>
                    </div>

                    <input ref={fileInputRef} type="file" multiple accept=".duckdb,.ld,.csv" className="hidden" onChange={(e) => handleFiles(e.target.files)} />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploading}
                        className="flex items-center gap-2 h-10 px-4 rounded-xl bg-blue-600/20 border border-blue-500/30 text-blue-300 hover:bg-blue-600/30 hover:text-white transition-all font-black text-[10px] uppercase tracking-widest disabled:opacity-50 ml-auto glass-container"
                        onMouseMove={(e) => handleGlassMouseMove(e, 0.2)}
                    >
                        <div className="glass-content flex items-center gap-2">
                            {isUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                            Upload
                        </div>
                    </button>
                </div>

                {/* Track list */}
                {isListLoading && rows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-32 text-gray-500">
                        <Loader2 size={28} className="animate-spin mb-3" />
                        <span className="text-sm font-bold uppercase tracking-widest">Loading Sessions...</span>
                    </div>
                ) : rows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-32 text-center">
                        <div className="w-16 h-16 rounded-2xl bg-[#16161c] border border-white/10 flex items-center justify-center mb-4">
                            <MapPin size={26} className="text-gray-600" />
                        </div>
                        <p className="text-lg font-black text-gray-300 uppercase tracking-tight">{searchQuery ? 'No matches found' : 'No sessions yet'}</p>
                        <p className="text-sm text-gray-500 mt-1 max-w-sm">
                            {searchQuery ? 'Try a different search term.' : `Upload a ${game} telemetry file to start building your library.`}
                        </p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2.5">
                        {rows.map(row => (
                            <TrackListRow
                                key={row.key}
                                row={row}
                                expanded={expandedKey === row.key}
                                onToggle={() => setExpandedKey(prev => (prev === row.key ? null : row.key))}
                                onOpenSession={onOpenSession}
                                onDelete={deleteSession}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});
