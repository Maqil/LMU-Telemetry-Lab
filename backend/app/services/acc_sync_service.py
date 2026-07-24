"""
ACC game-directory sync (Phase 2: detection + on-demand import).

Assetto Corsa Competizione (Steam app 805550) writes MoTeC telemetry to a
fixed folder inside its Proton prefix. This service:

  * auto-detects that folder across common Steam layouts (native / Flatpak /
    extra library drives) and the Windows-native path;
  * persists per-profile sync config + a dedup ledger in ``sync_state.json``;
  * scans the folder for ``.ld`` recordings and imports new/changed ones into
    the profile's DuckDB library via acc_importer (stamped source="sync").

Phase 2 is on-demand only -- callers trigger ``scan``. The background watcher
(Phase 3) will call the same ``scan`` on a timer.
"""
import json
import logging
import os
import re
import threading
import time
from typing import Optional

from .acc_importer import convert_to_duckdb, read_ldx_beacons, IMPORTER_VERSION

logger = logging.getLogger(__name__)

ACC_APP_ID = "805550"
# Windows "Documents" subpath inside the Proton prefix (or a native install).
_MOTEC_SUFFIX = os.path.join(
    "drive_c", "users", "steamuser", "Documents",
    "Assetto Corsa Competizione", "MoTeC",
)
# ACC exports the .ld last; skip files still being flushed by the game.
STABLE_SECONDS = 5

# Serialise scans per profile so a manual "Sync now" and (later) the timer
# can't double-import the same file.
_scan_locks: dict[str, threading.Lock] = {}


def _home() -> str:
    return os.path.expanduser("~")


def _lock_for(profile_id: str) -> threading.Lock:
    return _scan_locks.setdefault(profile_id or "guest", threading.Lock())


# --------------------------------------------------------------------------
# Folder detection
# --------------------------------------------------------------------------

def _steam_library_roots() -> list[str]:
    """Steam library roots, including extra drives from libraryfolders.vdf."""
    home = _home()
    roots = [
        os.path.join(home, ".steam", "steam"),
        os.path.join(home, ".local", "share", "Steam"),
        os.path.join(home, ".var", "app", "com.valvesoftware.Steam", "data", "Steam"),
    ]
    # Parse libraryfolders.vdf for ACC installed on a second drive.
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


def _candidate_dirs() -> list[str]:
    cands: list[str] = []
    for base in _steam_library_roots():
        cands.append(os.path.join(base, "steamapps", "compatdata", ACC_APP_ID, "pfx", _MOTEC_SUFFIX))
    # Windows-native ACC (no Proton prefix).
    cands.append(os.path.join(_home(), "Documents", "Assetto Corsa Competizione", "MoTeC"))
    return cands


def detect_folder() -> Optional[str]:
    """Return the first existing ACC MoTeC folder, or None."""
    for c in _candidate_dirs():
        if os.path.isdir(c):
            logger.info("ACC MoTeC folder auto-detected: %s", c)
            return c
    return None


# --------------------------------------------------------------------------
# Duplicate detection
# --------------------------------------------------------------------------
# ACC writes a NEW, complete MoTeC .ld every time telemetry is saved (returning
# to the garage, session end/restart, opening the setup screen), so one stint on
# track yields several overlapping/duplicate files -- and the trailing number in
# the filename is a rolling index, not a stable session id (identical content can
# appear under different numbers). We fingerprint each file by its lap beacons and
# import only the best copy per session.

def _name_track_car(name: str) -> tuple:
    """(track, car) parsed from an ACC filename '<track>-<car>-<N>-<date>-<time>.ld'."""
    stem = os.path.splitext(name)[0]
    parts = stem.split("-")
    if len(parts) >= 2:
        return parts[0].lower(), parts[1].lower()
    return stem.lower(), ""


