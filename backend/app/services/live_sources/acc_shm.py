"""ACC shared-memory live source -- the full-physics feed (Tier A).

ACC's physics page is Windows named shared memory, which a native Linux process
cannot open (see ACC_REALTIME_TELEMETRY_DESIGN §2.3). `tools/acc_bridge/` runs
on the Windows side of the Proton prefix, reads the three mapped blocks and
forwards each sample here as a JSON datagram on loopback UDP. This class is the
receiving end: it listens, decodes, and maps ACC's raw fields onto the app's
channel names.

Relationship to `acc_udp.py`: that source talks ACC's broadcasting protocol and
gets position/speed/gear/timing for every car but **no pedals, steering, rpm or
tyres**. This one gets the full physics state for the driven car. They are
alternative sources for the same pipeline -- the channel names overlap
deliberately, so switching between them keeps the existing charts working.

Because the bridge sends raw ACC fields rather than app channels, the mapping
below can change without reshipping the Windows-side helper.
"""
import json
import logging
import math
import socket
import time
from collections import deque

from .acc_shm_direct import AccDirectSharedMemory, DirectReadUnavailable
from .base import LiveFrame, LiveSource, world_to_latlon

logger = logging.getLogger(__name__)

DEFAULT_BRIDGE_PORT = 9600

#: ACC's SPageFileGraphics.status
_STATUS = {0: "OFF", 1: "REPLAY", 2: "LIVE", 3: "PAUSE"}

#: ACC physics gear is 0=R, 1=N, 2=1st; the app uses -1=R, 0=N, 1=1st.
_GEAR_OFFSET = -1

# ACC's yaw grows clockwise seen from above; the app's Yaw Rate convention
# (inherited from the .ld importer's ROTY) is positive = counter-clockwise.
# Same flip acc_udp.py applies to its differentiated heading, so live laps from
# either source overlay on imported ones.
_YAW_SIGN = -1.0

#: Default total steering-wheel range in degrees. ACC reports steerAngle as
#: -1..1 of the car's lock, and the .ld path turns its -1..1 "Steering Pos" into
#: degrees with lock/2 (telemetry_service), so the same factor is used here.
DEFAULT_STEERING_LOCK_DEG = 800.0

_WHEELS = ("LF", "RF", "LR", "RR")

#: Per-wheel groups: app channel prefix -> bridge field. Emitted as four scalar
#: channels each ("TyresPressure LF", ...); the store reassembles them into the
#: [sample][wheel] arrays the bundled charts read.
WHEEL_GROUPS = {
    "TyresPressure": "wheelsPressure",
    "TyresCoreTemp": "tyreCoreTemperature",
    "Susp Pos": "suspensionTravel",
    "Brake Temp": "brakeTemp",
    "Slip Ratio": "slipRatio",
}

#: Scalar channels, in wire order.
_SCALAR_CHANNELS = [
    "Ground Speed",     # km/h
    "Throttle Pos",     # %
    "Brake Pos",        # %
    "Clutch Pos",       # %
    "Steering Angle",   # deg, positive = right
    "Engine RPM",
    "Gear",             # -1 = R, 0 = N, 1..n
    "GPS Latitude",
    "GPS Longitude",
    "Lap Dist",         # m along the current lap
    "Yaw Rate",         # deg/s, positive = counter-clockwise
    "In Pits",          # 0/1
    "G Force Lat",      # G
    "G Force Long",     # G
    "G Force Vert",     # G
    "Fuel Level",       # L
    "TC",               # cut intensity 0..1
    "ABS",              # intervention 0..1
    "Brake Bias",
    "Turbo Boost",
    "Water Temp",
    "Air Temp",
    "Road Temp",
]


