"""
Import Le Mans Ultimate MoTeC exports (.ld + optional .ldx) into the LMU
DuckDB schema this backend reads.

Unlike ACC's MoTeC export (short SI-ish channel names like ``SPEED`` /
``STEERANGLE`` that acc_importer remaps), LMU's ``.ld`` already names its
channels exactly like the native LMU DuckDB tables (``Ground Speed``,
``Throttle Pos``, ``Engine RPM``, ``GPS Latitude`` ...). So this importer maps
LMU channels straight onto that schema, one table per channel, plus the
``metadata`` key/value table -- producing a file indistinguishable from a
native LMU ``.duckdb`` for the rest of the pipeline.

Two LMU-specific quirks are handled here:

  * Lap boundaries. LMU's ``.ldx`` carries only a summary (no MoTeC beacons),
    so laps are derived from the ``Lap Number`` channel: each integer increment
    is a start/finish crossing. Only fully-bounded interior laps get a
    ``Lap Time`` (and thus count as valid), matching the native convention.
  * Discrete channels (``Gear``, ``Lap Number``, ...) are resampled
    nearest-previous so their integer/step values stay intact; continuous
    channels are linearly interpolated onto a uniform time grid.

Public API mirrors acc_importer:
  looks_like_lmu_ld(path)            -> bool   (channel-name sniff)
  convert_lmu_ld_to_duckdb(src, ...) -> output .duckdb path
"""
import logging
import os

import duckdb
import numpy as np
import pandas as pd

from . import motec_ld
from .acc_importer import _dominant_duration

logger = logging.getLogger(__name__)

# Bump when the conversion output changes so the sync agent re-imports files.
LMU_IMPORTER_VERSION = 1

# LMU .ld channel -> native LMU DuckDB table (single `value` column). Names that
# already match are listed explicitly for clarity and to bound what we emit.
CONTINUOUS_MAP = {
    "Ground Speed":            "Ground Speed",          # km/h
    "Throttle Pos":            "Throttle Pos",          # %
    "Brake Pos":               "Brake Pos",             # %
    "Clutch Pos":              "Clutch Pos",            # %
    "Engine RPM":              "Engine RPM",            # rpm
    "G Force Lat":             "G Force Lat",           # G
    "G Force Long":            "G Force Long",          # G
    "G Force Vert":            "G Force Vert",          # G
    "GPS Latitude":            "GPS Latitude",          # deg
    "GPS Longitude":           "GPS Longitude",         # deg
    "Fuel Level":              "Fuel Level",            # l
    "Steering Shaft Torque":   "Steering Shaft Torque", # N.m
    "FFB Output":              "FFB Output",            # %
    "Eng Water Temp":          "Engine Water Temp",     # C
    "Eng Oil Temp":            "Engine Oil Temp",       # C
    "Ambient Temperature":     "Ambient Temperature",   # C
    "Track Temperature":       "Track Temperature",     # C
    "Turbo Boost Pressure":    "Turbo Boost Pressure",
    "Clutch RPM":              "Clutch RPM",
    "Front Ride Height":       "FrontRideHeight",       # mm
    "Rear Ride Height":        "RearRideHeight",        # mm
    "Track Edge":              "Track Edge",
    "Path Lateral":            "Path Lateral",
}

# 4-wheel groups (FL, FR, RL, RR) -> native quad table with value1..value4.
WHEEL_MAP = {
    "Susp Pos":        ("Susp Pos FL", "Susp Pos FR", "Susp Pos RL", "Susp Pos RR"),
    "TyresPressure":   ("Tyre Pressure FL", "Tyre Pressure FR", "Tyre Pressure RL", "Tyre Pressure RR"),
    "Wheel Speed":     ("Wheel Rot Speed FL", "Wheel Rot Speed FR", "Wheel Rot Speed RL", "Wheel Rot Speed RR"),
    "Brakes Temp":     ("Brake Temp FL", "Brake Temp FR", "Brake Temp RL", "Brake Temp RR"),
    "RideHeights":     ("Ride Height FL", "Ride Height FR", "Ride Height RL", "Ride Height RR"),
    "Tyres Wear":      ("Tyre Wear FL", "Tyre Wear FR", "Tyre Wear RL", "Tyre Wear RR"),
    "TyresTempCentre": ("Tyre Temp FL Centre", "Tyre Temp FR Centre", "Tyre Temp RL Centre", "Tyre Temp RR Centre"),
    "TyresTempLeft":   ("Tyre Temp FL Inner", "Tyre Temp FR Inner", "Tyre Temp RL Inner", "Tyre Temp RR Inner"),
    "TyresTempRight":  ("Tyre Temp FL Outer", "Tyre Temp FR Outer", "Tyre Temp RL Outer", "Tyre Temp RR Outer"),
}

