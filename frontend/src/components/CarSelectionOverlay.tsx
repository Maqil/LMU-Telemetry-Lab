import React from 'react';
import { motion } from 'framer-motion';
import { X, Car } from 'lucide-react';
import { useTelemetryStore } from '../store/telemetryStore';
import { handleGlassMouseMove } from '../utils/glassEffect';
import { getBrandLogoPath, CLASS_MODEL_NAMES, normalizeCarClass } from '../utils/carHelpers';

export const CarSelectionOverlay: React.FC = () => {
    const showCarSelection = useTelemetryStore(state => state.showCarSelection);
    const setShowCarSelection = useTelemetryStore(state => state.setShowCarSelection);
    const setCustomCarMapping = useTelemetryStore(state => state.setCustomCarMapping);

    if (!showCarSelection) return null;

    const { rawCarName, currentModel, carClass } = showCarSelection;
    const normalizedClass = normalizeCarClass(carClass);
    const models = CLASS_MODEL_NAMES[normalizedClass] || [];

    return (
        <div 
            className="absolute inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-md"
            onClick={(e) => e.target === e.currentTarget && setShowCarSelection(null)}
        >
            <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 1.05, opacity: 0, y: -20 }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="glass-container w-full max-w-lg bg-gray-900/60 border border-white/20 rounded-[2.5rem] shadow-[0_30px_60px_rgba(0,0,0,0.6)] relative flex flex-col"
                onMouseMove={(e) => handleGlassMouseMove(e, 0.2)}
                style={{ height: '70vh', overflow: 'hidden' }}
            >
                {/* Fixed Header */}
                <div className="glass-content p-8 flex-shrink-0 flex items-center justify-between border-b border-white/5 relative z-20">
                    <div className="flex flex-col min-w-0 pr-4">
                        <div className="flex items-center gap-2">
                            <Car size={20} className="text-blue-400" />
                            <h2 className="text-xl font-black italic uppercase tracking-wider text-white">Car Model Calibration</h2>
                        </div>
                        <span className="text-xs font-black text-gray-400 uppercase tracking-wider mt-1.5 truncate">
                            Align raw: <span className="text-blue-400 font-mono select-all">{rawCarName}</span>
                        </span>
                    </div>
                    <button
                        onClick={() => setShowCarSelection(null)}
                        className="p-2.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-all glass-container rounded-full border border-white/10 group/close flex-shrink-0"
                    >
                        <X size={18} className="group-hover/close:rotate-90 transition-transform duration-300" />
                    </button>
                </div>

                {/* Scrollable Model Grid */}
                <div className="glass-content p-8 flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-4 relative z-10">
                    <div className="flex items-center gap-2 px-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                        <span className="text-xs font-black text-gray-400 uppercase tracking-widest">
                            Available {normalizedClass} Models ({models.length})
                        </span>
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                        {models.map(model => {
                            const isSelected = currentModel?.toLowerCase() === model.toLowerCase();
                            return (
                                <button
                                    key={model}
                                    onClick={() => {
                                        setCustomCarMapping(rawCarName, model);
                                        setShowCarSelection(null);
                                    }}
                                    className={`group relative flex items-center gap-4 p-4 rounded-2xl border transition-all duration-300 overflow-hidden ${
                                        isSelected 
                                            ? 'bg-blue-600/20 border-blue-500 shadow-[0_8px_25px_rgba(59,130,246,0.2)] scale-[1.01]' 
                                            : 'bg-black/30 border-white/5 hover:border-white/20 hover:bg-white/5 hover:scale-[1.005]'
                                    }`}
                                    onMouseMove={(e) => handleGlassMouseMove(e, 0.1)}
                                    style={{ '--glass-hover-scale': '1.01' } as any}
                                >
                                    {/* Selection Glow Layer */}
                                    {isSelected && (
                                        <div className="absolute inset-0 bg-gradient-to-r from-blue-600/10 to-transparent pointer-events-none" />
                                    )}

                                    {/* Logo Preview Container */}
                                    <div className={`w-12 h-12 flex items-center justify-center rounded-xl transition-all duration-500 p-2 shrink-0 ${
                                        isSelected 
                                            ? 'bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.4)]' 
                                            : 'bg-white/5 border border-white/10'
                                    }`}>
                                        <img
                                            src={getBrandLogoPath(model)}
                                            alt={model}
                                            className="w-full h-full object-contain filter brightness-125 transition-all drop-shadow-[0_0_4px_rgba(255,255,255,0.2)]"
                                            onError={(e) => {
                                                e.currentTarget.style.display = 'none';
                                                e.currentTarget.parentElement!.insertAdjacentHTML('beforeend', '<div class="w-6 h-6 bg-gray-800 rounded-full border border-gray-700"></div>');
                                            }}
                                        />
                                    </div>

                                    {/* Model Name */}
                                    <div className="flex flex-col text-left min-w-0 flex-1">
                                        <span className={`text-[15px] font-black italic uppercase tracking-wider transition-colors truncate ${
                                            isSelected ? 'text-blue-400' : 'text-white'
                                        }`}>
                                            {model}
                                        </span>
                                        <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest mt-1">
                                            {normalizedClass}
                                        </span>
                                    </div>

                                    {/* Active Checkmark */}
                                    {isSelected && (
                                        <div className="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center border border-white/20 animate-in zoom-in duration-300 mr-2 shrink-0 shadow-lg">
                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                                                <polyline points="20 6 9 17 4 12" />
                                            </svg>
                                        </div>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </motion.div>
        </div>
    );
};
