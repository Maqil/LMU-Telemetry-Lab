"""Read ACC's shared memory directly from Linux -- no bridge required.

ACC_REALTIME_TELEMETRY_DESIGN §2.3 assumed a native Linux process could not
reach ACC's Windows named shared memory under Proton, which is why the Tier A
plan was a Windows-side bridge. That turns out to be too pessimistic in
practice: Wine backs named mappings with anonymous `memfd` objects that stay
visible in the game process's address space, so they can be read through
``/proc/<pid>/mem`` from the same user.

Each of ACC's three blocks lands in its own page-sized shared mapping:

    1317b0000-1317b1000 rw-s ... /memfd:wine-mapping   <- acpmf_static
    1317c0000-1317c1000 rw-s ... /memfd:wine-mapping   <- acpmf_graphics
    131850000-131851000 rw-s ... /memfd:wine-mapping   <- acpmf_physics

Wine hashes the mapping names away, so the regions are identified by **content**
(see `_score_*`) rather than by name or by address order -- addresses and
ordering both change between launches.

This is the preferred transport on Linux. `tools/acc_bridge/` remains the
fallback for the cases this cannot cover: a hardened `ptrace_scope`, or the app
running on a different machine from the game.

The decoded sample has the exact shape the bridge sends over UDP, so
`acc_shm.py` maps both transports with one code path.
"""
import errno
import logging
import os
import re
import time

from .acc_shm_layout import (
    GRAPHICS_OFFSETS, GRAPHICS_SIZE, PHYSICS_OFFSETS, PHYSICS_SIZE,
    STATIC_OFFSETS, STATIC_SIZE, build_sample, read_field,
)

logger = logging.getLogger(__name__)

#: /proc/<pid>/comm is truncated to 15 characters.
ACC_COMM = "AC2-Win64-Shipp"

#: Wine's shared mappings for the ACC pages are exactly one page.
_REGION_SIZE = 4096
_MAPS_RE = re.compile(
    r"^([0-9a-f]+)-([0-9a-f]+)\s+rw-s\s+\S+\s+\S+\s+\S+\s+(/memfd:wine-mapping.*)$")


class DirectReadUnavailable(RuntimeError):
    """ACC isn't running, or its memory can't be read from here."""


def find_acc_pid() -> int:
    """PID of the running ACC process, or raise."""
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/comm", "r") as fh:
                if fh.read().strip() == ACC_COMM:
                    return int(entry)
        except OSError:
            continue
    raise DirectReadUnavailable("ACC is not running")


def _candidate_regions(pid: int) -> list:
    """Page-sized shared wine mappings -- the pool the three blocks live in."""
    out = []
    try:
        with open(f"/proc/{pid}/maps", "r") as fh:
            for line in fh:
                m = _MAPS_RE.match(line.strip())
                if not m:
                    continue
                start, end = int(m.group(1), 16), int(m.group(2), 16)
                if end - start == _REGION_SIZE:
                    out.append(start)
    except OSError as e:
        raise DirectReadUnavailable(f"cannot read /proc/{pid}/maps: {e}")
    return out


def _printable(text: str) -> bool:
    return bool(text) and all(c.isprintable() for c in text)