def _fingerprint(src: str) -> tuple:
    """Content signature for grouping duplicate snapshots of the same session.

    Files with the same track/car and identical lap-beacon crossings are the
    same recording. Files with no completed lap (no beacons) are never merged
    (keyed by their own path) -- out-laps are rare and cheap, and merging them
    risks discarding distinct data.
    """
    track, car = _name_track_car(os.path.basename(src))
    beacons = tuple(round(b, 1) for b in read_ldx_beacons(src))
    if not beacons:
        return ("solo", src)
    return (track, car, beacons)


# --------------------------------------------------------------------------
# Per-profile state (sync_state.json)
# --------------------------------------------------------------------------

def _state_path(data_dir: str) -> str:
    # data_dir is .../Data/{profile}/DuckDB_data ; state lives one level up.
    return os.path.join(os.path.dirname(data_dir), "sync_state.json")


def _default_state() -> dict:
    return {
        "acc": {
            "enabled": False,
            "folder": None,
            "autoDetected": False,
            "lastScanAt": None,
            "lastResult": None,
            "imported": {},     # abs path -> {mtime, size, sessionId, importedAt}
            "tombstoned": [],   # source paths the user deleted; don't re-import
        }
    }


def _load_state(data_dir: str) -> dict:
    path = _state_path(data_dir)
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                state = json.load(fh)
            state.setdefault("acc", _default_state()["acc"])
            for k, v in _default_state()["acc"].items():
                state["acc"].setdefault(k, v)
            return state
        except Exception as e:
            logger.warning("Corrupt sync_state.json (%s); resetting: %s", path, e)
    return _default_state()


def _save_state(data_dir: str, state: dict) -> None:
    path = _state_path(data_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, path)


def _compute_status(acc: dict) -> str:
    folder = acc.get("folder")
    if not folder:
        return "unconfigured"
    if not os.path.isdir(folder):
        return "folder-not-found"
    if not acc.get("enabled"):
        return "paused"
    if (acc.get("lastResult") or {}).get("errors"):
        return "error"
    return "active"


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def get_status(data_dir: str) -> dict:
    """Current sync state. Auto-detects and pre-fills the folder on first use."""
    state = _load_state(data_dir)
    acc = state["acc"]

    # "Set by default": if nothing configured yet, try to auto-detect and
    # persist the folder (but stay disabled until the user starts sync).
    if not acc.get("folder"):
        found = detect_folder()
        if found:
            acc["folder"] = found
            acc["autoDetected"] = True
            _save_state(data_dir, state)

    return _public_view(acc)


def _public_view(acc: dict) -> dict:
    return {
        "enabled": bool(acc.get("enabled")),
        "folder": acc.get("folder"),
        "autoDetected": bool(acc.get("autoDetected")),
        "status": _compute_status(acc),
        "lastScanAt": acc.get("lastScanAt"),
        "lastResult": acc.get("lastResult"),
        "importedCount": len(acc.get("imported", {})),
    }


def detect(data_dir: str) -> dict:
    """Run detection and return the found path (does not change enabled)."""
    found = detect_folder()
    if found:
        state = _load_state(data_dir)
        state["acc"]["folder"] = found
        state["acc"]["autoDetected"] = True
        _save_state(data_dir, state)
    return {"path": found, "autoDetected": True if found else False}


def set_config(data_dir: str, folder: Optional[str] = None,
               enabled: Optional[bool] = None) -> dict:
    """Set the watched folder and/or enabled flag. Validates the folder."""
    state = _load_state(data_dir)
    acc = state["acc"]

    if folder is not None:
        folder = os.path.expanduser(folder.strip())
        if folder and not os.path.isdir(folder):
            raise ValueError(f"Folder does not exist: {folder}")
        acc["folder"] = folder or None
        acc["autoDetected"] = False

    if enabled is not None:
        acc["enabled"] = bool(enabled)

    _save_state(data_dir, state)
    return _public_view(acc)