# Channels resampled nearest-previous (step) so integer/enum values stay intact.
_DISCRETE_CHANNELS = ("Gear", "Lap Number", "Current Sector", "In Pits", "Beacon",
                      "TC", "ABS")

# Class tokens, longest-first so "LMGT3" wins over "GT3".
_CLASS_KEYWORDS = ("HYPERCAR", "LMGT3", "LMDH", "LMP2", "LMP1", "LMH", "GTE", "GT3", "GT4")


def _parse_car(vehicle_id: str, vehicle_entry: str, header_vehicle: str):
    """Best-effort (car_name, car_class) from LMU's vehicle fields.

    LMU puts the class in ``vehicle_id`` ("GT3") and the entry/team in
    ``vehicle_entry`` ("Manthey DK Engineering 2026 #91:WEC"); ACC-style exports
    put the full model in ``vehicle_id``. Class is detected from any field.
    """
    vid = (vehicle_id or "").strip()
    entry = (vehicle_entry or "").strip()
    hv = (header_vehicle or "").strip()

    def detect_class(*sources):
        for s in sources:
            up = (s or "").upper()
            for k in _CLASS_KEYWORDS:
                if k in up:
                    return k
        return ""

    car_class = detect_class(vid, hv, entry) or (vid if vid else "Unknown")

    # Prefer a real model string over a bare class token; fall back to the entry.
    if hv and hv.upper() not in _CLASS_KEYWORDS:
        car_name = hv
    elif vid and vid.upper() not in _CLASS_KEYWORDS:
        car_name = vid
    elif entry:
        car_name = entry
    else:
        car_name = "Unknown"

    return car_name, car_class

# Channel-name fingerprint used to tell an LMU .ld from an ACC one.
_LMU_MARKERS = ("Ground Speed", "Throttle Pos", "Engine RPM")
_ACC_MARKERS = ("SPEED", "THROTTLE", "RPMS")


def _channel_names(path: str) -> list:
    try:
        _head, channs = motec_ld.read_ldfile(path)
        return [c.name for c in channs if c.name]
    except Exception as e:
        logger.warning("Could not read channel names from %s: %s", path, e)
        return []


def looks_like_lmu_ld(path: str) -> bool:
    """True if the .ld's channel names match LMU's native naming (not ACC's)."""
    names = set(_channel_names(path))
    if not names:
        return False
    if any(m in names for m in _ACC_MARKERS):
        return False
    return sum(1 for m in _LMU_MARKERS if m in names) >= 2


