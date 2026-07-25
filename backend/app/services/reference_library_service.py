"""
Seed and manage the shared "pro reference lap" library.

A curated set of MoTeC (.ld) laps ships with the app (currently Fri3d0lf's ACC
laps under ``fri3d0lf-Telemetry/``). On startup these are converted into the
same DuckDB schema everything else uses and stored in a single profile-agnostic
library directory. The reference-lap browser then surfaces them as default
comparison suggestions for every profile, on every matching track + car class.

Seeding is idempotent: a version stamp is written next to the converted files,
and re-conversion only happens when the source set or importer output changes.
"""
import glob
import json
import logging
import os
import sys

from .acc_importer import IMPORTER_VERSION, convert_to_duckdb
from .profiles_service import ProfilesService

logger = logging.getLogger("reference_library_service")

# Driver attribution for the bundled laps.
PRO_DRIVER = "Fri3d0lf"

# Folder (relative to the app root) holding the curated .ld source files.
_SOURCE_FOLDER_NAME = "fri3d0lf-Telemetry"

# Bump when the seeding logic itself changes (independent of IMPORTER_VERSION).
_SEED_VERSION = 1

_STAMP_FILE = ".seed_stamp.json"


def _candidate_source_dirs() -> list:
    """Where the bundled .ld files might live in dev and frozen builds."""
    candidates = []
    # Frozen (PyInstaller): bundled data is unpacked under sys._MEIPASS.
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        candidates.append(os.path.join(sys._MEIPASS, _SOURCE_FOLDER_NAME))
        candidates.append(os.path.join(os.path.dirname(sys.executable), _SOURCE_FOLDER_NAME))
    # Dev: project root is four levels up from this file
    # (services -> app -> backend -> <root>).
    root = os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    )
    candidates.append(os.path.join(root, _SOURCE_FOLDER_NAME))
    return candidates


def _find_source_dir() -> str:
    for d in _candidate_source_dirs():
        if os.path.isdir(d) and glob.glob(os.path.join(d, "*.ld")):
            return d
    return ""


def _stamp_path() -> str:
    return os.path.join(ProfilesService.get_reference_library_dir(), _STAMP_FILE)


def _read_stamp() -> dict:
    try:
        with open(_stamp_path(), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def _write_stamp(source_files: list):
    stamp = {
        "seed_version": _SEED_VERSION,
        "importer_version": IMPORTER_VERSION,
        "sources": sorted(os.path.basename(f) for f in source_files),
    }
    try:
        with open(_stamp_path(), "w", encoding="utf-8") as fh:
            json.dump(stamp, fh, indent=2)
    except Exception as e:
        logger.warning("Could not write reference-library stamp: %s", e)


def seed_reference_library(force: bool = False) -> int:
    """Convert the bundled pro .ld laps into the shared reference library.

    Idempotent: only (re)converts when the seed/importer version or the source
    file set has changed (or ``force`` is set). Returns the number of files
    converted this run.
    """
    src_dir = _find_source_dir()
    if not src_dir:
        logger.info("No bundled pro reference laps found; skipping seed.")
        return 0

    source_files = sorted(glob.glob(os.path.join(src_dir, "*.ld")))
    if not source_files:
        return 0

    out_dir = ProfilesService.get_reference_library_dir()

    stamp = _read_stamp()
    up_to_date = (
        not force
        and stamp.get("seed_version") == _SEED_VERSION
        and stamp.get("importer_version") == IMPORTER_VERSION
        and stamp.get("sources") == sorted(os.path.basename(f) for f in source_files)
    )
    if up_to_date:
        logger.info("Pro reference library already up to date (%d laps).", len(source_files))
        return 0

    logger.info("Seeding pro reference library from %s (%d files)...", src_dir, len(source_files))
    converted = 0
    for src in source_files:
        stem = os.path.splitext(os.path.basename(src))[0]
        out_path = os.path.join(out_dir, stem + ".duckdb")
        try:
            convert_to_duckdb(
                src,
                output_path=out_path,
                source="sync",
                source_path=src,
                driver_override=PRO_DRIVER,
                is_pro=True,
            )
            converted += 1
        except Exception as e:
            logger.error("Failed to seed pro reference lap %s: %s", os.path.basename(src), e)

    _write_stamp(source_files)
    logger.info("Pro reference library seeded: %d/%d laps converted.", converted, len(source_files))
    return converted
