"""Mock live source -- drives a synthetic car so the live path can be built,
run and demoed without ACC (design §8, Phase 1).

It emits the same channels the ACC UDP source does, at the same rate, including
lap wraps, so the WebSocket, the store's live slice, the charts and the map can
all be exercised end-to-end with the game closed.
"""
import math
import time

from .base import LiveFrame, LiveSource, world_to_latlon


class MockLiveSource(LiveSource):
    kind = "mock"
    channels = list(("Ground Speed", "Gear", "GPS Latitude", "GPS Longitude",
                     "Lap Dist", "Yaw Rate", "In Pits"))

    #: a rounded-rectangle "circuit" roughly 3.2 km long
    RADIUS_X = 620.0
    RADIUS_Y = 340.0
    LAP_SECONDS = 92.0

    def __init__(self, hz: float = 60.0):
        self.hz = float(hz or 60.0)
        self._t0 = None
        self._next = 0.0
        self._lap = 0

    def open(self) -> None:
        self._t0 = time.monotonic()
        self._next = 0.0
        self._lap = 0

    def close(self) -> None:
        self._t0 = None

    def info(self) -> dict:
        return {"connected": self._t0 is not None, "track": "mock_circuit",
                "trackLength": int(self._track_length()), "car": "Mock GT3",
                "driver": "Mock Driver", "error": None}

    def _track_length(self) -> float:
        # Ramanujan's ellipse-perimeter approximation.
        a, b = self.RADIUS_X, self.RADIUS_Y
        h = ((a - b) ** 2) / ((a + b) ** 2)
        return math.pi * (a + b) * (1 + (3 * h) / (10 + math.sqrt(4 - 3 * h)))

    def read(self, timeout: float = 0.25) -> list:
        if self._t0 is None:
            return []
        # Pace the generator in real time so the client sees a true ~60 Hz stream.
        time.sleep(min(timeout, 1.0 / self.hz))
        frames = []
        now = time.monotonic() - self._t0
        step = 1.0 / self.hz
        while self._next <= now:
            frames.append(self._frame(self._next))
            self._next += step
        return frames

    def _frame(self, t: float) -> LiveFrame:
        length = self._track_length()
        phase = (t % self.LAP_SECONDS) / self.LAP_SECONDS
        lap = int(t // self.LAP_SECONDS)
        theta = phase * 2 * math.pi

        x = self.RADIUS_X * math.cos(theta)
        y = self.RADIUS_Y * math.sin(theta)
        lat, lon = world_to_latlon(x, y)

        # Speed follows curvature: fast down the "straights", slow in the corners.
        curviness = abs(math.cos(theta))
        speed = 110.0 + 175.0 * (1.0 - curviness)
        gear = max(1, min(6, int(speed // 45)))
        yaw_rate = 360.0 / self.LAP_SECONDS * (0.6 + 0.8 * curviness)

        return LiveFrame(
            t=t,
            values={
                "Ground Speed": speed,
                "Gear": float(gear),
                "GPS Latitude": lat,
                "GPS Longitude": lon,
                "Lap Dist": phase * length,
                "Yaw Rate": yaw_rate,
                "In Pits": 0.0,
            },
            meta={
                "game": "ACC", "track": "mock_circuit", "trackLength": int(length),
                "car": "Mock GT3", "driver": "Mock Driver", "lap": lap,
                "spline": phase, "position": 1, "delta": 0,
                "lapTimeMs": int((t % self.LAP_SECONDS) * 1000),
                "lastLapMs": int(self.LAP_SECONDS * 1000) if lap else None,
                "bestLapMs": int(self.LAP_SECONDS * 1000) if lap else None,
                "lapInvalid": False, "inPits": False,
                "sessionType": "Practice", "phase": "SESSION", "status": "LIVE",
            },
        )
