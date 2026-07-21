import { useTelemetryStore } from '../store/telemetryStore';
import { SteeringWheelView } from './SteeringWheelView';

/**
 * Steering-wheel overlay for the 3D map. Shows the driver (current) wheel, and a
 * second reference wheel when two laps are being compared. Subscribes to the cursor
 * itself so it re-renders per frame without re-rendering the (expensive) 3D map.
 */
export const MapSteeringOverlay = () => {
    const telemetryData = useTelemetryStore(s => s.telemetryData);
    const cursorIndex = useTelemetryStore(s => s.cursorIndex);
    const smoothCursorIndex = useTelemetryStore(s => s.smoothCursorIndex);
    const isPlaying = useTelemetryStore(s => s.isPlaying);
    const sessionMetadata = useTelemetryStore(s => s.sessionMetadata);

    const referenceTelemetryData = useTelemetryStore(s => s.referenceTelemetryData);
    const referenceLapIdx = useTelemetryStore(s => s.referenceLapIdx);
    const referenceSessionMetadata = useTelemetryStore(s => s.referenceSessionMetadata);
    const referenceCursorIndex = useTelemetryStore(s => s.referenceCursorIndex);
    const referenceDeltaIndex = useTelemetryStore(s => s.referenceDeltaIndex);
    const dashboardSyncMode = useTelemetryStore(s => s.dashboardSyncMode);
    const selectedSegIdx = useTelemetryStore(s => s.selectedSegIdx);

    const activeCursorIdx = isPlaying ? (smoothCursorIndex ?? cursorIndex) : cursorIndex;
    if (activeCursorIdx === null || !telemetryData) return null;

    const hasRef = !!referenceTelemetryData || referenceLapIdx !== null;
    const refData = referenceTelemetryData || telemetryData;
    const refIdx = (dashboardSyncMode === 'distance' && selectedSegIdx === null)
        ? referenceDeltaIndex
        : referenceCursorIndex;

    return (
        <div className="flex flex-row items-start gap-3">
            {/* Driver (current) */}
            <SteeringWheelView
                data={telemetryData}
                cursorIndex={activeCursorIdx}
                carModel={sessionMetadata?.modelName}
                theme="current"
                bare
            />
            {/* Reference */}
            {hasRef && refIdx !== null && (
                <SteeringWheelView
                    data={refData}
                    cursorIndex={refIdx}
                    carModel={(referenceSessionMetadata || sessionMetadata)?.modelName}
                    theme="reference"
                    bare
                />
            )}
        </div>
    );
};