def load_lmu_ld(path: str):
    """Return (meta, channels) from an LMU MoTeC .ld.

    All channels are resampled onto one uniform time grid (highest channel
    frequency, dominant-duration span) so they align 1:1 with GPS Time.
    Discrete channels use nearest-previous resampling.
    """
    head, channs = motec_ld.read_ldfile(path)

    raw = {}
    for c in channs:
        if not c.name or not c.freq:
            continue
        try:
            data = np.asarray(c.data, dtype=float)
        except Exception as e:
            logger.debug("Skipping LMU .ld channel %s: %s", c.name, e)
            continue
        if data.size:
            raw[c.name] = (float(c.freq), data)

    if not raw:
        raise ValueError("No readable channels found in LMU .ld file.")

    ref_freq = max(freq for freq, _ in raw.values())
    duration = _dominant_duration([len(data) / freq for freq, data in raw.values()])
    n = int(round(duration * ref_freq)) + 1
    time = np.arange(n, dtype=float) / ref_freq

    channels = {"Time": time}
    for name, (freq, data) in raw.items():
        src_t = np.arange(len(data), dtype=float) / freq
        if name in _DISCRETE_CHANNELS:
            idx = np.clip(np.searchsorted(src_t, time, side="right") - 1, 0, len(data) - 1)
            channels[name] = data[idx]
        else:
            channels[name] = np.interp(time, src_t, data)

    # Venue/vehicle/driver from the richer event metadata, falling back to header.
    venue = ""
    vehicle_id = ""       # offset-0 field: class ("GT3") on LMU, car model on ACC
    vehicle_entry = ""    # offset-64 field: full entry/team name on LMU
    if head.event and head.event.venue and head.event.venue.name:
        venue = head.event.venue.name
    venue = venue or (head.venue or "")
    if head.event and head.event.venue and head.event.venue.vehicle:
        vehicle_id = head.event.venue.vehicle.id or ""
        vehicle_entry = head.event.venue.vehicle.entry or ""

    meta = {
        "Venue": venue,
        "Vehicle": head.vehicleid or "",
        "VehicleId": vehicle_id,
        "VehicleEntry": vehicle_entry,
        "Driver": head.driver or "",
    }
    if head.datetime:
        meta["Log Date"] = head.datetime.strftime("%Y-%m-%d")
        meta["Log Time"] = head.datetime.strftime("%H:%M:%S")
    return meta, channels


def _lap_boundaries(time: np.ndarray, lap_number: np.ndarray):
    """Derive lap starts and completed-lap times from the Lap Number channel.

    Returns (boundaries, completed) where ``boundaries`` are lap-start times
    (recording start + every integer increment) and ``completed`` is a list of
    (end_time, duration) for fully-bounded interior laps only -- the leading and
    trailing partial laps have no official time.
    """
    ln = np.floor(np.nan_to_num(lap_number)).astype(np.int64)
    inc_idx = np.where(np.diff(ln) > 0)[0] + 1
    inc_times = [float(time[i]) for i in inc_idx]

    boundaries = sorted({float(time[0]), *inc_times})

    # Each pair of consecutive increments bounds one complete lap.
    completed = [
        (inc_times[i + 1], inc_times[i + 1] - inc_times[i])
        for i in range(len(inc_times) - 1)
    ]
    return boundaries, completed


