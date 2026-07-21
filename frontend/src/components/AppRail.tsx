import { memo } from 'react';
import { Home, Clock } from 'lucide-react';
import { useTelemetryStore } from '../store/telemetryStore';
import { Tooltip } from './ui/Tooltip';

/**
 * Fixed vertical navigation rail (Coach Dave Delta style).
 * Holds the app home shortcut plus per-sim selectors (LMU / ACC / Assetto Corsa).
 * Selecting a sim opens the Data Sources view filtered to that game.
 *
 * Accent colours are kept consistent with the rest of the app (blue) rather
 * than per-sim colours, so only the logos carry brand colour.
 */

// Single app accent used for every active/hover indicator.
const ACCENT = '#3b82f6';

interface RailItemProps {
    label: string;
    active: boolean;
    disabled?: boolean;
    onClick?: () => void;
    children: React.ReactNode;
}

const RailItem = ({ label, active, disabled, onClick, children }: RailItemProps) => (
    <Tooltip text={disabled ? `${label} (coming soon)` : label} position="right" delay={100}>
        <button
            onClick={disabled ? undefined : onClick}
            disabled={disabled}
            className={`relative w-11 h-11 rounded-xl flex items-center justify-center transition-all duration-300 group
                ${disabled ? 'opacity-30 cursor-not-allowed grayscale' : 'cursor-pointer hover:bg-white/[0.06]'}
                ${active ? 'bg-blue-500/10' : ''}`}
        >
            {/* Left active indicator bar */}
            <span
                className={`absolute -left-[10px] top-1/2 -translate-y-1/2 w-1 rounded-full transition-all duration-300
                    ${active ? 'h-6 opacity-100' : 'h-0 opacity-0 group-hover:h-3 group-hover:opacity-60'}`}
                style={{ backgroundColor: ACCENT }}
            />
            {children}
        </button>
    </Tooltip>
);

interface AppRailProps {
    /** Whether the Data Sources (FileManager) view is currently open. */
    showDataSources: boolean;
    /** Open the Data Sources view. */
    onOpenDataSources: () => void;
}

export const AppRail = memo(({ showDataSources, onOpenDataSources }: AppRailProps) => {
    const gameFilter = useTelemetryStore(state => state.gameFilter);
    const setGameFilter = useTelemetryStore(state => state.setGameFilter);

    const selectGame = (game: 'all' | 'LMU' | 'ACC') => {
        setGameFilter(game);
        onOpenDataSources();
    };

    // Home is "active" when browsing all sources; a sim is active when its filter is applied.
    const homeActive = showDataSources && gameFilter === 'all';
    const lmuActive = showDataSources && gameFilter === 'LMU';
    const accActive = showDataSources && gameFilter === 'ACC';

    return (
        <div className="h-full w-[60px] flex-shrink-0 bg-[#0b0b0e] border-r border-[#1f1f26] flex flex-col items-center py-3 gap-1.5 z-40 relative">
            {/* App logo */}
            <img
                src="/lmu_logo.png"
                alt="LMU Telemetry Lab"
                className="w-9 h-9 object-contain mb-1 drop-shadow-[0_0_10px_rgba(59,130,246,0.35)]"
            />

            <div className="w-7 h-px bg-white/10 my-1.5" />

            {/* Home */}
            <RailItem label="Home" active={homeActive} onClick={() => selectGame('all')}>
                <Home size={20} className={homeActive ? 'text-blue-400' : 'text-gray-400 group-hover:text-gray-200'} />
            </RailItem>

            <div className="w-7 h-px bg-white/10 my-1.5" />

            {/* Sims */}
            <RailItem label="Assetto Corsa" active={false} disabled>
                {/* ac.svg ships as black paths ??render it light so it reads on the dark rail. */}
                <img
                    src="/games/ac.svg"
                    alt="Assetto Corsa"
                    className="w-7 h-7 object-contain [filter:brightness(0)_invert(1)]"
                />
            </RailItem>

            <RailItem label="Assetto Corsa Competizione" active={accActive} onClick={() => selectGame('ACC')}>
                <img
                    src="/games/acc.svg"
                    alt="Assetto Corsa Competizione"
                    className={`w-7 h-7 object-contain transition-all [filter:brightness(0)_invert(1)] ${accActive ? '' : 'opacity-75 group-hover:opacity-100'}`}
                />
            </RailItem>

            <RailItem label="Le Mans Ultimate" active={lmuActive} onClick={() => selectGame('LMU')}>
                <img
                    src="/games/lmu.svg"
                    alt="Le Mans Ultimate"
                    className={`w-7 h-7 object-contain transition-all [filter:brightness(0)_invert(1)] ${lmuActive ? '' : 'opacity-75 group-hover:opacity-100'}`}
                />
            </RailItem>

            {/* Footer spacer / coming-soon marker */}
            <div className="mt-auto flex flex-col items-center gap-1 pb-1">
                <Tooltip text="More sims coming soon" position="right" delay={100}>
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center opacity-30">
                        <Clock size={16} className="text-gray-500" />
                    </div>
                </Tooltip>
            </div>
        </div>
    );
});
