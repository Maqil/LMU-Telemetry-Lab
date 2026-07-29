#!/usr/bin/env python3
"""ACC shared-memory -> UDP bridge (ACC_REALTIME_TELEMETRY_DESIGN Tier A).

ACC publishes its full physics state in three Windows named shared-memory
blocks. Wine does *not* expose those to native Linux processes, so a native
backend cannot read them directly. This script runs on the **Windows side**
(inside ACC's Proton prefix, or on native Windows) and forwards each sample to
the backend as a JSON datagram on loopback UDP.

    ACC --(shared memory)--> acc_bridge.py --(UDP 127.0.0.1:9600)--> backend

Deliberately dependency-free (stdlib only) and self-contained, because it runs
under whatever Python lives in the Proton prefix -- it must never import from
the app's backend package.

The bridge sends **raw ACC fields**, not app channel names: the mapping to
`Throttle Pos` / `Brake Pos` / ... lives in the backend
(`live_sources/acc_shm.py`) so it can be changed without reshipping the bridge.

Usage
-----
    python acc_bridge.py                 # forward to 127.0.0.1:9600 at 60 Hz
    python acc_bridge.py --port 9600 --hz 60
    python acc_bridge.py --dump          # print decoded values, send nothing

`--dump` is the verification path: run it with ACC on track and check gas/brake/
rpm against the in-game HUD before trusting the feed.
"""
import argparse
import json
import mmap
import os
import socket
import sys
import time

DEFAULT_PORT = 9600
DEFAULT_HZ = 60.0

# The struct layouts live in one place -- the backend module -- so the bridge and
# the native Linux reader can never drift apart. Look beside this script first
# (copy acc_shm_layout.py next to acc_bridge.py when running inside a Proton
# prefix), then fall back to the module's home in the repo.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(1, os.path.join(_HERE, "..", "..", "backend", "app", "services", "live_sources"))
try:
    from acc_shm_layout import (  # noqa: E402
        GRAPHICS_MAP, GRAPHICS_SIZE, PHYSICS_MAP, PHYSICS_SIZE,
        STATIC_MAP, STATIC_SIZE, build_sample,
    )
except ImportError:
    sys.exit("Could not find acc_shm_layout.py. Copy it next to this script "
             "(it lives in backend/app/services/live_sources/).")


class SharedMemoryUnavailable(RuntimeError):
    """ACC isn't running (or we're not on the Windows side of the prefix)."""


class AccSharedMemory:
    """Opens the three mappings and decodes the fields the app cares about."""

    def __init__(self):
        self._maps = {}
        for key, (tag, size) in (
            ("physics", PHYSICS_MAP), ("graphics", GRAPHICS_MAP), ("static", STATIC_MAP)
        ):
            try:
                self._maps[key] = mmap.mmap(-1, size, tagname=tag, access=mmap.ACCESS_READ)
            except TypeError:
                # mmap has no `tagname` outside Windows -- this is the "you ran
                # the bridge on the Linux side" case, not a transient failure.
                self.close()
                raise SharedMemoryUnavailable(
                    "named shared memory is Windows-only; run this script inside "
                    "ACC's Proton prefix (see README.md), not on the Linux host")
            except (OSError, ValueError) as e:
                self.close()
                raise SharedMemoryUnavailable(
                    "cannot open %s (is ACC running?): %s" % (tag, e))

    def close(self):
        for m in self._maps.values():
            try:
                m.close()
            except Exception:
                pass
        self._maps = {}

    def _block(self, key, size):
        m = self._maps[key]
        return m[0:size]

    def sample(self) -> dict:
        """One decoded frame: raw ACC fields grouped as physics/graphics/static."""
        return build_sample(
            self._block("physics", PHYSICS_SIZE),
            self._block("graphics", GRAPHICS_SIZE),
            self._block("static", STATIC_SIZE),
        )


