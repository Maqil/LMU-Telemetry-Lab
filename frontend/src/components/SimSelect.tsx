import { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Layers, Timer, Flag } from 'lucide-react';
import { useTelemetryStore } from '../store/telemetryStore';
import { handleGlassMouseMove } from '../utils/glassEffect';

/**
 * "SELECT YOUR SIM" landing page (Coach Dave Delta style).
 *
 * Shown when the Home rail item is active. Presents one large card per
 * supported sim (ACC / Assetto Corsa / Le Mans Ultimate). Selecting a
 * playable sim applies its game filter and opens the Data Sources view.
 */

type GameKey = 'ACC' | 'AC' | 'LMU';

interface SimConfig {
    key: GameKey;
    /** Store game filter value, if the sim is playable. */
    filter?: 'LMU' | 'ACC';
    title: string;
    subtitle: string;
    image: string;
    logo: string;
    /** Black SVG logos need brightness/invert to render white; .ico is full colour. */
    invertLogo: boolean;
    comingSoon?: boolean;
}

const SIMS: SimConfig[] = [
    {
        key: 'ACC',
        filter: 'ACC',
        title: 'Assetto Corsa Competizione',
        subtitle: 'The Official GT World Challenge Game',
        image: '/games/acc-home.jpeg',
        logo: '/games/acc.svg',
        invertLogo: true,
    },
    {
        key: 'LMU',
        filter: 'LMU',
        title: 'Le Mans Ultimate',
        subtitle: 'The Official Game of the FIA World Endurance Championship',
        image: '/games/lmu-home.jpg',
        logo: '/games/lmu.svg',
        invertLogo: true,
    },
    {
        key: 'AC',
        title: 'Assetto Corsa',
        subtitle: 'The Original Sim Racing Sandbox',
        image: '/games/ac-home.png',
        logo: '/games/ac.ico',
        invertLogo: false,
        comingSoon: true,
    },
];

interface SimSelectProps {
    /** Apply the game filter + open the Data Sources view for the chosen sim. */
    onSelectGame: (game: 'LMU' | 'ACC') => void;
}

const StatRow = ({ icon: Icon, label, value }: { icon: any; label: string; value: string | number }) => (
    <div className="flex items-center justify-between py-1.5">
        <div className="flex items-center gap-2 text-gray-400">
            <Icon size={12} className="text-gray-500" />
            <span className="text-[10px] font-bold uppercase tracking-widest">{label}</span>
        </div>
        <span className="text-[11px] font-mono font-black text-white/90">{value}</span>
    </div>
);

const SimCard = ({
    sim,
    sessions,
    onSelect,
}: {
    sim: SimConfig;
    sessions: number;
    onSelect: () => void;
}) => {
    const disabled = !!sim.comingSoon;

    return (
        <motion.button
            type="button"
            onClick={disabled ? undefined : onSelect}
            disabled={disabled}
            whileHover={disabled ? undefined : { y: -6 }}
            transition={{ type: 'spring', stiffness: 300, damping: 24 }}
            onMouseMove={(e) => handleGlassMouseMove(e, 0.15)}
            className={`group relative h-full w-full flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#16161c] text-left glass-container
                shadow-[0_12px_50px_rgba(0,0,0,0.55)] transition-all duration-300
                ${disabled ? 'cursor-not-allowed opacity-80' : 'cursor-pointer hover:border-blue-400/50 hover:shadow-[0_24px_70px_rgba(37,99,235,0.28)]'}`}
        >
            {/* Artwork */}
            <div className="relative flex-1 min-h-0 overflow-hidden">
                <img
                    src={sim.image}
                    alt={sim.title}
                    className={`absolute inset-0 w-full h-full object-cover transition-transform duration-700 ${disabled ? '' : 'group-hover:scale-105'}`}
                    draggable={false}
                />
                {/* Darkening gradient so logo/text stay legible, easing into the footer */}
                <div className="absolute inset-0 bg-gradient-to-t from-[#16161c] via-[#16161c]/25 to-transparent" />
                <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-transparent" />
                <div className="absolute inset-0 bg-blue-500/0 group-hover:bg-blue-500/[0.06] transition-colors duration-300" />

                {sim.comingSoon && (
                    <div className="absolute top-3 right-3 px-2.5 py-1 rounded-full bg-black/60 border border-white/15 backdrop-blur-sm">
                        <span className="text-[9px] font-black uppercase tracking-[0.2em] text-amber-400">Coming Soon</span>
                    </div>
                )}

                {/* Logo + name, anchored to the bottom of the artwork */}
                <div className="absolute inset-x-0 bottom-0 p-5 flex items-center gap-3">
                    <img
                        src={sim.logo}
                        alt={`${sim.title} logo`}
                        className={`h-9 w-9 object-contain flex-shrink-0 drop-shadow-lg ${sim.invertLogo ? '[filter:brightness(0)_invert(1)]' : ''}`}
                        draggable={false}
                    />
                    <div className="min-w-0">
                        <h3 className="text-base font-black uppercase tracking-tight text-white leading-tight drop-shadow-md truncate">
                            {sim.title}
                        </h3>
                        <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-gray-300/80 leading-tight mt-0.5 line-clamp-1">
                            {sim.subtitle}
                        </p>
                    </div>
                </div>
            </div>

            {/* Stats footer */}
            <div className="glass-content flex-shrink-0 px-5 py-4 border-t border-white/[0.06] bg-gradient-to-b from-[#1a1a22] to-[#141419]">
                <div className="mt-1.5">
                    <StatRow icon={Layers} label="Sessions" value={disabled ? '—' : sessions} />
                    <StatRow icon={Timer} label="Status" value={disabled ? 'Soon' : 'Ready'} />
                    <StatRow icon={Flag} label="Sim" value={sim.key} />
                </div>
            </div>
        </motion.button>
    );
};

export const SimSelect = memo(({ onSelectGame }: SimSelectProps) => {
    const sessions = useTelemetryStore(state => state.sessions);

    const counts = useMemo(() => ({
        ACC: sessions.filter(s => (s.game || 'LMU') === 'ACC').length,
        LMU: sessions.filter(s => (s.game || 'LMU') === 'LMU').length,
        AC: 0,
    }), [sessions]);

    return (
        <div className="relative flex-1 min-h-0 overflow-y-auto custom-scrollbar bg-[#0a0a0f]">
            {/* Ambient background glow */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(37,99,235,0.12),transparent_70%)]" />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/40" />
            <div className="relative max-w-[1500px] mx-auto px-8 py-10">
                <h1 className="text-3xl md:text-4xl font-black uppercase tracking-tight text-white mb-1">
                    Select Your Sim
                </h1>
                <p className="text-sm text-gray-500 font-bold uppercase tracking-widest mb-8">
                    Choose a simulator to browse its telemetry library
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-fr">
                    {SIMS.map(sim => (
                        <div key={sim.key} className="h-[780px] max-h-[88vh]">
                            <SimCard
                                sim={sim}
                                sessions={counts[sim.key]}
                                onSelect={() => sim.filter && onSelectGame(sim.filter)}
                            />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
});
