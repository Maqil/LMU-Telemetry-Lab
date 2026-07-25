"""Shared types for live telemetry sources.

A source is a *pull* interface: the reader thread calls ``read()`` in a loop and
gets back zero or more frames. Sources never block longer than the timeout they
are given, and they are responsible for their own (re)connection -- a source
whose game isn't running simply returns no frames and reports ``connected=False``
so the UI can show "Waiting for ACC…" instead of an error.
"""
from dataclasses import dataclass, field
from math import cos, radians

# The app's map pipeline works in DEGREES (the 3D renderer converts deg->m with a
# fixed factor), so live world coordinates are placed on the same neutral base
# acc_importer.reconstruct_gps uses. Keeping the constants identical means a live
# lap and an imported lap of the same track land in the same coordinate frame.
DEG_M = 111320.0
LAT0, LON0 = 45.0, 9.0
_LON_SCALE = DEG_M * cos(radians(LAT0))


def world_to_latlon(x: float, y: float) -> tuple:
    """Game world metres (x east, y north) -> (latitude, longitude) degrees."""
    return LAT0 + y / DEG_M, LON0 + x / _LON_SCALE


@dataclass
class LiveFrame:
    """One sample, already mapped to the app's channel names.

    ``t`` is seconds since the source connected (monotonic, not wall clock).
    ``values`` holds a subset of the source's declared ``channels``; ``meta``
    carries the slow-moving context (track, car, lap, session status).
    """
    t: float
    values: dict = field(default_factory=dict)
    meta: dict = field(default_factory=dict)


class LiveSource:
    """Base class -- subclasses implement open/read/close."""

    #: short identifier persisted in the live config ("acc_udp", "mock", ...)
    kind = "base"

    #: ordered channel names this source can emit; the wire format sends rows in
    #: this order, so it must stay stable for the lifetime of a connection.
    channels: list = []

    def open(self) -> None:
        raise NotImplementedError

    def read(self, timeout: float = 0.25) -> list:
        """Return frames received within ``timeout`` seconds (possibly empty)."""
        raise NotImplementedError

    def close(self) -> None:
        pass

    def info(self) -> dict:
        """Source-specific status detail merged into ``/live/status``."""
        return {"connected": False}
