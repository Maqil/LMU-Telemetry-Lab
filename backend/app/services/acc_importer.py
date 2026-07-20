"""
Import Assetto Corsa Competizione MoTeC exports into the LMU DuckDB schema.

The backend reads the LMU telemetry app's schema: ONE TABLE PER CHANNEL
(e.g. "GPS Time", "Ground Speed", "Gear") plus a key/value "metadata" table.
This module reshapes ACC's MoTeC channels into that exact schema so ACC laps
flow through the same backend/frontend pipeline as LMU laps.

Accepted input:
  * .csv  MoTeC CSV export (in MoTeC: File > Export > CSV)

Public API:
  IMPORT_EXTENSIONS         -> tuple of importable extensions
  is_convertible(filename)  -> bool
  convert_to_duckdb(src, output_dir=None, output_path=None) -> output .duckdb path
"""
import csv
import logging
import os
import re

import duckdb
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

IMPORT_EXTENSIONS = (".csv",)
G = 9.80665  # ACC exports G-forces in m/s^2; frontend wants G.

# ACC MoTeC channel -> LMU pipeline table name (single `value` column)
CONTINUOUS_MAP = {
    "SPEED":      "Ground Speed",   # km/h (pipeline auto-detects & /3.6)
    "THROTTLE":   "Throttle Pos",   # %
    "BRAKE":      "Brake Pos",      # %
    "STEERANGLE": "Steering Pos",   # deg -> becomes "Steering Angle"
    "RPMS":       "Engine RPM",     # rpm
    "ROTY":       "Yaw Rate",       # deg/s
    "Distance":   "Lap Dist",       # m
}
GFORCE_MAP = {"G_LAT": "G Force Lat", "G_LON": "G Force Long"}  # /G below

# 4-wheel groups (LF, RF, LR, RR) -> LMU table with value1..value4
WHEEL_MAP = {
    "TyresPressure": ("TYRE_PRESS_LF", "TYRE_PRESS_RF", "TYRE_PRESS_LR", "TYRE_PRESS_RR"),
    "TireHeat":      ("TYRE_TAIR_LF",  "TYRE_TAIR_RF",  "TYRE_TAIR_LR",  "TYRE_TAIR_RR"),
    "Susp Pos":      ("SUS_TRAVEL_LF", "SUS_TRAVEL_RF", "SUS_TRAVEL_LR", "SUS_TRAVEL_RR"),
    "Wheel Speed":   ("WHEEL_SPEED_LF","WHEEL_SPEED_RF","WHEEL_SPEED_LR","WHEEL_SPEED_RR"),
}
EVENT_PULSE_MAP = {"TC": "TC", "ABS": "ABS"}  # pipeline treats as pulse events


def is_convertible(filename: str) -> bool:
    return filename.lower().endswith(IMPORT_EXTENSIONS)


def load_motec_csv(path):
    """Return (meta_header, channels) from a MoTeC CSV export."""
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    meta = {}
    hi = None
    for i, ln in enumerate(lines):
        if ln.startswith('"Time"'):
            hi = i
            break
        cells = next(csv.reader([ln])) if ln.strip() else []
        if len(cells) >= 2 and cells[0]:
            meta[cells[0].strip()] = cells[1].strip()
    if hi is None:
        raise ValueError('Not a MoTeC CSV (no channel header row starting with "Time").')

    header = next(csv.reader([lines[hi]]))
    di = hi + 1
    while di < len(lines):
        first = next(csv.reader([lines[di]]))[:1]
        try:
            float(first[0]); break
        except (ValueError, IndexError):
            di += 1
    rows = [r for r in csv.reader(lines[di:]) if r and r[0].strip() not in ("", "..")]

    ncol = len(header)
    cols = {name: np.full(len(rows), np.nan) for name in header}
    for ri, r in enumerate(rows):
        for ci in range(min(ncol, len(r))):
            v = r[ci].strip()
            if v in ("", ".."):
                continue
            try:
                cols[header[ci]][ri] = float(v)
            except ValueError:
                pass
    return meta, cols


