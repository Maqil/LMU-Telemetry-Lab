"""ACC UDP broadcasting client -- the Linux-native live source (Tier B).

ACC ships a UDP "broadcasting" API used by timing/overlay apps. Because it is a
plain network protocol it works from a **native Linux backend while ACC runs
under Proton** -- no Windows-side bridge, no shared memory. That is the whole
reason this is the first live source we ship (see ACC_REALTIME_TELEMETRY_DESIGN
§2.3): it gives a live map, speed, gear, lap fraction, lap times and deltas
today; pedals/steering/rpm/tyres need the shared-memory bridge (Tier A).

Enable it in ACC by editing
``…/Documents/Assetto Corsa Competizione/Config/broadcasting.json``:
``{"updListenerPort": 9000, "connectionPassword": "asd", "commandPassword": ""}``

Wire format: little-endian; strings are a uint16 byte-length followed by UTF-8.
The layouts below follow Kunos' reference client (ksBroadcastingNetwork).
"""
import logging
import math
import socket
import struct
import time
from collections import deque

from .base import LiveFrame, LiveSource, world_to_latlon

logger = logging.getLogger(__name__)

BROADCASTING_PROTOCOL_VERSION = 4
DEFAULT_PORT = 9000

# Inbound (game -> us)
_REGISTRATION_RESULT = 1
_REALTIME_UPDATE = 2
_REALTIME_CAR_UPDATE = 3
_ENTRY_LIST = 4
_TRACK_DATA = 5
_ENTRY_LIST_CAR = 6
_BROADCASTING_EVENT = 7

# Outbound (us -> game)
_REGISTER_COMMAND_APPLICATION = 1
_UNREGISTER_COMMAND_APPLICATION = 9
_REQUEST_ENTRY_LIST = 10
_REQUEST_TRACK_DATA = 11

# Session phases that mean "the car can be on track"; anything else freezes the
# live window rather than logging menu//replay noise.
_PHASE_NAMES = {
    0: "NONE", 1: "STARTING", 2: "PRE_FORMATION", 3: "FORMATION_LAP",
    4: "PRE_SESSION", 5: "SESSION", 6: "SESSION_OVER", 7: "POST_SESSION",
    8: "RESULT_UI",
}
_SESSION_TYPES = {
    0: "Practice", 4: "Qualifying", 9: "Superpole", 10: "Race",
    11: "Hotlap", 12: "Hotstint", 13: "HotlapSuperpole", 14: "Replay",
}
# carLocation
_LOC_TRACK = 1

# Gear byte -> app gear (R = -1, N = 0, 1st = 1). ACC sends 0=R, 1=N, 2=1st, so
# one is subtracted. (Kunos' C# sample subtracts 2, but observed traffic from a
# live session has N=1 and 1st=2 -- a car sitting in the garage reports 1.)
_GEAR_OFFSET = -1

# ACC's yaw grows clockwise when viewed from above, while the app's Yaw Rate
# convention (inherited from the .ld importer's ROTY) is positive = counter-
# clockwise. Flip the derived rate so live and imported laps agree in sign.
_YAW_SIGN = -1.0

