"""
Le Mans Ultimate game-directory sync (detection + on-demand import).

Le Mans Ultimate (Steam app 2399420) writes native telemetry straight to
``.../Le Mans Ultimate/UserData/Telemetry`` as ``.duckdb`` files -- the SAME
schema this backend already reads. Those are COPIED new/changed into the
profile's library, stamping ``Source="sync"`` in their metadata.

LMU can ALSO export MoTeC logs (``.ld`` binary + ``.ldx`` lap-index sidecar),
so this sync additionally converts any ``.ld`` files in the watched folder via
acc_importer (the MoTeC reshape pipeline is sim-agnostic), stamping
``Game="LMU"``. The ``.ldx`` sidecar supplies lap boundaries so a multi-lap
stint splits into individual laps.

This module is intentionally standalone and independent of the ACC sync
service: it keeps its own ``lmu_sync_state.json`` and never touches ACC state.

On-demand only -- callers trigger ``scan``.
"""
import json
import logging
import os
import re
import shutil
import threading
import time
from typing import Optional

import duckdb

from .acc_importer import convert_to_duckdb
from .lmu_importer import LMU_IMPORTER_VERSION

logger = logging.getLogger(__name__)

LMU_APP_ID = "2399420"
# UserData/Telemetry lives inside the game's own install dir (both Linux/Proton
# and Windows), not a Proton "Documents" prefix.
_TELEMETRY_SUFFIX = os.path.join(
    "steamapps", "common", "Le Mans Ultimate", "UserData", "Telemetry",
)
# LMU flushes the .duckdb after the session ends; skip files still being written.
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
    # Parse libraryfolders.vdf for LMU installed on a second drive.
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
        cands.append(os.path.join(base, _TELEMETRY_SUFFIX))
    return cands


def detect_folder() -> Optional[str]:
    """Return the first existing LMU UserData/Telemetry folder, or None."""
    for c in _candidate_dirs():
        if os.path.isdir(c):
            logger.info("LMU Telemetry folder auto-detected: %s", c)
            return c
    return None


# --------------------------------------------------------------------------
# Per-profile state (lmu_sync_state.json)
# --------------------------------------------------------------------------

def _state_path(data_dir: str) -> str:
    # data_dir is .../Data/{profile}/DuckDB_data ; state lives one level up.
    return os.path.join(os.path.dirname(data_dir), "lmu_sync_state.json")


def _default_state() -> dict:
    return {
        "lmu": {
            "enabled": False,
            "folder": None,
            "autoDetected": False,
            "lastScanAt": None,
            "lastResult": None,
            "imported": {},     # abs src path -> {mtime, size, sessionId, importedAt}
            "tombstoned": [],   # source paths the user deleted; don't re-import
        }
    }


def _load_state(data_dir: str) -> dict:
    path = _state_path(data_dir)
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                state = json.load(fh)
            state.setdefault("lmu", _default_state()["lmu"])
            for k, v in _default_state()["lmu"].items():
                state["lmu"].setdefault(k, v)
            return state
        except Exception as e:
            logger.warning("Corrupt lmu_sync_state.json (%s); resetting: %s", path, e)
    return _default_state()


def _save_state(data_dir: str, state: dict) -> None:
    path = _state_path(data_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, path)


def _compute_status(lmu: dict) -> str:
    folder = lmu.get("folder")
    if not folder:
        return "unconfigured"
    if not os.path.isdir(folder):
        return "folder-not-found"
    if not lmu.get("enabled"):
        return "paused"
    if (lmu.get("lastResult") or {}).get("errors"):
        return "error"
    return "active"


def _public_view(lmu: dict) -> dict:
    return {
        "enabled": bool(lmu.get("enabled")),
        "folder": lmu.get("folder"),
        "autoDetected": bool(lmu.get("autoDetected")),
        "status": _compute_status(lmu),
        "lastScanAt": lmu.get("lastScanAt"),
        "lastResult": lmu.get("lastResult"),
        "importedCount": len(lmu.get("imported", {})),
    }


# --------------------------------------------------------------------------
# Import helper
# --------------------------------------------------------------------------

def _import_file(src: str, data_dir: str) -> str:
    """Copy an LMU .duckdb into the library and stamp sync provenance.

    Returns the destination session filename. The file is copied to a temp
    name, provenance metadata is written, then it is atomically moved into
    place so a reader never sees a half-written session.
    """
    session_id = os.path.basename(src)
    dest = os.path.join(data_dir, session_id)
    tmp = dest + ".importing.tmp"

    shutil.copy2(src, tmp)
    try:
        con = duckdb.connect(tmp)
        try:
            # Native LMU files carry no provenance; stamp it so the library can
            # tell synced sessions from manual uploads. Replace any stale keys.
            con.execute(
                "DELETE FROM metadata WHERE key IN ('Source', 'SourcePath', 'Game')"
            )
            con.executemany(
                "INSERT INTO metadata (key, value) VALUES (?, ?)",
                [("Game", "LMU"), ("Source", "sync"), ("SourcePath", src)],
            )
            con.execute("CHECKPOINT")
        finally:
            con.close()
        os.replace(tmp, dest)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return session_id