def _round(frame: dict) -> dict:
    """Trim float noise so datagrams stay small (loopback, but still)."""
    def fix(v):
        if isinstance(v, float):
            return round(v, 4)
        if isinstance(v, list):
            return [fix(x) for x in v]
        return v
    for group in ("p", "g", "s"):
        frame[group] = {k: fix(v) for k, v in frame[group].items()}
    return frame


def run(host: str, port: int, hz: float, dump: bool, verbose: bool) -> int:
    period = 1.0 / max(1.0, hz)
    sock = None if dump else socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    shm = None
    t0 = time.monotonic()
    last_packet = None
    sent = 0
    last_report = t0

    print("ACC bridge: %s -> %s:%d at %.0f Hz" % (
        "dump only" if dump else "forwarding", host, port, hz))

    try:
        while True:
            if shm is None:
                try:
                    shm = AccSharedMemory()
                    print("Attached to ACC shared memory.")
                except SharedMemoryUnavailable as e:
                    if sys.platform not in ("win32", "cygwin"):
                        # Retrying can never succeed here -- fail loudly instead
                        # of looping "waiting for ACC" forever.
                        print("Error: %s" % e, file=sys.stderr)
                        return 1
                    if verbose:
                        print("Waiting for ACC: %s" % e)
                    time.sleep(2.0)
                    continue

            try:
                frame = shm.sample()
            except (ValueError, OSError) as e:
                print("Lost ACC shared memory (%s); will retry." % e)
                shm.close()
                shm = None
                continue

            # ACC bumps packetId each physics tick. Repeats mean the game is
            # paused or in a menu -- keep the link alive but don't flood.
            packet = frame["p"].get("packetId")
            duplicate = packet is not None and packet == last_packet
            last_packet = packet

            frame["t"] = round(time.monotonic() - t0, 4)
            frame = _round(frame)

            if dump:
                p, g, s = frame["p"], frame["g"], frame["s"]
                print(
                    "t=%7.2f status=%d %s | %s | gas=%.2f brake=%.2f clutch=%.2f "
                    "gear=%d rpm=%5d steer=%+.3f speed=%6.1f | norm=%.4f lap=%d "
                    "| tyreT=%s" % (
                        frame["t"], g["status"], s["track"], s["carModel"],
                        p["gas"], p["brake"], p["clutch"], p["gear"], p["rpm"],
                        p["steerAngle"], p["speedKmh"], g["normalizedCarPosition"],
                        g["completedLaps"],
                        ",".join("%.0f" % t for t in p["tyreCoreTemperature"]),
                    )
                )
            elif not duplicate or (sent % 30 == 0):
                # Duplicates are still sent occasionally so the backend can tell
                # "paused" from "bridge died".
                try:
                    sock.sendto(json.dumps(frame).encode("utf-8"), (host, port))
                    sent += 1
                except OSError as e:
                    if verbose:
                        print("send failed: %s" % e)

            now = time.monotonic()
            if verbose and not dump and (now - last_report) >= 5.0:
                print("sent %d frames" % sent)
                last_report = now

            time.sleep(period)
    except KeyboardInterrupt:
        print("\nBridge stopped.")
        return 0
    finally:
        if shm:
            shm.close()
        if sock:
            sock.close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Forward ACC shared memory to the telemetry backend over UDP.")
    ap.add_argument("--host", default="127.0.0.1", help="backend host (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="backend UDP port (default %d)" % DEFAULT_PORT)
    ap.add_argument("--hz", type=float, default=DEFAULT_HZ, help="sample rate (default %.0f)" % DEFAULT_HZ)
    ap.add_argument("--dump", action="store_true", help="print decoded values instead of sending")
    ap.add_argument("--verbose", action="store_true", help="log connection/rate detail")
    args = ap.parse_args(argv)

    if not args.dump and sys.platform not in ("win32", "cygwin"):
        print("Warning: this script reads Windows shared memory. On Linux run it "
              "inside ACC's Proton prefix (see README.md).", file=sys.stderr)

    return run(args.host, args.port, args.hz, args.dump, args.verbose)


if __name__ == "__main__":
    sys.exit(main())