# Best-effort car-model id -> name. Unknown ids fall back to "ACC Car #<id>",
# which is cosmetic only (nothing downstream keys off it).
CAR_MODELS = {
    0: "Porsche 991 GT3 R", 1: "Mercedes-AMG GT3", 2: "Ferrari 488 GT3",
    3: "Audi R8 LMS", 4: "Lamborghini Huracan GT3", 5: "McLaren 650S GT3",
    6: "Nissan GT-R Nismo GT3 2018", 7: "BMW M6 GT3",
    8: "Bentley Continental GT3 2018", 9: "Porsche 991 II GT3 Cup",
    10: "Nissan GT-R Nismo GT3 2017", 11: "Bentley Continental GT3 2016",
    12: "Aston Martin V12 Vantage GT3", 13: "Lamborghini Gallardo R-EX",
    14: "Jaguar G3", 15: "Lexus RC F GT3", 16: "Lamborghini Huracan GT3 Evo",
    17: "Honda NSX GT3", 18: "Lamborghini Huracan Super Trofeo",
    19: "Audi R8 LMS Evo", 20: "AMR V8 Vantage GT3", 21: "Honda NSX GT3 Evo",
    22: "McLaren 720S GT3", 23: "Porsche 911 II GT3 R", 24: "Ferrari 488 GT3 Evo",
    25: "Mercedes-AMG GT3 Evo", 26: "Ferrari 488 Challenge Evo",
    27: "BMW M2 CS Racing", 28: "Porsche 911 GT3 Cup (992)",
    29: "Lamborghini Huracan Super Trofeo Evo2", 30: "BMW M4 GT3",
    31: "Audi R8 LMS GT3 Evo II", 32: "Ferrari 296 GT3",
    33: "Lamborghini Huracan GT3 Evo2", 34: "Porsche 992 GT3 R",
    35: "McLaren 720S GT3 Evo", 36: "Ford Mustang GT3",
    50: "Alpine A110 GT4", 51: "Aston Martin Vantage GT4", 52: "Audi R8 LMS GT4",
    53: "BMW M4 GT4", 55: "Chevrolet Camaro GT4", 56: "Ginetta G55 GT4",
    57: "KTM X-Bow GT4", 58: "Maserati MC GT4", 59: "McLaren 570S GT4",
    60: "Mercedes-AMG GT4", 61: "Porsche 718 Cayman GT4",
    80: "Audi R8 LMS GT2", 82: "KTM X-Bow GT2", 83: "Maserati MC20 GT2",
    84: "Mercedes-AMG GT2", 85: "Porsche 911 GT2 RS CS Evo", 86: "Porsche 935",
}


class _Reader:
    """Cursor over one datagram."""

    def __init__(self, data: bytes):
        self.d = data
        self.i = 0

    def _take(self, n: int) -> bytes:
        if self.i + n > len(self.d):
            raise ValueError("truncated broadcasting packet")
        chunk = self.d[self.i:self.i + n]
        self.i += n
        return chunk

    def u8(self) -> int:
        return self._take(1)[0]

    def u16(self) -> int:
        return struct.unpack("<H", self._take(2))[0]

    def i32(self) -> int:
        return struct.unpack("<i", self._take(4))[0]

    def f32(self) -> float:
        return struct.unpack("<f", self._take(4))[0]

    def string(self) -> str:
        return self._take(self.u16()).decode("utf-8", errors="replace")

    def lap(self) -> dict:
        laptime = self.i32()
        car_index = self.u16()
        driver_index = self.u16()
        splits = [self.i32() for _ in range(self.u8())]
        is_invalid = bool(self.u8())
        is_valid_for_best = bool(self.u8())
        is_out_lap = bool(self.u8())
        is_in_lap = bool(self.u8())
        # ACC sends int32.MaxValue for "no time yet".
        return {
            "timeMs": None if laptime >= 2147483647 or laptime <= 0 else laptime,
            "carIndex": car_index,
            "driverIndex": driver_index,
            "splits": [s for s in splits if 0 < s < 2147483647],
            "isInvalid": is_invalid,
            "isValidForBest": is_valid_for_best,
            "isOutLap": is_out_lap,
            "isInLap": is_in_lap,
        }


def _write_string(buf: bytearray, value: str) -> None:
    raw = (value or "").encode("utf-8")
    buf += struct.pack("<H", len(raw))
    buf += raw