def _f(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class AccSharedMemorySource(LiveSource):
    """Receives bridge datagrams and emits full-physics frames."""

    kind = "acc_shm"

    channels = list(_SCALAR_CHANNELS) + [
        f"{prefix} {w}" for prefix in WHEEL_GROUPS for w in _WHEELS
    ]

    #: no datagram for this long -> the bridge (or the game) went away
    SILENCE_TIMEOUT = 3.0

    def __init__(self, host: str = "127.0.0.1", port: int = DEFAULT_BRIDGE_PORT,
                 steering_lock_deg: float = DEFAULT_STEERING_LOCK_DEG,
                 sample_hz: float = 60.0, transport: str = "auto"):
        # "auto" prefers reading the game's memory and falls back to the bridge;
        # "direct" / "bridge" pin one transport (diagnostics, and forcing the
        # bridge when the game runs on another machine).
        self.transport = transport if transport in ("auto", "direct", "bridge") else "auto"
        # Bind on all interfaces: `host` in the live config means "the machine
        # running ACC" for the broadcasting source, which is the wrong thing to
        # bind a listener to.
        self.bind_host = "0.0.0.0"
        self.host = host or "127.0.0.1"
        self.port = int(port or DEFAULT_BRIDGE_PORT)
        self.steering_lock_deg = float(steering_lock_deg or DEFAULT_STEERING_LOCK_DEG)
        self.sample_period = 1.0 / max(1.0, float(sample_hz))
        self._sock = None
        self._reset()

    # -- lifecycle ---------------------------------------------------------
    def _reset(self) -> None:
        self._t0 = None
        self._last_rx = 0.0
        self._static = {}
        self._status = "OFF"
        self._lap = None
        self._bridge_version = None
        self._error = None
        # Lap Dist is derived from ACC's cumulative distanceTraveled minus its
        # value at the start of the current lap -- ACC's shared memory has no
        # track-length field, so this self-calibrates instead of needing a table.
        self._lap_start_distance = None
        self._track_length = 0
        self._packet_times = deque(maxlen=4000)
        self._direct = None
        self._direct_error = None
        self._last_direct_try = 0.0
        self._next_sample_at = 0.0

    def open(self) -> None:
        self._reset()
        # Always listen: the bridge stays usable as a fallback (hardened
        # ptrace_scope, or the game on another machine) even when direct
        # reading works.
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.settimeout(0.02)
        try:
            self._sock.bind((self.bind_host, self.port))
        except OSError as e:
            self._sock.close()
            self._sock = None
            raise RuntimeError(
                f"Could not listen for the ACC bridge on {self.bind_host}:{self.port}: {e}")
        logger.info("ACC bridge listener bound to %s:%d", self.bind_host, self.port)
        self._try_direct()

    def _try_direct(self) -> None:
        """Attach to a running ACC's shared memory, if we're allowed to.

        Retried on an interval so starting the game after the reader still
        picks it up without the user restarting anything.
        """
        self._last_direct_try = time.monotonic()
        if self.transport == "bridge":
            self._direct = None
            self._direct_error = None
            return
        try:
            self._direct = AccDirectSharedMemory()
            self._direct_error = None
            logger.info("Reading ACC shared memory directly (pid %d)", self._direct.pid)
        except DirectReadUnavailable as e:
            self._direct = None
            self._direct_error = str(e)
            logger.debug("Direct shared-memory read unavailable: %s", e)
        except Exception as e:  # unexpected -- don't take the reader down
            self._direct = None
            self._direct_error = str(e)
            logger.warning("Direct shared-memory read failed: %s", e, exc_info=True)

    def close(self) -> None:
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
        self._sock = None
        if self._direct:
            self._direct.close()
        self._reset()

    def _is_receiving(self) -> bool:
        return bool(self._last_rx) and (time.monotonic() - self._last_rx) < self.SILENCE_TIMEOUT

    @staticmethod
    def _rate(times) -> int:
        now = time.monotonic()
        while times and (now - times[0]) > 1.0:
            times.popleft()
        return len(times)

    def info(self) -> dict:
        return {
            "connected": self._is_receiving(),
            "packetsPerSec": self._rate(self._packet_times),
            "carUpdatesPerSec": self._rate(self._packet_times),
            "endpoint": f"{self.bind_host}:{self.port}",
            "transport": "direct" if self._direct is not None else "bridge",
            # The direct path's failure only matters when nothing is arriving by
            # either route -- a working bridge makes it irrelevant.
            "error": self._error or (
                None if (self._direct is not None or self._is_receiving())
                else self._direct_error),
            "track": self._static.get("track") or "",
            "trackLength": self._track_length,
            "car": self._static.get("carModel") or "",
            "driver": self._static.get("player") or "",
            "bridgeVersion": self._bridge_version,
            "smVersion": self._static.get("smVersion") or "",
            "status": self._status,
        }

    # -- reading -----------------------------------------------------------
    def read(self, timeout: float = 0.25) -> list:
        frames = []
        deadline = time.monotonic() + max(0.0, timeout)

        # Preferred transport: read the game's memory directly.
        if self._direct is not None:
            frames.extend(self._read_direct(deadline))
            if frames:
                return frames
        elif (time.monotonic() - self._last_direct_try) > 3.0:
            self._try_direct()

        # Fallback: datagrams from the Windows-side bridge.
        while True:
            try:
                data, _addr = self._sock.recvfrom(65536)
            except socket.timeout:
                break
            except OSError as e:
                logger.debug("Bridge recv failed: %s", e)
                break
            self._last_rx = time.monotonic()
            self._packet_times.append(self._last_rx)
            try:
                frame = self._handle(data)
            except (ValueError, TypeError, KeyError) as e:
                logger.debug("Bad bridge datagram: %s", e)
                frame = None
            if frame is not None:
                frames.append(frame)
            if time.monotonic() >= deadline:
                break
        return frames

    def _read_direct(self, deadline: float) -> list:
        """Poll the game's memory at the source rate until `deadline`."""
        frames = []
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now < self._next_sample_at:
                time.sleep(min(self._next_sample_at - now, deadline - now))
                continue
            self._next_sample_at = now + self.sample_period
            try:
                payload = self._direct.sample()
            except DirectReadUnavailable as e:
                logger.info("Lost direct access to ACC (%s); will re-attach", e)
                self._direct.close()
                self._direct = None
                self._direct_error = str(e)
                break
            except OSError as e:
                # The game exited mid-read.
                logger.info("ACC memory read failed (%s); will re-attach", e)
                self._direct.close()
                self._direct = None
                self._direct_error = str(e)
                break
            self._last_rx = time.monotonic()
            self._packet_times.append(self._last_rx)
            frame = self._frame_from(payload)
            if frame is not None:
                frames.append(frame)
        return frames

    def _handle(self, data: bytes):
        payload = json.loads(data.decode("utf-8"))
        return self._frame_from(payload)

    def _frame_from(self, payload: dict):
        p = payload.get("p") or {}
        g = payload.get("g") or {}
        s = payload.get("s") or {}

        self._bridge_version = payload.get("v")
        if s:
            self._static = s
        self._status = _STATUS.get(int(g.get("status") or 0), "OFF")

        # Menus/replays still carry a valid struct; don't log them as laps.
        if self._status not in ("LIVE", "PAUSE"):
            return None

        now = time.monotonic()
        if self._t0 is None:
            self._t0 = now
        t = now - self._t0

        lap = int(g.get("completedLaps") or 0)
        distance = _f(g.get("distanceTraveled"))
        lap_dist = self._lap_distance(lap, distance, g)

        coords = g.get("coords") or [0.0, 0.0, 0.0]
        # ACC's world frame is Y-up: the ground plane is (X, Z).
        lat, lon = world_to_latlon(_f(coords[0]), _f(coords[2]) if len(coords) > 2 else 0.0)

        ang = p.get("localAngularVel") or [0.0, 0.0, 0.0]
        yaw_rate = _YAW_SIGN * math.degrees(_f(ang[1]) if len(ang) > 1 else 0.0)

        acc = p.get("accG") or [0.0, 0.0, 0.0]

        values = {
            "Ground Speed": _f(p.get("speedKmh")),
            "Throttle Pos": _f(p.get("gas")) * 100.0,
            "Brake Pos": _f(p.get("brake")) * 100.0,
            "Clutch Pos": _f(p.get("clutch")) * 100.0,
            # steerAngle is -1..1 of the car's lock; negate so positive = right,
            # matching the .ld importer's sign convention for ACC.
            "Steering Angle": -_f(p.get("steerAngle")) * (self.steering_lock_deg / 2.0),
            "Engine RPM": _f(p.get("rpm")),
            "Gear": float(int(p.get("gear") or 0) + _GEAR_OFFSET),
            "GPS Latitude": lat,
            "GPS Longitude": lon,
            "Lap Dist": lap_dist,
            "Yaw Rate": yaw_rate,
            "In Pits": 1.0 if (g.get("isInPitLane") or g.get("isInPit")) else 0.0,
            "G Force Lat": _f(acc[0]) if len(acc) > 0 else 0.0,
            "G Force Long": _f(acc[2]) if len(acc) > 2 else 0.0,
            "G Force Vert": _f(acc[1]) if len(acc) > 1 else 0.0,
            "Fuel Level": _f(p.get("fuel")),
            "TC": _f(p.get("tc")),
            "ABS": _f(p.get("abs")),
            "Brake Bias": _f(p.get("brakeBias")),
            "Turbo Boost": _f(p.get("turboBoost")),
            "Water Temp": _f(p.get("waterTemp")),
            "Air Temp": _f(p.get("airTemp")),
            "Road Temp": _f(p.get("roadTemp")),
        }
        for prefix, field in WHEEL_GROUPS.items():
            quad = p.get(field) or []
            for i, wheel in enumerate(_WHEELS):
                values[f"{prefix} {wheel}"] = _f(quad[i]) if i < len(quad) else 0.0

        meta = {
            "game": "ACC",
            "track": self._static.get("track") or "",
            "trackLength": self._track_length,
            "car": self._static.get("carModel") or "",
            "driver": self._static.get("player") or "",
            "lap": lap,
            "spline": _f(g.get("normalizedCarPosition")),
            "position": int(g.get("position") or 0),
            "delta": int(g.get("iDeltaLapTime") or 0),
            "lapTimeMs": _positive(g.get("iCurrentTime")),
            "lastLapMs": _positive(g.get("iLastTime")),
            "bestLapMs": _positive(g.get("iBestTime")),
            "lapInvalid": not bool(g.get("isValidLap")),
            "inPits": bool(g.get("isInPitLane") or g.get("isInPit")),
            "sector": int(g.get("currentSectorIndex") or 0),
            "tyreCompound": g.get("tyreCompound") or "",
            "fuelPerLap": _f(g.get("fuelXLap")),
            "sessionType": "",
            "phase": self._status,
            "status": self._status,
        }
        return LiveFrame(t=t, values=values, meta=meta)

    def _lap_distance(self, lap: int, distance: float, g: dict) -> float:
        """Metres into the current lap, from ACC's cumulative distanceTraveled.

        Also learns the track length on each completed lap, since the shared
        memory never reports it. Falls back to spline * learned length when
        distanceTraveled looks unusable (session restart, teleport to pits).
        """
        if self._lap_start_distance is None or lap != self._lap:
            if self._lap is not None and lap == self._lap + 1 and self._lap_start_distance is not None:
                measured = distance - self._lap_start_distance
                # Sanity-bound it: ACC circuits run ~1.5-7.5 km.
                if 1000.0 < measured < 30000.0:
                    self._track_length = int(measured)
            self._lap = lap
            self._lap_start_distance = distance

        lap_dist = distance - self._lap_start_distance
        if lap_dist < 0 or (self._track_length and lap_dist > self._track_length * 1.5):
            # distanceTraveled jumped (restart/teleport) -> re-baseline and fall
            # back to the spline fraction for this frame.
            self._lap_start_distance = distance
            lap_dist = _f(g.get("normalizedCarPosition")) * (self._track_length or 0)
        return lap_dist


def _positive(value):
    """ACC writes huge sentinels for 'no time yet'."""
    try:
        v = int(value)
    except (TypeError, ValueError):
        return None
    return v if 0 < v < 2147483647 else None
