"""Per-session lap-video associations.

Stores a small sidecar (``video_associations.json``) in a profile's data dir that
maps a session id to a locally-picked video file plus per-lap sync offsets. The
video file itself is NOT copied (they are large); we keep the absolute path and
stream it on demand. Offset semantics: the video timestamp (seconds) that lines
up with lap start, i.e. ``video.currentTime = offset + playbackElapsed``.

Sidecar shape:
    { "<session_id>": { "videoPath": "/abs/spa.mp4",
                        "filename": "spa.mp4",
                        "perLapOffsets": { "<lapNumber>": 12.4 } } }
"""
import json
import logging
import os
import threading

logger = logging.getLogger(__name__)

_SIDECAR_NAME = "video_associations.json"
_lock = threading.Lock()


def _sidecar_path(data_dir: str) -> str:
    return os.path.join(data_dir, _SIDECAR_NAME)


def _load(data_dir: str) -> dict:
    path = _sidecar_path(data_dir)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception as e:
        logger.warning("Could not read %s: %s", path, e)
        return {}


def _save(data_dir: str, data: dict) -> None:
    os.makedirs(data_dir, exist_ok=True)
    with open(_sidecar_path(data_dir), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def get_association(data_dir: str, session_id: str):
    """Return the association dict for a session (with an `exists` flag), or None."""
    entry = _load(data_dir).get(session_id)
    if not entry:
        return None
    entry = dict(entry)
    entry["exists"] = bool(entry.get("videoPath") and os.path.isfile(entry["videoPath"]))
    entry.setdefault("perLapOffsets", {})
    return entry


def set_video(data_dir: str, session_id: str, video_path: str) -> dict:
    with _lock:
        data = _load(data_dir)
        entry = data.get(session_id) or {}
        entry["videoPath"] = video_path
        entry["filename"] = os.path.basename(video_path)
        entry.setdefault("perLapOffsets", {})
        data[session_id] = entry
        _save(data_dir, data)
    return get_association(data_dir, session_id)


def set_offset(data_dir: str, session_id: str, lap: int, offset: float) -> dict:
    with _lock:
        data = _load(data_dir)
        entry = data.get(session_id) or {"videoPath": None, "filename": None, "perLapOffsets": {}}
        entry.setdefault("perLapOffsets", {})[str(lap)] = float(offset)
        data[session_id] = entry
        _save(data_dir, data)
    return get_association(data_dir, session_id)


def remove(data_dir: str, session_id: str) -> None:
    with _lock:
        data = _load(data_dir)
        if session_id in data:
            del data[session_id]
            _save(data_dir, data)