def _import_ld(src: str, data_dir: str) -> str:
    """Convert an LMU MoTeC .ld export into the library, tagged Game=LMU.

    A sibling .ldx (read inside convert_to_duckdb) supplies lap-boundary beacons
    so a multi-lap stint splits into individual laps. Returns the session id.
    """
    out_path = convert_to_duckdb(
        src, output_dir=data_dir, source="sync", source_path=src, game="LMU"
    )
    return os.path.basename(out_path)


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def get_status(data_dir: str) -> dict:
    """Current sync state. Auto-detects and pre-fills the folder on first use."""
    state = _load_state(data_dir)
    lmu = state["lmu"]

    # "Set by default": if nothing configured yet, try to auto-detect and
    # persist the folder (but stay disabled until the user starts sync).
    if not lmu.get("folder"):
        found = detect_folder()
        if found:
            lmu["folder"] = found
            lmu["autoDetected"] = True
            _save_state(data_dir, state)

    return _public_view(lmu)


def detect(data_dir: str) -> dict:
    """Run detection and return the found path (does not change enabled)."""
    found = detect_folder()
    if found:
        state = _load_state(data_dir)
        state["lmu"]["folder"] = found
        state["lmu"]["autoDetected"] = True
        _save_state(data_dir, state)
    return {"path": found, "autoDetected": True if found else False}


def set_config(data_dir: str, folder: Optional[str] = None,
               enabled: Optional[bool] = None) -> dict:
    """Set the watched folder and/or enabled flag. Validates the folder."""
    state = _load_state(data_dir)
    lmu = state["lmu"]

    if folder is not None:
        folder = os.path.expanduser(folder.strip())
        if folder and not os.path.isdir(folder):
            raise ValueError(f"Folder does not exist: {folder}")
        lmu["folder"] = folder or None
        lmu["autoDetected"] = False

    if enabled is not None:
        lmu["enabled"] = bool(enabled)

    _save_state(data_dir, state)
    return _public_view(lmu)


def scan(data_dir: str, profile_id: str = "guest") -> dict:
    """Copy new/changed .duckdb files from the watched folder. Returns a result."""
    lock = _lock_for(profile_id)
    if not lock.acquire(blocking=False):
        return {"imported": 0, "skipped": 0, "errors": 0, "busy": True}

    try:
        state = _load_state(data_dir)
        lmu = state["lmu"]
        folder = lmu.get("folder")

        if not folder or not os.path.isdir(folder):
            lmu["lastResult"] = {"imported": 0, "skipped": 0, "errors": 0}
            lmu["lastScanAt"] = time.time()
            _save_state(data_dir, state)
            return {**lmu["lastResult"], "status": _compute_status(lmu)}

        ledger: dict = lmu.setdefault("imported", {})
        tombstoned = set(lmu.get("tombstoned", []))
        now = time.time()
        imported = skipped = errors = 0

        os.makedirs(data_dir, exist_ok=True)

        # LMU writes one complete file per session (native .duckdb, or a MoTeC
        # .ld export); the filename embeds a unique time, so a plain filename +
        # mtime + size check is enough to dedup (no ACC-style content
        # fingerprinting needed). The .ldx sidecar is consumed with its .ld.
        for name in sorted(os.listdir(folder)):
            lower = name.lower()
            if lower.endswith(".ldx"):
                continue  # lap-index sidecar, read alongside its .ld
            is_ld = lower.endswith(".ld")
            if not (lower.endswith(".duckdb") or is_ld):
                continue
            src = os.path.join(folder, name)
            try:
                st = os.stat(src)
            except OSError:
                continue

            # Still being written by the game -> catch it on the next scan.
            if now - st.st_mtime < STABLE_SECONDS:
                skipped += 1
                continue

            # The user explicitly deleted a synced session -> don't re-import it.
            if src in tombstoned:
                skipped += 1
                continue

            # Skip only if unchanged AND the produced .duckdb still exists. If
            # the output was deleted, the ledger is stale -> re-import so
            # "delete then sync" repopulates it. For converted .ld files, a newer
            # IMPORTER_VERSION also forces a re-import in place.
            prev = ledger.get(src)
            prev_out = os.path.join(data_dir, prev["sessionId"]) if prev and prev.get("sessionId") else None
            unchanged = bool(prev and prev.get("mtime") == st.st_mtime
                             and prev.get("size") == st.st_size
                             and prev_out and os.path.isfile(prev_out))
            if is_ld:
                unchanged = unchanged and prev.get("converterVersion") == LMU_IMPORTER_VERSION
            if unchanged:
                skipped += 1
                continue

            try:
                session_id = _import_ld(src, data_dir) if is_ld else _import_file(src, data_dir)
                entry = {
                    "mtime": st.st_mtime,
                    "size": st.st_size,
                    "sessionId": session_id,
                    "importedAt": now,
                }
                if is_ld:
                    entry["converterVersion"] = LMU_IMPORTER_VERSION
                ledger[src] = entry
                imported += 1
            except Exception as e:
                logger.error("LMU sync import failed for %s: %s", src, e)
                errors += 1

        lmu["lastResult"] = {"imported": imported, "skipped": skipped, "errors": errors}
        lmu["lastScanAt"] = now
        _save_state(data_dir, state)
        logger.info("LMU sync scan (%s): imported=%d skipped=%d errors=%d",
                    profile_id, imported, skipped, errors)
        return {**lmu["lastResult"], "status": _compute_status(lmu)}
    finally:
        lock.release()