def reconstruct_gps(time, speed_kmh, yaw_deg_s):
    """Reconstruct a GPS-like track path from speed + yaw rate (ACC has no GPS).

    Returns (longitude, latitude) in DEGREES at an arbitrary but realistic base,
    so it scales identically to real LMU GPS in both the 2D and 3D maps (the 3D
    renderer converts degrees->metres via a fixed 111320 factor and cos-latitude
    scaling, so metre-based coordinates would blow the scene up).

    The heading is integrated directly from ACC's ROTY (yaw rate) so the path
    carries the SAME chirality as real GPS (Monza Turn 1 comes out as a
    right-hander). That lets ACC laps render correctly through the identical
    2D and 3D pipeline used for LMU -- no per-view mirror flips required.
    """
    t = np.asarray(time, float)
    dt = np.gradient(t)
    v = np.asarray(speed_kmh, float) / 3.6
    yaw = np.nan_to_num(np.asarray(yaw_deg_s, float)) * np.pi / 180.0
    heading = np.cumsum(yaw * dt)
    x_m = np.cumsum(v * np.cos(heading) * dt)  # local metres, east
    y_m = np.cumsum(v * np.sin(heading) * dt)  # local metres, north

    DEG_M = 111320.0            # metres per degree of latitude
    LAT0, LON0 = 45.0, 9.0     # neutral base (absolute position is irrelevant)
    lat = LAT0 + y_m / DEG_M
    lon = LON0 + x_m / (DEG_M * np.cos(np.radians(LAT0)))
    return lon, lat


def _build_tables(meta, ch):
    """Reshape ACC channels (dict name->array) into LMU per-channel DataFrames."""
    if "Time" not in ch:
        raise ValueError("No Time channel found in input.")
    time = np.asarray(ch["Time"], float)
    n = len(time)
    if n == 0:
        raise ValueError("Input contains no samples.")
    start_t, end_t = float(time[0]), float(time[-1])

    tables = {"GPS Time": pd.DataFrame({"value": time.astype(float)})}

    for src, dst in CONTINUOUS_MAP.items():
        if src in ch:
            tables[dst] = pd.DataFrame({"value": np.nan_to_num(ch[src]).astype(float)})
    for src, dst in GFORCE_MAP.items():
        if src in ch:
            tables[dst] = pd.DataFrame({"value": np.nan_to_num(ch[src]).astype(float) / G})

    for dst, quad in WHEEL_MAP.items():
        if all(c in ch for c in quad):
            tables[dst] = pd.DataFrame({
                f"value{i+1}": np.nan_to_num(ch[quad[i]]).astype(float) for i in range(4)
            })

    if "GEAR" in ch:
        g = np.nan_to_num(ch["GEAR"]).astype(float)
        idx = np.concatenate(([0], np.where(np.diff(g) != 0)[0] + 1))
        tables["Gear"] = pd.DataFrame({"ts": time[idx].astype(float), "value": g[idx]})

    for src, dst in EVENT_PULSE_MAP.items():
        if src in ch:
            v = np.nan_to_num(ch[src]).astype(float)
            idx = np.concatenate(([0], np.where(np.diff(v) != 0)[0] + 1))
            tables[dst] = pd.DataFrame({"ts": time[idx].astype(float), "value": v[idx]})

    if "SPEED" in ch and "ROTY" in ch:
        x, y = reconstruct_gps(time, ch["SPEED"], ch["ROTY"])
        tables["GPS Longitude"] = pd.DataFrame({"value": x.astype(float)})
        tables["GPS Latitude"] = pd.DataFrame({"value": y.astype(float)})

    tables["Lap"] = pd.DataFrame({"ts": [start_t], "value": [0]}).astype(
        {"ts": "float64", "value": "int64"})
    duration = end_t - start_t
    tables["Lap Time"] = pd.DataFrame({"ts": [end_t], "value": [duration]}).astype(
        {"ts": "float64", "value": "float64"})

    venue = (meta.get("Venue") or "").strip() or "Unknown Track"
    vehicle = (meta.get("Vehicle") or "").strip() or "Unknown Car"
    car_class = "GT3" if re.search(r"gt3", vehicle, re.I) else "GT"
    md = {
        "TrackName": venue,
        "TrackLayout": "",
        "CarName": vehicle,
        "CarClass": car_class,
        "DriverName": (meta.get("Driver") or "").strip() or "ACC Driver",
        "SessionTime": f"{meta.get('Log Date','')} {meta.get('Log Time','')}".strip(),
        "SessionType": "ACC Import",
        "WeatherConditions": "Unknown",
        "Game": "ACC",
    }
    tables["metadata"] = pd.DataFrame({"key": list(md), "value": list(md.values())})
    return tables, dict(samples=n, duration=duration, track=venue, car=vehicle, car_class=car_class)


def convert_to_duckdb(src_path: str, output_dir: str = None, output_path: str = None) -> str:
    """Convert an ACC MoTeC .ld/.csv into a DuckDB file. Returns the output path."""
    if not os.path.exists(src_path):
        raise FileNotFoundError(src_path)
    ext = os.path.splitext(src_path)[1].lower()
    if ext == ".csv":
        meta, ch = load_motec_csv(src_path)
    else:
        raise ValueError(f"Unsupported import type: {ext}")

    tables, info = _build_tables(meta, ch)

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

    logger.info("Converted ACC export %s -> %s (%s samples, %.1fs, %s)",
                os.path.basename(src_path), os.path.basename(output_path),
                info["samples"], info["duration"], info["car"])
    return output_path