def _build_tables(meta, ch, source: str = "manual", source_path: str = None,
                  driver_override: str = None, is_pro: bool = False):
    """Reshape LMU channels (dict name->array) into native DuckDB DataFrames."""
    if "Time" not in ch:
        raise ValueError("No Time channel found in LMU input.")
    time = np.asarray(ch["Time"], float)
    n = len(time)
    if n == 0:
        raise ValueError("LMU input contains no samples.")

    tables = {"GPS Time": pd.DataFrame({"value": time.astype(float)})}

    for src, dst in CONTINUOUS_MAP.items():
        if src in ch:
            tables[dst] = pd.DataFrame({"value": np.nan_to_num(ch[src]).astype(float)})

    # Steering: prefer the wheel-position (deg) channel, but some LMU exports
    # log it as a flat zero -- fall back to the Steering (%) input when so.
    swp = ch.get("Steering Wheel Position")
    steer = swp if (swp is not None and np.nanstd(swp) > 1e-6) else ch.get("Steering")
    if steer is not None:
        tables["Steering Pos"] = pd.DataFrame({"value": np.nan_to_num(steer).astype(float)})

    for dst, quad in WHEEL_MAP.items():
        if all(c in ch for c in quad):
            tables[dst] = pd.DataFrame({
                f"value{i+1}": np.nan_to_num(ch[quad[i]]).astype(float) for i in range(4)
            })

    # Gear as change-points (ts, value), matching the native stepped encoding.
    if "Gear" in ch:
        g = np.rint(np.nan_to_num(ch["Gear"])).astype(int)
        idx = np.concatenate(([0], np.where(np.diff(g) != 0)[0] + 1))
        tables["Gear"] = pd.DataFrame({"ts": time[idx].astype(float), "value": g[idx].astype("int64")})

    # TC / ABS activation as change-points, when the export includes them. (Not
    # every LMU MoTeC export logs these -- e.g. some GT3 session exports omit
    # them entirely; when absent, the native tables are simply not created.)
    for src in ("TC", "ABS"):
        if src in ch:
            v = np.rint(np.nan_to_num(ch[src])).astype(int)
            idx = np.concatenate(([0], np.where(np.diff(v) != 0)[0] + 1))
            tables[src] = pd.DataFrame({"ts": time[idx].astype(float), "value": v[idx].astype("int64")})

    # Lap boundaries from the Lap Number channel.
    start_t, end_t = float(time[0]), float(time[-1])
    if "Lap Number" in ch:
        boundaries, completed = _lap_boundaries(time, ch["Lap Number"])
    else:
        boundaries, completed = [start_t], []

    tables["Lap"] = pd.DataFrame({
        "ts": boundaries,
        "value": list(range(len(boundaries))),
    }).astype({"ts": "float64", "value": "int64"})

    if completed:
        lt_ts = [t for t, _ in completed]
        lt_val = [d for _, d in completed]
    else:
        # No fully-bounded lap (e.g. a single hotlap export): treat the whole
        # recording as one lap so it still shows a time.
        lt_ts, lt_val = [end_t], [end_t - start_t]
    tables["Lap Time"] = pd.DataFrame({"ts": lt_ts, "value": lt_val}).astype(
        {"ts": "float64", "value": "float64"})

    venue = (meta.get("Venue") or "").strip() or "Unknown Track"
    car_name, car_class = _parse_car(
        meta.get("VehicleId"), meta.get("VehicleEntry"), meta.get("Vehicle"))

    md = {
        "TrackName": venue,
        "TrackLayout": "",
        "CarName": car_name,
        "CarClass": car_class,
        "DriverName": (driver_override or "").strip() or (meta.get("Driver") or "").strip() or "LMU Driver",
        "SessionTime": f"{meta.get('Log Date','')} {meta.get('Log Time','')}".strip(),
        "SessionType": "LMU Import",
        "WeatherConditions": "Unknown",
        "Game": "LMU",
        "Source": source if source in ("sync", "manual") else "manual",
    }
    if is_pro:
        md["IsProReference"] = "1"
    if source_path:
        md["SourcePath"] = source_path
    tables["metadata"] = pd.DataFrame({"key": list(md), "value": list(md.values())})

    return tables, dict(samples=n, duration=end_t - start_t, track=venue,
                        car=car_name, car_class=car_class, laps=len(boundaries))


def convert_lmu_ld_to_duckdb(src_path: str, output_dir: str = None, output_path: str = None,
                             source: str = "manual", source_path: str = None,
                             driver_override: str = None, is_pro: bool = False) -> str:
    """Convert an LMU MoTeC .ld into a native-schema DuckDB file. Returns its path."""
    if not os.path.exists(src_path):
        raise FileNotFoundError(src_path)

    meta, ch = load_lmu_ld(src_path)
    tables, info = _build_tables(meta, ch, source=source, source_path=source_path,
                                 driver_override=driver_override, is_pro=is_pro)

    if output_path is None:
        stem = os.path.splitext(os.path.basename(src_path))[0]
        base_dir = output_dir or os.path.dirname(src_path) or "."
        output_path = os.path.join(base_dir, stem + ".duckdb")

    if os.path.exists(output_path):
        os.remove(output_path)
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    con = duckdb.connect(output_path)
    try:
        for name, df in tables.items():
            con.register("df", df)
            con.execute(f'CREATE TABLE "{name}" AS SELECT * FROM df')
            con.unregister("df")
        con.execute("CHECKPOINT")
    finally:
        con.close()

    logger.info("Converted LMU export %s -> %s (%d samples, %.1fs, %d laps, %s)",
                os.path.basename(src_path), os.path.basename(output_path),
                info["samples"], info["duration"], info["laps"], info["car_class"])
    return output_path