def scan(data_dir: str, profile_id: str = "guest") -> dict:
    """Import new/changed .ld files from the watched folder. Returns a result."""
    lock = _lock_for(profile_id)
    if not lock.acquire(blocking=False):
        return {"imported": 0, "skipped": 0, "errors": 0, "busy": True}

    try:
        state = _load_state(data_dir)
        acc = state["acc"]
        folder = acc.get("folder")

        if not folder or not os.path.isdir(folder):
            acc["lastResult"] = {"imported": 0, "skipped": 0, "errors": 0}
            acc["lastScanAt"] = time.time()
            _save_state(data_dir, state)
            return {**acc["lastResult"], "status": _compute_status(acc)}

        ledger: dict = acc.setdefault("imported", {})
        tombstoned = set(acc.get("tombstoned", []))
        now = time.time()
        imported = skipped = errors = 0

        os.makedirs(data_dir, exist_ok=True)

        # --- Pass 1: group duplicate snapshots, keep the best copy per session ---
        # "Best" = the largest file (the most complete telemetry dump); ties
        # broken by most-recently written.
        by_sig: dict = {}
        for name in sorted(os.listdir(folder)):
            if not name.lower().endswith(".ld"):
                continue
            src = os.path.join(folder, name)
            try:
                st = os.stat(src)
            except OSError:
                continue
            by_sig.setdefault(_fingerprint(src), []).append((src, st))

        winners: dict = {}     # src -> stat, the copy we actually import
        superseded: set = set()  # duplicate copies we skip (and clean up)
        for copies in by_sig.values():
            copies.sort(key=lambda cs: (cs[1].st_size, cs[1].st_mtime))
            winner_src, winner_st = copies[-1]
            winners[winner_src] = winner_st
            for src, _ in copies[:-1]:
                superseded.add(src)

        # Remove any stale .duckdb previously imported from a now-superseded copy.
        for src in superseded:
            prev = ledger.pop(src, None)
            if prev and prev.get("sessionId"):
                stale = os.path.join(data_dir, prev["sessionId"])
                try:
                    if os.path.isfile(stale):
                        os.remove(stale)
                except OSError as e:
                    logger.warning("Could not remove superseded duplicate %s: %s", stale, e)

        skipped += len(superseded)  # duplicate snapshots collapsed into their winner

        # --- Pass 2: import the winners ---
        for src, st in winners.items():
            # Still being written by the game -> catch it on the next scan.
            if now - st.st_mtime < STABLE_SECONDS:
                skipped += 1
                continue

            # The user explicitly deleted a synced session -> don't re-import it.
            if src in tombstoned:
                skipped += 1
                continue

            # Skip only if unchanged, imported by the current converter, AND the
            # produced .duckdb still exists. If the output was deleted, the
            # ledger is stale -> re-import so "delete then sync" repopulates it.
            # A newer IMPORTER_VERSION also forces a re-import in place.
            prev = ledger.get(src)
            prev_out = os.path.join(data_dir, prev["sessionId"]) if prev and prev.get("sessionId") else None
            if (prev and prev.get("mtime") == st.st_mtime and prev.get("size") == st.st_size
                    and prev.get("converterVersion") == IMPORTER_VERSION
                    and prev_out and os.path.isfile(prev_out)):
                skipped += 1
                continue

            try:
                out_path = convert_to_duckdb(src, output_dir=data_dir, source="sync", source_path=src)
                ledger[src] = {
                    "mtime": st.st_mtime,
                    "size": st.st_size,
                    "sessionId": os.path.basename(out_path),
                    "importedAt": now,
                    "converterVersion": IMPORTER_VERSION,
                }
                imported += 1
            except Exception as e:
                logger.error("ACC sync import failed for %s: %s", src, e)
                errors += 1

        acc["lastResult"] = {"imported": imported, "skipped": skipped, "errors": errors}
        acc["lastScanAt"] = now
        _save_state(data_dir, state)
        logger.info("ACC sync scan (%s): imported=%d skipped=%d errors=%d",
                    profile_id, imported, skipped, errors)
        return {**acc["lastResult"], "status": _compute_status(acc)}
    finally:
        lock.release()
