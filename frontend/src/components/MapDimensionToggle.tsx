import { useTelemetryStore } from '../store/telemetryStore';
import { handleGlassMouseMove } from '../utils/glassEffect';

/**
 * 2D / 3D map dimension switch. Rendered as an overlay inside the map (above the
 * Z Scale slider in 3D, next to the title in 2D) so it lives with the map itself.
 */
export const MapDimensionToggle = ({ className = '' }: { className?: string }) => {
    const show3DLab = useTelemetryStore(s => s.show3DLab);
    const setShow3DLab = useTelemetryStore(s => s.setShow3DLab);

    return (
        <div
            className={`relative flex items-center p-1 bg-black/40 backdrop-blur-md rounded-md border border-white/10 glass-container h-7 w-24 overflow-hidden group/dimtoggle pointer-events-auto ${className}`}
            onMouseMove={handleGlassMouseMove}
        >
            <div
                className="absolute top-1 bottom-1 w-[calc(50%-4px)] bg-blue-600 rounded-md shadow-[0_0_15px_rgba(37,99,235,0.4)] transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] z-0"
                style={{ left: !show3DLab ? '4px' : 'calc(50%)' }}
            />
            <button
                onClick={() => setShow3DLab(false)}
                className={`relative z-10 flex-1 h-full flex items-center justify-center text-[10px] font-black uppercase tracking-widest transition-colors duration-300 ${!show3DLab ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
            >
                2D
            </button>
            <button
                onClick={() => setShow3DLab(true)}
                className={`relative z-10 flex-1 h-full flex items-center justify-center text-[10px] font-black uppercase tracking-widest transition-colors duration-300 ${show3DLab ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
            >
                3D
            </button>
        </div>
    );
};