def _plausible(value, lo: float, hi: float) -> bool:
    """A real float in range -- not an integer being reinterpreted as one.

    The decoy Wine mappings are full of small integers, and reading those as
    floats yields *denormals* (~1e-45) that sit inside any [0, 1] range test.
    Physical quantities are either exactly zero or comfortably normal, so
    rejecting the denormal band is what separates the real physics block from a
    region that merely looks like it.
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        return False
    if v != v:  # NaN
        return False
    if v != 0.0 and abs(v) < 1e-6:
        return False
    return lo <= v <= hi


def _score_static(data: bytes) -> int:
    """acpmf_static leads with smVersion/acVersion as UTF-16 version strings."""
    try:
        sm = read_field(data, STATIC_OFFSETS, "smVersion")
        ac = read_field(data, STATIC_OFFSETS, "acVersion")
        car = read_field(data, STATIC_OFFSETS, "carModel")
        track = read_field(data, STATIC_OFFSETS, "track")
        max_rpm = read_field(data, STATIC_OFFSETS, "maxRpm")
    except Exception:
        return 0
    score = 0
    if sm and sm[0].isdigit() and "." in sm:
        score += 3
    if ac and ac[0].isdigit() and "." in ac:
        score += 2
    if _printable(car):
        score += 2
    if _printable(track):
        score += 2
    if 0 < max_rpm < 30000:
        score += 1
    return score


def _score_graphics(data: bytes) -> int:
    try:
        status = read_field(data, GRAPHICS_OFFSETS, "status")
        session = read_field(data, GRAPHICS_OFFSETS, "session")
        norm = read_field(data, GRAPHICS_OFFSETS, "normalizedCarPosition")
        pos = read_field(data, GRAPHICS_OFFSETS, "position")
        laps = read_field(data, GRAPHICS_OFFSETS, "completedLaps")
        compound = read_field(data, GRAPHICS_OFFSETS, "tyreCompound")
        player_id = read_field(data, GRAPHICS_OFFSETS, "playerCarID")
    except Exception:
        return 0
    score = 0
    if 0 <= status <= 3:
        score += 3
    if -1 <= session <= 12:
        score += 2
    if norm == 0.0 or _plausible(norm, 0.0, 1.0):
        score += 3
    if 0 <= pos < 200:
        score += 1
    if 0 <= laps < 2000:
        score += 1
    # A wide UTF-16 compound name is the giveaway: the physics block holds
    # float arrays at this offset, which decode to junk.
    if compound == "" or _printable(compound):
        score += 3
    if -1 <= player_id < 200:
        score += 1
    return score


def _score_physics(data: bytes) -> int:
    try:
        gas = read_field(data, PHYSICS_OFFSETS, "gas")
        brake = read_field(data, PHYSICS_OFFSETS, "brake")
        clutch = read_field(data, PHYSICS_OFFSETS, "clutch")
        rpm = read_field(data, PHYSICS_OFFSETS, "rpm")
        gear = read_field(data, PHYSICS_OFFSETS, "gear")
        speed = read_field(data, PHYSICS_OFFSETS, "speedKmh")
        fuel = read_field(data, PHYSICS_OFFSETS, "fuel")
    except Exception:
        return 0
    score = 0
    for pedal in (gas, brake, clutch):
        # Exactly-zero or a genuine float; denormals mean we're looking at
        # integers in some unrelated Wine mapping.
        if pedal == 0.0 or _plausible(pedal, 0.0, 1.0):
            score += 1
    if 0 <= rpm <= 25000:
        score += 2
    if 0 <= gear <= 10:
        score += 2
    if speed == 0.0 or _plausible(speed, -20.0, 500.0):
        score += 2
    if fuel == 0.0 or _plausible(fuel, 0.0, 200.0):
        score += 1
    return score


class AccDirectSharedMemory:
    """Locates ACC's three blocks in a running game and samples them."""

    #: below this the region almost certainly isn't the block we scored it as
    MIN_SCORE = 6

    def __init__(self):
        self.pid = find_acc_pid()
        self._mem = None
        try:
            self._mem = open(f"/proc/{self.pid}/mem", "rb", 0)
        except OSError as e:
            if e.errno in (errno.EACCES, errno.EPERM):
                raise DirectReadUnavailable(
                    f"not allowed to read ACC's memory (pid {self.pid}). Either relax "
                    "ptrace_scope (sysctl kernel.yama.ptrace_scope=0) or use the "
                    "shared-memory bridge instead.")
            raise DirectReadUnavailable(f"cannot open /proc/{self.pid}/mem: {e}")

        self._addr = {}
        self._locate()

    def _read(self, addr: int, size: int) -> bytes:
        self._mem.seek(addr)
        data = self._mem.read(size)
        if data is None or len(data) < size:
            raise DirectReadUnavailable("short read from ACC memory")
        return data

    def _locate(self) -> None:
        """Identify which candidate region is which block, by content."""
        candidates = _candidate_regions(self.pid)
        if not candidates:
            raise DirectReadUnavailable(
                "no ACC shared-memory regions found (is the game past the launcher?)")

        # Two snapshots: the packetId delta separates ACC's live blocks from
        # unrelated Wine mappings that happen to score plausibly. Sitting in the
        # pits zeroes most physics fields, so the static scores alone are not
        # enough to tell the real block from a page of small integers.
        first = {}
        for addr in candidates:
            try:
                first[addr] = self._read(addr, _REGION_SIZE)
            except (OSError, DirectReadUnavailable):
                continue
        time.sleep(0.15)

        scored = []
        for addr, before in first.items():
            try:
                data = self._read(addr, _REGION_SIZE)
            except (OSError, DirectReadUnavailable):
                continue
            delta = (read_field(data, PHYSICS_OFFSETS, "packetId")
                     - read_field(before, PHYSICS_OFFSETS, "packetId"))
            scored.append((addr, {
                "static": _score_static(data),
                "graphics": _score_graphics(data),
                "physics": _score_physics(data),
            }, delta))

        taken = set()

        # static first: the version strings are unmistakable, and it is the one
        # block that legitimately never ticks.
        static = max(scored, key=lambda r: r[1]["static"], default=None)
        if not static or static[1]["static"] < self.MIN_SCORE:
            raise DirectReadUnavailable(
                "could not identify ACC's static block; the layout may have changed")
        self._addr["static"] = static[0]
        taken.add(static[0])

        # physics and graphics both advance packetId every frame; a stale
        # mapping does not. Physics ticks at the physics rate (~333 Hz) and
        # graphics at render rate, so the faster of the two live blocks is
        # physics -- but require the field checks to agree before trusting that.
        live = [r for r in scored if r[0] not in taken and r[2] > 0]
        if not live:
            raise DirectReadUnavailable(
                "ACC's telemetry blocks are not updating (still at the launcher?)")

        physics = max(live, key=lambda r: (r[1]["physics"] >= self.MIN_SCORE, r[2]))
        if physics[1]["physics"] < self.MIN_SCORE:
            raise DirectReadUnavailable(
                f"could not identify ACC's physics block (best score "
                f"{physics[1]['physics']}); the layout may have changed")
        self._addr["physics"] = physics[0]
        taken.add(physics[0])

        remaining = [r for r in live if r[0] not in taken]
        graphics = max(remaining, key=lambda r: r[1]["graphics"], default=None)
        if not graphics or graphics[1]["graphics"] < self.MIN_SCORE:
            raise DirectReadUnavailable(
                "could not identify ACC's graphics block; the layout may have changed")
        self._addr["graphics"] = graphics[0]

        logger.info(
            "ACC shared memory located in pid %d: static=%#x graphics=%#x physics=%#x",
            self.pid, self._addr["static"], self._addr["graphics"], self._addr["physics"])

    def alive(self) -> bool:
        return os.path.isdir(f"/proc/{self.pid}")

    def sample(self) -> dict:
        """One decoded frame, shaped exactly like a bridge datagram."""
        p = self._read(self._addr["physics"], PHYSICS_SIZE)
        g = self._read(self._addr["graphics"], GRAPHICS_SIZE)
        s = self._read(self._addr["static"], STATIC_SIZE)
        return build_sample(p, g, s)

    def close(self) -> None:
        if self._mem:
            try:
                self._mem.close()
            except OSError:
                pass
        self._mem = None
