import { memo } from 'react';
import { X } from 'lucide-react';
import { useTelemetryStore } from '../store/telemetryStore';
import { Tooltip } from './ui/Tooltip';

/**
 * Browser-style tab strip for open sessions. Sits below the top navbar, above the
 * telemetry charts. Clicking a tab (re)loads that session; the X closes it.
 * Tabs are persisted in the store (localStorage) and survive reloads.
 */

const gameIconSrc = (game?: string): string | null => {
    if (game === 'ACC') return '/games/acc.svg';
    if (game === 'LMU') return '/games/lmu.svg';
    return null;
};

export const SessionTabBar = memo(() => {
    const openTabs = useTelemetryStore(state => state.openTabs);
    const currentSessionId = useTelemetryStore(state => state.currentSessionId);
    const selectSession = useTelemetryStore(state => state.selectSession);
    const closeSessionTab = useTelemetryStore(state => state.closeSessionTab);

    if (openTabs.length === 0) return null;

    return (
        <div className="flex items-stretch gap-1 bg-[#0b0b0e] border-b border-[#1f1f26] px-2 h-9 flex-shrink-0 overflow-x-auto overflow-y-hidden custom-scrollbar">
            {openTabs.map(tab => {
                const active = tab.id === currentSessionId;
                const icon = gameIconSrc(tab.game);
                const label = tab.carModel ? `${tab.carModel} @ ${tab.trackName}` : tab.trackName;
                return (
                    <div
                        key={tab.id}
                        onClick={() => { if (!active) selectSession(tab.id); }}
                        className={`group/tab flex items-center gap-2 pl-2.5 pr-1.5 my-1 rounded-md cursor-pointer transition-all select-none max-w-[280px] border ${
                            active
                                ? 'bg-blue-500/10 border-blue-500/30 text-white'
                                : 'border-transparent text-gray-400 hover:bg-white/5 hover:text-gray-200'
                        }`}
                    >
                        {icon && (
                            <img
                                src={icon}
                                alt=""
                                className={`w-4 h-4 object-contain shrink-0 [filter:brightness(0)_invert(1)] ${active ? '' : 'opacity-70'}`}
                            />
                        )}
                        <span className="text-[11px] font-black uppercase tracking-wider truncate">{label}</span>
                        <Tooltip text="CLOSE" position="bottom" delay={200}>
                            <button
                                onClick={(e) => { e.stopPropagation(); closeSessionTab(tab.id); }}
                                className="ml-0.5 p-1 rounded shrink-0 text-gray-500 hover:text-white hover:bg-white/10 transition-all active:scale-90"
                            >
                                <X size={12} />
                            </button>
                        </Tooltip>
                    </div>
                );
            })}
        </div>
    );
});
