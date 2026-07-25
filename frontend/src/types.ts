
export interface VideoAssociation {
    videoPath: string | null;
    filename?: string | null;
    /** Per-lap sync offset (seconds). video.currentTime = offset + playbackElapsed. Keyed by lap number. */
    perLapOffsets: Record<string, number>;
    exists?: boolean;
}

export interface Session {
    id: string;
    path: string;
    size: number;
    created: number; // Unix timestamp
    trackName?: string;
    trackLayout?: string;
    layoutKey?: string;
    commonTrackName?: string;
    displayName?: string;
    trackAliases?: string[];
    carModel?: string;
    carClass?: string;
    rawCarName?: string;
    country?: string;
    officialTrackLength?: number;
    driverName?: string;
    bestLapTime?: number;
    bestLapValid?: boolean;
    game?: string; // 'LMU' | 'ACC'
    source?: 'sync' | 'manual' | 'live'; // 'sync' = game-folder import, 'manual' = upload, 'live' = real-time capture
}

export interface SessionMetadata {
    trackName: string;
    trackLayout: string;
    layoutKey?: string;
    carClass: string;
    modelName: string;   // Real Name (e.g. McLaren 720S...)
    rawCarName: string;  // Raw ID (e.g. United Autosports...)
    driverName: string;
    sessionTime?: string; // e.g. "12:00:26"
    sessionDuration?: number; // Total length in seconds
    sessionType?: string;
    weather?: string;
    trackSectors?: { lat: number; lon: number; id: number; }[]; // Derived from fastest lap
    fuelCapacity?: number;
    tyreCompoundMax?: number;
    steeringLock?: number;
    steeringLockString?: string;
    frequency?: number;
    carModel?: string;
    country?: string;
    officialTrackLength?: number;
}

export interface Lap {
    lap: number;
    startTime: number;
    endTime: number;
    duration: number;
    isValid: boolean;
    isOutLap: boolean;
    // Optional metrics
    s1?: number;
    s2?: number;
    s3?: number;
    stint?: number;
    inPit?: boolean;
    fuelUsed?: number;
}

export interface TelemetryData {
    [key: string]: number[] | any; // Support multi-dim arrays like number[][]
}

export interface TelemetryResponse {
    [key: string]: number[] | any;
}

export type AccSyncStatusKind = 'unconfigured' | 'folder-not-found' | 'paused' | 'active' | 'error' | 'scanning';

export interface AccSyncState {
    enabled: boolean;
    folder: string | null;
    autoDetected: boolean;
    status: AccSyncStatusKind;
    lastScanAt: number | null;
    lastResult: { imported: number; skipped: number; errors: number } | null;
    importedCount: number;
}

// LMU game-folder sync mirrors the ACC sync shape (kept as a distinct alias so
// the two paths stay decoupled).
export type LmuSyncStatusKind = AccSyncStatusKind;
export type LmuSyncState = AccSyncState;

// --- Live telemetry (real-time ACC UDP broadcasting feed) ---
export type LiveStateKind =
    | 'driving'    // connected + status LIVE + frames flowing
    | 'connected'  // connected but sitting in the garage (no recent frames)
    | 'waiting'    // reader running, game not sending yet ("Waiting for ACC…")
    | 'paused'     // session paused / in a menu (status != LIVE)
    | 'replay'     // watching a replay
    | 'stopped';   // reader not running

export interface LiveStatus {
    running: boolean;
    state: LiveStateKind;
    connected: boolean;
    source: string;                 // 'acc_udp' | 'mock'
    error: string | null;
    hz: number;                     // frames/s kept after downsampling
    packetsPerSec?: number;         // raw inbound UDP rate (diagnostics)
    carUpdatesPerSec?: number;
    frames: number;
    channels: string[];             // ordered channel names in each frame row
    buffered: number;               // samples currently in the ring buffer
    track: string;
    trackLength: number;
    car: string;
    driver: string;
    lap: number | null;
    lapTimeMs: number | null;
    lastLapMs: number | null;
    bestLapMs: number | null;
    delta: number | null;
    position: number | null;
    sessionType: string;
    gameStatus: string;             // LIVE | PAUSE | REPLAY | OFF
    config: {
        source: string;
        host: string;
        port: number;
        hasPassword: boolean;
        updateMs: number;
        autoStart: boolean;
    };
}

/** Broadcast when the source's lap counter advances. */
export interface LiveLapComplete {
    lap: number;
    timeMs: number | null;
    invalid: boolean;
    track?: string;
    car?: string;
}

export interface Profile {
    id: string;
    name: string;
    created_at: string;
    last_used: string;
    is_default: boolean;
    session_count?: number;
    avatar_url?: string | null;
}
export interface ChartConfig {
    id: string;        // The telemetry channel name
    alias?: string;    // Display name
    color: string;     // Hex color
    visible: boolean;
    order: number;
    height: number;
    unit?: string;
    widthPct?: number;   // Optional container width as a % of the chart column (default: full width)
    wheelIndex?: number; // 0:FL, 1:FR, 2:RL, 3:RR
}
export interface ReferenceLap {
    sessionId: string;
    sessionName: string;
    date: number;
    lap: number;
    stint: number;
    startTime: number;
    duration: number;
    isValid: boolean;
    s1?: number;
    s2?: number;
    s3?: number;
    driver: string;
    sessionTime: string;
    carModel?: string;
    rawCarName?: string;
    stintCount?: number;
    totalLaps?: number;
    fuelUsed?: number;
}

// ---- Car Setup ----
export interface SetupLREntry { L: string | null; R: string | null; }
export interface SetupLR3Entry { L: string | null; '3rd': string | null; R: string | null; }

export interface CarSetupData {
    powertrain: {
        engine: Record<string, string | null>;
        electronics: Record<string, string | null>;
        differential: Record<string, string | null>;
        gearing: Record<string, string | null>;
    };
    wheelsAndBrakes: {
        frontWheels: Record<string, SetupLREntry>;
        rearWheels: Record<string, SetupLREntry>;
        brakes: Record<string, string | null>;
    };
    suspension: {
        front: Record<string, SetupLR3Entry>;
        rear: Record<string, SetupLR3Entry>;
    };
    dampers: {
        front: Record<string, SetupLR3Entry>;
        rear: Record<string, SetupLR3Entry>;
    };
    chassisAndAero: {
        frontChassis: Record<string, string | null>;
        rearChassis: Record<string, string | null>;
        weight: Record<string, string | null>;
        advancedChassis: Record<string, string | null>;
    };
}
