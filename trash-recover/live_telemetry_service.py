"""Live telemetry ingestion spine (ACC_REALTIME_TELEMETRY_DESIGN §4).

One reader thread owns the active source, downsamples its frames to ~60 Hz,
keeps the last ~90 s in a ring buffer and fans batches out to every connected
WebSocket client. Sources are pluggable (`live_sources/`), so the ACC UDP
broadcasting client shipped today and the Proton shared-memory bridge planned
for Tier A feed the exact same pipeline.

Kept completely separate from the game-folder sync services: nothing here reads
or writes their state.
"""
import json
import logging
import os
import re
import threading
import time
from collections import deque

from .live_sources.acc_udp import DEFAULT_PORT, AccUdpBroadcastSource
from .live_sources.mock_replay import MockLiveSource

logger = logging.getLogger(__name__)

ACC_APP_ID = "805550"
# Broadcasting config lives next to the MoTeC folder inside the Proton prefix.
_CONFIG_SUFFIX = os.path.join(
    "drive_c", "users", "steamuser", "Documents",
    "Assetto Corsa Competizione", "Config", "broadcasting.json",
)

#: frames/second kept after downsampling the source
SAMPLE_HZ = 60.0
#: how often batched frames are pushed to WebSocket clients (each push re-renders
#: the live charts/map, so this is deliberately modest -- the app shares a GPU
#: with the game)
BROADCAST_HZ = 10.0
#: ring-buffer depth in seconds (what a newly connected client gets instantly)
BUFFER_SECONDS = 90

DEFAULT_CONFIG = {
    "source": "acc_udp",          # "acc_udp" | "mock"
    "host": "127.0.0.1",
    "port": DEFAULT_PORT,
    "password": "",
    "commandPassword": "",
    # Rate we ask ACC to broadcast at. The game does this work on its own
    # thread while rendering, so a 16 ms (60 Hz) request measurably costs frames
    # in-game; 50 ms (20 Hz) is still smooth for a live map/trace.
    "updateMs": 50,
    "autoStart": False,
    # Bumped when a stored config needs a one-time fix-up (see _load_config).
    "configVersion": 1,
}


# ---------------------------------------------------------------------------
# broadcasting.json detection
#
# Deliberately duplicated (not imported) from acc_sync_service: the sync path is
# load-bearing and must stay untouched by the live feature.
# ---------------------------------------------------------------------------

def _steam_library_roots() -> list:
    home = os.path.expanduser("~")
    roots = [
        os.path.join(home, ".steam", "steam"),
        os.path.join(home, ".local", "share", "Steam"),
        os.path.join(home, ".var", "app", "com.valvesoftware.Steam", "data", "Steam"),
    ]
    for base in list(roots):
        vdf = os.path.join(base, "steamapps", "libraryfolders.vdf")
        if os.path.isfile(vdf):
            try:
                with open(vdf, "r", encoding="utf-8", errors="ignore") as fh:
                    for m in re.finditer(r'"path"\s*"([^"]+)"', fh.read()):
                        p = m.group(1).replace("\\\\", "/")
                        if p not in roots:
                            roots.append(p)
            except Exception as e:
                logger.debug("Could not parse %s: %s", vdf, e)
    return roots


def _broadcasting_config_candidates() -> list:
    cands = [os.path.join(base, "steamapps", "compatdata", ACC_APP_ID, "pfx", _CONFIG_SUFFIX)
             for base in _steam_library_roots()]
    cands.append(os.path.join(os.path.expanduser("~"), "Documents",
                              "Assetto Corsa Competizione", "Config", "broadcasting.json"))
    return cands


