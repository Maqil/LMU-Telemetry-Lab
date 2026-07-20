import React from 'react';
import { useTelemetryStore } from '../store/telemetryStore';
import type { SessionMetadata } from '../types';
import { handleGlassMouseMove } from '../utils/glassEffect';
import { Tooltip } from './ui/Tooltip';
import { getBrandLogoPath, getClassColor } from '../utils/carHelpers';
import { getCountryFlagPath } from '../utils/trackHelpers';
import { Settings2, Car, PanelLeftClose } from 'lucide-react';

interface CarInfoCardProps {
    metadata: SessionMetadata;
    theme?: 'current' | 'reference';
}

// Condensed single-block car card: logo + name on one row, class + actions inline.
const CarInfoCard: React.FC<CarInfoCardProps> = ({ metadata, theme = 'current' }) => {
    const isRef = theme === 'reference';
    const fetchSetup = useTelemetryStore(s => s.fetchSetup);
    const setShowSetupView = useTelemetryStore(s => s.setShowSetupView);
    const currentSessionId = useTelemetryStore(s => s.currentSessionId);
    const setShowCarSelection = useTelemetryStore(s => s.setShowCarSelection);
    const accentColor = isRef ? 'text-amber-500' : 'text-blue-400';
    const hoverAccentColor = isRef ? 'group-hover:text-amber-400' : 'group-hover:text-blue-400';
    const borderColor = isRef ? 'group-hover:border-amber-500/40' : 'group-hover:border-blue-500/40';

    const [logoFailed, setLogoFailed] = React.useState(false);

    React.useEffect(() => {
        setLogoFailed(false);
    }, [metadata.modelName]);

    return (
        <div
            className={`flex items-center gap-2.5 bg-white/10 glass-container glass-expand-pixel px-3 py-2.5 rounded-md border border-white/25 group hover:bg-white/15 transition-all duration-300 relative`}
            onMouseMove={handleGlassMouseMove}
        >
            <div className="glass-content flex items-center gap-2.5 w-full min-w-0">
                {/* Brand logo */}
                <div className={`w-8 h-8 flex-shrink-0 flex items-center justify-center bg-white/10 rounded-md border border-white/20 ${borderColor} transition-all p-1`}>
                    {logoFailed ? (
                        <Car size={12} className="text-gray-500" />
                    ) : (
                        <img
                            src={getBrandLogoPath(metadata.modelName)}
                            alt="Brand Logo"
                            className="w-full h-full object-contain filter brightness-125 drop-shadow-[0_0_8px_rgba(255,255,255,0.2)]"
                            onError={() => setLogoFailed(true)}
                        />
                    )}
                </div>

                {/* Name + label */}
                <div className="flex flex-col min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <div className={`w-1 h-1 rounded-full ${isRef ? 'bg-amber-500' : 'bg-blue-500'} animate-pulse`} />
                        <span className={`text-[8px] font-black uppercase tracking-[0.2em] ${accentColor}`}>
                            {isRef ? 'Reference Car' : 'Current Car'}
                        </span>
                    </div>
                    <h2 className={`text-[12px] font-black italic tracking-wide text-white uppercase leading-tight truncate ${hoverAccentColor} transition-colors`}>
                        {metadata.modelName}
                    </h2>
                </div>

                {/* Class badge + actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                    <span className={`px-1.5 py-0.5 rounded-sm text-[9px] font-black border leading-none tracking-[0.1em] uppercase ${getClassColor(metadata.carClass)}`}>
                        {metadata.carClass || 'CLASS'}
                    </span>
                    <Tooltip text="Calibrate Car Model" position="top">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowCarSelection({
                                    rawCarName: metadata.rawCarName || metadata.modelName,
                                    currentModel: metadata.modelName,
                                    carClass: metadata.carClass,
                                    isRef
                                });
                            }}
                            className="p-1 text-blue-400 hover:text-white bg-blue-500/10 hover:bg-blue-500/25 border border-blue-500/30 rounded-sm transition-all flex items-center justify-center shrink-0 active:scale-95"
                        >
                            <Settings2 size={11} />
                        </button>
                    </Tooltip>
                    {!isRef && currentSessionId && (
                        <Tooltip text="Car Setup" position="top">
                            <button
                                onClick={() => {
                                    fetchSetup(currentSessionId);
                                    setShowSetupView(true);
                                }}
                                className="p-1 text-gray-400 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-sm transition-all flex items-center justify-center shrink-0 active:scale-95"
                            >
                                <Car size={11} />
                            </button>
                        </Tooltip>
                    )}
                </div>
            </div>
        </div>
    );
};

interface SessionInfoProps {
    sessionMetadata: SessionMetadata;
    referenceMetadata?: SessionMetadata | null;
    onHide?: () => void;
}

// Compact stat cell used in the combined track block.
const StatCell: React.FC<{ label: string; value: React.ReactNode; valueClass: string }> = ({ label, value, valueClass }) => (
    <div className="flex flex-col gap-0.5 px-2.5 py-2 rounded-sm bg-white/5 border border-white/10 min-w-0">
        <span className="font-black tracking-[0.12em] uppercase text-[8px] text-gray-500 leading-none truncate">{label}</span>
        <span className={`font-black text-[12px] leading-none truncate ${valueClass}`}>{value}</span>
    </div>
);

export const SessionInfo: React.FC<SessionInfoProps> = ({ sessionMetadata, referenceMetadata, onHide }) => {
    const telemetryData = useTelemetryStore(state => state.telemetryData);
    const cursorIndex = useTelemetryStore(state => state.cursorIndex);
    const selectedLapIdx = useTelemetryStore(state => state.selectedLapIdx);
    const laps = useTelemetryStore(state => state.laps);
    const tempUnit = useTelemetryStore(state => state.tempUnit);

    // Safely get data at current cursor if available
    let trackTempDisplay = "--";
    const trackTimeDisplay = sessionMetadata.sessionTime || "--:--:--";

    let sessionDurationDisplay = "--:--:--";
    if (sessionMetadata.sessionDuration) {
        const sec = sessionMetadata.sessionDuration;
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
        const s = Math.floor(sec % 60).toString().padStart(2, '0');
        sessionDurationDisplay = h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
    }

    if (telemetryData && cursorIndex !== null && selectedLapIdx !== null) {
        const currentLap = laps.find(l => l.lap === selectedLapIdx);
        if (currentLap) {
            const trackTempChannel = telemetryData['Track Temperature'];

            const baseIdx = Math.floor(cursorIndex);
            if (trackTempChannel && trackTempChannel.length > baseIdx) {
                const rawTemp = trackTempChannel[baseIdx];
                if (rawTemp !== undefined) {
                    const displayTemp = tempUnit === 'f' ? (rawTemp * 1.8 + 32) : rawTemp;
                    trackTempDisplay = Math.round(displayTemp).toString();
                }
            }
        }
    }

    return (
        <div className="flex flex-col bg-transparent">
            {/* Header Area */}
            <div className="px-1 pt-4 pb-2 flex items-center gap-3">
                <h3 className="text-gray-500 text-[12px] font-black uppercase tracking-[0.2em] px-1 whitespace-nowrap">Session Info</h3>
                <div className="h-[1px] flex-1 bg-white/10 relative overflow-hidden group/linkage">
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] animate-[sweep_3s_infinite]" />
                </div>
                {onHide && (
                    <Tooltip text="HIDE PANEL" position="left">
                        <button
                            onClick={onHide}
                            className="p-1.5 rounded-sm text-gray-500 hover:text-white hover:bg-white/10 border border-transparent hover:border-white/10 transition-all active:scale-95"
                        >
                            <PanelLeftClose size={15} />
                        </button>
                    </Tooltip>
                )}
            </div>

            <div className="flex flex-col gap-2.5 py-2">
                {/* Combined Track block: name + weather / temp / track time / session time */}
                <div
                    className="flex flex-col bg-white/10 glass-container glass-expand-pixel p-3 rounded-md border border-white/25 shadow-[0_15px_35px_rgba(0,0,0,0.4)] group hover:bg-white/15 transition-all duration-300"
                    onMouseMove={handleGlassMouseMove}
                >
                    <div className="glass-content flex flex-col gap-2.5">
                        {/* Track identity row */}
                        <div className="flex items-center gap-2.5">
                            {getCountryFlagPath && sessionMetadata.country && (
                                <div className="p-1 bg-white/10 rounded-sm border border-white/20 group-hover:border-blue-500/40 transition-all shrink-0">
                                    <img
                                        src={getCountryFlagPath(sessionMetadata.country)}
                                        alt="Country Flag"
                                        className="w-7 h-auto object-contain rounded-[1px]"
                                        onError={(e) => (e.currentTarget.style.display = 'none')}
                                    />
                                </div>
                            )}
                            <div className="flex flex-col min-w-0 flex-1">
                                <h2 className="text-[13px] font-black italic tracking-widest text-white uppercase leading-tight truncate group-hover:text-blue-400 transition-colors">
                                    {sessionMetadata.trackName}
                                </h2>
                                {(sessionMetadata.trackLayout || sessionMetadata.sessionType) && (
                                    <span className="text-[10px] text-gray-400 font-mono tracking-tighter uppercase truncate opacity-80">
                                        {[sessionMetadata.sessionType, sessionMetadata.trackLayout].filter(Boolean).join(' · ')}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Stats grid */}
                        <div className="grid grid-cols-2 gap-1.5 font-mono">
                            <StatCell
                                label="Weather"
                                value={sessionMetadata.weather || "--"}
                                valueClass="text-blue-300 uppercase tracking-tight"
                            />
                            <StatCell
                                label="Track Temp"
                                value={`${trackTempDisplay}°${tempUnit === 'c' ? 'C' : 'F'}`}
                                valueClass="text-amber-500"
                            />
                            <StatCell
                                label="Track Time"
                                value={trackTimeDisplay}
                                valueClass="text-blue-100"
                            />
                            <StatCell
                                label="Session Time"
                                value={sessionDurationDisplay}
                                valueClass="text-indigo-400"
                            />
                        </div>
                    </div>
                </div>

                {/* Condensed Car Info Cards */}
                <div className="flex flex-col gap-2">
                    <CarInfoCard
                        metadata={sessionMetadata}
                        theme="current"
                    />

                    {referenceMetadata && (
                        <div className="animate-in fade-in slide-in-from-top-4 duration-500">
                            <CarInfoCard
                                metadata={referenceMetadata}
                                theme="reference"
                            />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