class AccUdpBroadcastSource(LiveSource):
    """Registers with ACC's broadcasting API and emits frames for the focused car."""

    kind = "acc_udp"

    channels = [
        "Ground Speed",     # km/h
        "Gear",             # -1 = R, 0 = N, 1..n
        "GPS Latitude",
        "GPS Longitude",
        "Lap Dist",         # m along the lap
        "Yaw Rate",         # deg/s, positive = counter-clockwise
        "In Pits",          # 0/1
    ]

    #: no traffic for this long -> assume ACC closed/restarted and re-register
    SILENCE_TIMEOUT = 3.0
    REGISTER_INTERVAL = 1.0

    def __init__(self, host: str = "127.0.0.1", port: int = DEFAULT_PORT,
                 password: str = "", command_password: str = "",
                 update_ms: int = 16, display_name: str = "LMU Telemetry Lab"):
        self.host = host or "127.0.0.1"
        self.port = int(port or DEFAULT_PORT)
        self.password = password or ""
        self.command_password = command_password or ""
        self.update_ms = max(4, int(update_ms or 16))
        self.display_name = display_name
        self._sock = None
        self._reset_connection()

    # -- lifecycle ---------------------------------------------------------
    def _reset_connection(self) -> None:
        self._connection_id = None
        self._registered = False
        self._register_error = None
        self._t0 = None
        self._last_rx = 0.0
        self._last_register_at = 0.0
        self._last_entry_request = 0.0
        self._focused_car = None
        self._session = {}
        self._track = {"name": "", "id": None, "meters": 0}
        self._cars = {}
        self._prev_yaw = None
        self._prev_yaw_t = None
        self._last_event = None
        # Inbound rates, for telling "ACC isn't sending" apart from "we're
        # filtering everything out" when the live feed looks slow.
        self._packet_times = deque(maxlen=4000)
        self._car_update_times = deque(maxlen=4000)

    def open(self) -> None:
        self._reset_connection()
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.settimeout(0.1)
        # Bind an ephemeral local port; ACC replies to whatever address we send from.
        self._sock.bind(("0.0.0.0", 0))
        self._register()
        logger.info("ACC broadcasting source opened -> %s:%d", self.host, self.port)

    def close(self) -> None:
        if self._sock:
            try:
                if self._connection_id is not None:
                    buf = bytearray([_UNREGISTER_COMMAND_APPLICATION])
                    buf += struct.pack("<i", self._connection_id)
                    self._sock.sendto(bytes(buf), (self.host, self.port))
            except OSError:
                pass
            try:
                self._sock.close()
            except OSError:
                pass
        self._sock = None
        self._reset_connection()

    @staticmethod
    def _rate(times) -> int:
        now = time.monotonic()
        while times and (now - times[0]) > 1.0:
            times.popleft()
        return len(times)

    def info(self) -> dict:
        car = self._cars.get(self._focused_car) or {}
        return {
            "packetsPerSec": self._rate(self._packet_times),
            "carUpdatesPerSec": self._rate(self._car_update_times),
            "focusedCar": self._focused_car,
            "connected": self._registered and self._is_receiving(),
            "registered": self._registered,
            "error": self._register_error,
            "endpoint": f"{self.host}:{self.port}",
            "track": self._track.get("name") or "",
            "trackLength": self._track.get("meters") or 0,
            "car": car.get("model") or "",
            "driver": car.get("driver") or "",
            "sessionType": self._session.get("sessionType"),
            "phase": self._session.get("phase"),
            "carCount": len(self._cars),
        }

    # -- protocol ----------------------------------------------------------
    def _send(self, payload: bytes) -> None:
        try:
            self._sock.sendto(payload, (self.host, self.port))
        except OSError as e:
            logger.debug("ACC broadcasting send failed: %s", e)

    def _register(self) -> None:
        buf = bytearray([_REGISTER_COMMAND_APPLICATION, BROADCASTING_PROTOCOL_VERSION])
        _write_string(buf, self.display_name)
        _write_string(buf, self.password)
        buf += struct.pack("<i", self.update_ms)
        _write_string(buf, self.command_password)
        self._send(bytes(buf))
        self._last_register_at = time.monotonic()

    def _request(self, kind: int) -> None:
        if self._connection_id is None:
            return
        buf = bytearray([kind])
        buf += struct.pack("<i", self._connection_id)
        self._send(bytes(buf))

    def _is_receiving(self) -> bool:
        return bool(self._last_rx) and (time.monotonic() - self._last_rx) < self.SILENCE_TIMEOUT

    def read(self, timeout: float = 0.25) -> list:
        frames = []
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            try:
                data, _addr = self._sock.recvfrom(65536)
            except socket.timeout:
                break
            except OSError as e:
                logger.debug("ACC broadcasting recv failed: %s", e)
                break
            self._last_rx = time.monotonic()
            self._packet_times.append(self._last_rx)
            try:
                frame = self._handle(data)
            except ValueError as e:  # truncated/unexpected packet -> skip it
                logger.debug("Bad broadcasting packet: %s", e)
                frame = None
            if frame is not None:
                frames.append(frame)
            if time.monotonic() >= deadline:
                break

        self._maintain()
        return frames

    def _maintain(self) -> None:
        """Re-register when ACC is silent (not running yet, or restarted)."""
        now = time.monotonic()
        if self._is_receiving():
            return
        if self._registered:
            logger.info("ACC broadcasting went silent; re-registering")
            self._registered = False
            self._connection_id = None
            self._focused_car = None
        if now - self._last_register_at >= self.REGISTER_INTERVAL:
            self._register()

    def _handle(self, data: bytes):
        r = _Reader(data)
        kind = r.u8()

        if kind == _REGISTRATION_RESULT:
            self._connection_id = r.i32()
            success = bool(r.u8())
            read_only = bool(r.u8())
            err = r.string()
            self._registered = success
            self._register_error = None if success else (err or "Registration refused")
            if success:
                logger.info("Registered with ACC broadcasting (id=%s, readonly=%s)",
                            self._connection_id, read_only)
                self._request(_REQUEST_ENTRY_LIST)
                self._request(_REQUEST_TRACK_DATA)
            else:
                logger.warning("ACC broadcasting registration refused: %s", err)
            return None

        if kind == _REALTIME_UPDATE:
            self._on_realtime_update(r)
            return None

        if kind == _REALTIME_CAR_UPDATE:
            return self._on_car_update(r)

        if kind == _ENTRY_LIST:
            r.i32()  # connection id
            known = {r.u16() for _ in range(r.u16())}
            # Drop cars that left; keep what we already know about the rest.
            self._cars = {i: c for i, c in self._cars.items() if i in known}
            for i in known:
                self._cars.setdefault(i, {"model": "", "driver": "", "raceNumber": None})
            return None

        if kind == _ENTRY_LIST_CAR:
            self._on_entry_list_car(r)
            return None

        if kind == _TRACK_DATA:
            r.i32()  # connection id
            self._track = {"name": r.string(), "id": r.i32(), "meters": r.i32()}
            logger.info("ACC live track: %s (%s m)", self._track["name"], self._track["meters"])
            return None

        if kind == _BROADCASTING_EVENT:
            self._last_event = {
                "type": r.u8(), "message": r.string(),
                "timeMs": r.i32(), "carId": r.i32(),
            }
            return None

        return None

    def _on_realtime_update(self, r: _Reader) -> None:
        s = {
            "eventIndex": r.u16(),
            "sessionIndex": r.u16(),
            "sessionType": _SESSION_TYPES.get(r.u8(), "Unknown"),
            "phase": _PHASE_NAMES.get(r.u8(), "NONE"),
            "sessionTime": r.f32(),
            "sessionEndTime": r.f32(),
        }
        focused = r.i32()
        r.string()  # active camera set
        r.string()  # active camera
        r.string()  # current HUD page
        s["isReplay"] = bool(r.u8())
        if s["isReplay"]:
            r.f32()  # replay session time
            r.f32()  # replay remaining time
        s["timeOfDay"] = r.f32()
        s["ambientTemp"] = r.u8()
        s["trackTemp"] = r.u8()
        s["clouds"] = r.u8() / 10.0
        s["rainLevel"] = r.u8() / 10.0
        s["wetness"] = r.u8() / 10.0
        s["bestSessionLap"] = r.lap()
        self._session = s
        if focused != self._focused_car:
            # Focus changed (driver swap, spectating) -> restart yaw differentiation.
            self._prev_yaw = self._prev_yaw_t = None
        self._focused_car = focused

    def _on_entry_list_car(self, r: _Reader) -> None:
        car_index = r.u16()
        model_id = r.u8()
        team = r.string()
        race_number = r.i32()
        r.u8()   # cup category
        current_driver = r.i32()
        r.u16()  # nationality
        drivers = []
        for _ in range(r.u8()):
            first = r.string()
            last = r.string()
            r.string()  # short name
            r.u8()      # category
            r.u16()     # nationality
            drivers.append(f"{first} {last}".strip())
        driver = drivers[current_driver] if 0 <= current_driver < len(drivers) else (
            drivers[0] if drivers else "")
        self._cars[car_index] = {
            "model": CAR_MODELS.get(model_id, f"ACC Car #{model_id}"),
            "modelId": model_id,
            "team": team,
            "raceNumber": race_number,
            "driver": driver,
        }

    def _on_car_update(self, r: _Reader):
        self._car_update_times.append(time.monotonic())
        car_index = r.u16()

        if car_index not in self._cars:
            # Unknown car -> our entry list is stale; ask for a fresh one (rate limited).
            now = time.monotonic()
            if now - self._last_entry_request > 2.0:
                self._last_entry_request = now
                self._request(_REQUEST_ENTRY_LIST)

        # A full grid sends one of these per car per tick, and only the driven
        # car is streamed -- bail before decoding the three lap structs.
        if self._focused_car is None or car_index != self._focused_car:
            return None

        r.u16()  # driver index
        r.u8()   # driver count
        gear = r.u8() + _GEAR_OFFSET
        world_x = r.f32()
        world_y = r.f32()
        yaw = r.f32()
        car_location = r.u8()
        kmh = r.u16()
        position = r.u16()
        r.u16()  # cup position
        r.u16()  # track position
        spline = r.f32()
        laps = r.u16()
        delta = r.i32()
        best_lap = r.lap()
        last_lap = r.lap()
        current_lap = r.lap()

        now = time.monotonic()
        if self._t0 is None:
            self._t0 = now
        t = now - self._t0

        # Yaw rate by differentiating heading (shortest-way-round across ±pi).
        yaw_rate = 0.0
        if self._prev_yaw is not None and self._prev_yaw_t is not None:
            dt = t - self._prev_yaw_t
            if dt > 1e-4:
                d = math.atan2(math.sin(yaw - self._prev_yaw), math.cos(yaw - self._prev_yaw))
                yaw_rate = _YAW_SIGN * math.degrees(d) / dt
        self._prev_yaw, self._prev_yaw_t = yaw, t

        lat, lon = world_to_latlon(world_x, world_y)
        track_len = self._track.get("meters") or 0
        car = self._cars.get(car_index) or {}

        values = {
            "Ground Speed": float(kmh),
            "Gear": float(gear),
            "GPS Latitude": lat,
            "GPS Longitude": lon,
            "Lap Dist": float(spline) * track_len,
            "Yaw Rate": yaw_rate,
            "In Pits": 0.0 if car_location == _LOC_TRACK else 1.0,
        }
        meta = {
            "game": "ACC",
            "track": self._track.get("name") or "",
            "trackLength": track_len,
            "car": car.get("model") or "",
            "driver": car.get("driver") or "",
            "lap": laps,
            "spline": float(spline),
            "position": position,
            "delta": delta,
            "lapTimeMs": current_lap.get("timeMs"),
            "lastLapMs": last_lap.get("timeMs"),
            "bestLapMs": best_lap.get("timeMs"),
            "lapInvalid": bool(current_lap.get("isInvalid")),
            "inPits": car_location != _LOC_TRACK,
            "sessionType": self._session.get("sessionType") or "",
            "phase": self._session.get("phase") or "",
            "status": self._status(),
        }
        return LiveFrame(t=t, values=values, meta=meta)

    def _status(self) -> str:
        """LIVE / PAUSE / REPLAY / OFF -- mirrors the shared-memory status field."""
        if not self._registered:
            return "OFF"
        if self._session.get("isReplay"):
            return "REPLAY"
        phase = self._session.get("phase") or "NONE"
        if phase in ("SESSION", "FORMATION_LAP", "PRE_SESSION", "STARTING", "PRE_FORMATION"):
            return "LIVE"
        return "PAUSE"