def detect_broadcast_config() -> dict:
    """Read ACC's broadcasting.json (port/passwords) if we can find it.

    Returns ``{"path": str|None, "port": int|None, "password": str|None,
    "commandPassword": str|None}``. ACC writes the file as UTF-16 by default, so
    both encodings are attempted.
    """
    for path in _broadcasting_config_candidates():
        if not os.path.isfile(path):
            continue
        for encoding in ("utf-8-sig", "utf-16"):
            try:
                with open(path, "r", encoding=encoding) as fh:
                    cfg = json.load(fh)
                break
            except (UnicodeError, json.JSONDecodeError):
                cfg = None
            except OSError as e:
                logger.warning("Could not read %s: %s", path, e)
                cfg = None
                break
        if not isinstance(cfg, dict):
            continue
        return {
            "path": path,
            "port": int(cfg.get("updListenerPort") or DEFAULT_PORT),
            "password": cfg.get("connectionPassword") or "",
            "commandPassword": cfg.get("commandPassword") or "",
        }
    return {"path": None, "port": None, "password": None, "commandPassword": None}


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class LiveTelemetryService:
    """Singleton owning the reader thread, the ring buffer and the subscribers."""

    def __init__(self, config_dir: str = None):
        self._config_dir = config_dir
        self._lock = threading.RLock()
        self._thread = None
        self._stop_evt = threading.Event()
        self._config = dict(DEFAULT_CONFIG)
        self._config_loaded = False

        self._channels = []
        self._ring = deque(maxlen=int(BUFFER_SECONDS * SAMPLE_HZ))
        self._subs = []           # list of (asyncio loop, asyncio.Queue)
        self._meta = {}
        self._source_info = {"connected": False}
        self._error = None
        self._frames_seen = 0
        self._hz = 0.0
        self._last_frame_at = None
        self._lap = None
        self._running = False

    # -- config ------------------------------------------------------------
    def _config_path(self) -> str:
        base = self._config_dir
        if not base:
            from .profiles_service import ProfilesService
            base = ProfilesService.get_app_data_dir()
        return os.path.join(base, "live_config.json")

    def _load_config(self) -> dict:
        if self._config_loaded:
            return self._config
        path = self._config_path()
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    stored = json.load(fh)
                if isinstance(stored, dict):
                    self._config = {**DEFAULT_CONFIG, **stored}
                    if not stored.get("configVersion"):
                        # v0 configs kept the old 16 ms (60 Hz) default, which
                        # costs the game real frames. Move them to 20 Hz once;
                        # an explicit choice afterwards is never overridden.
                        self._config["updateMs"] = DEFAULT_CONFIG["updateMs"]
                        self._config["configVersion"] = 1
                        logger.info("Live config migrated to %d ms updates",
                                    self._config["updateMs"])
            except Exception as e:
                logger.warning("Corrupt live_config.json (%s); using defaults: %s", path, e)
        self._config_loaded = True
        return self._config

    def _save_config(self) -> None:
        path = self._config_path()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self._config, fh, indent=2)
            os.replace(tmp, path)
        except OSError as e:
            logger.warning("Could not persist live config: %s", e)

    def set_config(self, **updates) -> dict:
        """Update the live config. Restarts the reader if it is running."""
        with self._lock:
            cfg = dict(self._load_config())
            for key, value in updates.items():
                if value is None or key not in DEFAULT_CONFIG:
                    continue
                cfg[key] = int(value) if key in ("port", "updateMs") else value
            if cfg["source"] not in ("acc_udp", "mock"):
                raise ValueError(f"Unknown live source: {cfg['source']}")
            changed = cfg != self._config
            self._config = cfg
            self._config_loaded = True
            self._save_config()
            was_running = self._running

        if changed and was_running:
            self.stop()
            self.start()
        return self.get_status()

    # -- lifecycle ---------------------------------------------------------
    def start(self, **config_updates) -> dict:
        if config_updates:
            self.set_config(**config_updates)
        with self._lock:
            self._load_config()
            if self._running:
                return self.get_status()
            self._stop_evt.clear()
            self._ring.clear()
            self._error = None
            self._frames_seen = 0
            self._lap = None
            self._meta = {}
            self._running = True
            self._thread = threading.Thread(target=self._run, name="live-telemetry",
                                            daemon=True)
            self._thread.start()
        logger.info("Live telemetry started (source=%s)", self._config.get("source"))
        return self.get_status()

    def stop(self) -> dict:
        with self._lock:
            thread = self._thread
            self._stop_evt.set()
            self._running = False
        if thread and thread.is_alive():
            thread.join(timeout=3.0)
        with self._lock:
            self._thread = None
            self._source_info = {"connected": False}
        self._broadcast(self._status_message())
        logger.info("Live telemetry stopped")
        return self.get_status()

    # -- status ------------------------------------------------------------
    def get_status(self) -> dict:
        with self._lock:
            cfg = dict(self._load_config())
            info = dict(self._source_info or {})
            meta = dict(self._meta or {})
            connected = bool(info.get("connected"))
            game_status = meta.get("status") or ("OFF" if not connected else "LIVE")
            if not self._running:
                state = "stopped"
            elif not connected:
                state = "waiting"
            elif game_status == "REPLAY":
                state = "replay"
            elif game_status != "LIVE":
                state = "paused"
            elif self._last_frame_at and (time.monotonic() - self._last_frame_at) < 2.0:
                state = "driving"
            else:
                state = "connected"

            return {
                "running": self._running,
                "state": state,
                "connected": connected,
                "source": cfg.get("source"),
                "error": self._error or info.get("error"),
                "hz": round(self._hz, 1),
                # Raw inbound rates from the source (diagnostics: if ACC is
                # sending 60 packets/s but hz is 1, the filter is at fault).
                "packetsPerSec": info.get("packetsPerSec", 0),
                "carUpdatesPerSec": info.get("carUpdatesPerSec", 0),
                "frames": self._frames_seen,
                "channels": list(self._channels),
                "buffered": len(self._ring),
                "track": meta.get("track") or info.get("track") or "",
                "trackLength": meta.get("trackLength") or info.get("trackLength") or 0,
                "car": meta.get("car") or info.get("car") or "",
                "driver": meta.get("driver") or info.get("driver") or "",
                "lap": meta.get("lap"),
                "lapTimeMs": meta.get("lapTimeMs"),
                "lastLapMs": meta.get("lastLapMs"),
                "bestLapMs": meta.get("bestLapMs"),
                "delta": meta.get("delta"),
                "position": meta.get("position"),
                "sessionType": meta.get("sessionType") or "",
                "gameStatus": game_status,
                "config": {
                    "source": cfg.get("source"),
                    "host": cfg.get("host"),
                    "port": cfg.get("port"),
                    # The connection password is write-only from the UI's point of
                    # view; only report whether one is set.
                    "hasPassword": bool(cfg.get("password")),
                    "updateMs": cfg.get("updateMs"),
                    "autoStart": bool(cfg.get("autoStart")),
                },
            }

    # -- subscribers -------------------------------------------------------
    def subscribe(self, loop, queue) -> None:
        with self._lock:
            self._subs.append((loop, queue))

    def unsubscribe(self, queue) -> None:
        with self._lock:
            self._subs = [(l, q) for (l, q) in self._subs if q is not queue]

    def snapshot(self) -> dict:
        """Status + the buffered tail, sent to a client the moment it connects."""
        with self._lock:
            return {
                "type": "snapshot",
                "status": self.get_status(),
                "channels": list(self._channels),
                "meta": dict(self._meta or {}),
                "rows": list(self._ring),
            }

    def _broadcast(self, message: dict) -> None:
        payload = json.dumps(message, default=_json_safe)
        with self._lock:
            subs = list(self._subs)
        for loop, queue in subs:
            try:
                loop.call_soon_threadsafe(_offer, queue, payload)
            except RuntimeError:
                # Event loop already closed; the endpoint's finally clause will
                # unsubscribe it.
                continue

    def _status_message(self) -> dict:
        return {"type": "status", "status": self.get_status()}

    # -- reader thread -----------------------------------------------------
    def _build_source(self):
        cfg = self._config
        if cfg.get("source") == "mock":
            return MockLiveSource(hz=SAMPLE_HZ)
        return AccUdpBroadcastSource(
            host=cfg.get("host") or "127.0.0.1",
            port=int(cfg.get("port") or DEFAULT_PORT),
            password=cfg.get("password") or "",
            command_password=cfg.get("commandPassword") or "",
            update_ms=int(cfg.get("updateMs") or 16),
        )

    def _run(self) -> None:
        source = None
        try:
            source = self._build_source()
            source.open()
        except Exception as e:
            logger.error("Live source failed to open: %s", e, exc_info=True)
            with self._lock:
                self._error = str(e)
                self._running = False
            self._broadcast(self._status_message())
            return

        with self._lock:
            self._channels = list(source.channels)
        self._broadcast(self._status_message())

        min_dt = 1.0 / SAMPLE_HZ
        batch_dt = 1.0 / BROADCAST_HZ
        pending = []
        last_kept_t = None
        last_flush = time.monotonic()
        last_status_push = 0.0
        last_status = None
        rate_window = deque(maxlen=int(SAMPLE_HZ * 4))  # frame timestamps, last ~1 s

        try:
            while not self._stop_evt.is_set():
                try:
                    frames = source.read(timeout=0.1)
                except Exception as e:
                    logger.error("Live source read failed: %s", e, exc_info=True)
                    with self._lock:
                        self._error = str(e)
                    break

                now = time.monotonic()
                for frame in frames:
                    # Downsample to SAMPLE_HZ; a source may run faster.
                    if last_kept_t is not None and (frame.t - last_kept_t) < min_dt * 0.9:
                        continue
                    last_kept_t = frame.t
                    row = [round(frame.t, 4)] + [
                        _num(frame.values.get(c)) for c in self._channels
                    ]
                    with self._lock:
                        self._ring.append(row)
                        self._meta = frame.meta
                        self._frames_seen += 1
                        self._last_frame_at = now
                    rate_window.append(now)
                    pending.append(row)
                    self._check_lap(frame)

                # Rate over the last second only, so a stalled feed reads 0 Hz
                # instead of holding the last measured rate.
                while rate_window and (now - rate_window[0]) > 1.0:
                    rate_window.popleft()
                self._hz = float(len(rate_window))

                with self._lock:
                    self._source_info = source.info()

                if pending and (now - last_flush) >= batch_dt:
                    with self._lock:
                        meta = dict(self._meta or {})
                    self._broadcast({"type": "frames", "meta": meta, "rows": pending})
                    pending = []
                    last_flush = now

                # Heartbeat: keeps "waiting for ACC" fresh and lets the WebSocket
                # notice a client that went away while no frames were flowing.
                status = self.get_status()
                key = (status["state"], status["connected"], status["track"],
                       status["car"], status["lap"], status["error"])
                if key != last_status or (now - last_status_push) >= 1.0:
                    last_status = key
                    last_status_push = now
                    self._broadcast({"type": "status", "status": status})
        finally:
            try:
                source.close()
            except Exception as e:
                logger.debug("Live source close failed: %s", e)
            with self._lock:
                self._running = False
                self._source_info = {"connected": False}
            self._broadcast(self._status_message())

    def _check_lap(self, frame) -> None:
        """Emit a lap_complete event when the source's lap counter advances.

        Persisting the finished lap as a normal DuckDB session is design Phase 5;
        the event is broadcast now so the UI can react (and so the segmentation
        logic is exercised against the real feed).
        """
        lap = frame.meta.get("lap")
        if lap is None:
            return
        prev = self._lap
        self._lap = lap
        if prev is None or lap == prev:
            return
        if lap < prev:
            # Session restart / teleport to pits -> drop the in-progress buffer
            # rather than persisting a garbage lap.
            logger.info("Live lap counter went backwards (%s -> %s); resetting buffer", prev, lap)
            with self._lock:
                self._ring.clear()
            return
        self._broadcast({
            "type": "lap_complete",
            "lap": prev,
            "timeMs": frame.meta.get("lastLapMs"),
            "invalid": bool(frame.meta.get("lapInvalid")),
            "track": frame.meta.get("track"),
            "car": frame.meta.get("car"),
        })


def _num(value):
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return round(v, 5)


def _offer(queue, payload: str) -> None:
    """Push to a client queue, dropping the oldest item if it is backed up."""
    if queue.full():
        try:
            queue.get_nowait()
        except Exception:
            return
    try:
        queue.put_nowait(payload)
    except Exception:
        pass


def _json_safe(obj):
    return str(obj)


_service = None
_service_lock = threading.Lock()


def get_service() -> LiveTelemetryService:
    global _service
    with _service_lock:
        if _service is None:
            _service = LiveTelemetryService()
        return _service
