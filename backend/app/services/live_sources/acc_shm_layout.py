"""ACC shared-memory struct layouts -- the single source of truth.

Imported by both transports:
  * `acc_shm_direct.py` -- reads the blocks straight out of the running game's
    memory on Linux (the normal path).
  * `tools/acc_bridge/acc_bridge.py` -- the Windows-side fallback, which adds
    this file's directory to sys.path so there is only ever one copy of the
    layout. Deliberately stdlib-only with no package-relative imports so that
    standalone import works.

Each field entry is (name, code, count, pad):
    code 'i' = int32, 'f' = float32, 'u' = UTF-16 string (count = wchar count)
    pad      = extra bytes consumed after the field (ACC's structs carry
               occasional 2-byte alignment gaps after odd-length strings)

Field *order* is what matters: one wrong entry shifts every offset after it and
yields plausible-looking garbage rather than an error. `_selfcheck` guards that
by asserting the tables sum to exactly the block sizes ACC allocates.
"""

import struct

#: Wire-format version of the decoded sample (see build_sample).
BRIDGE_PROTOCOL_VERSION = 1

PHYSICS_MAP = ("Local\\acpmf_physics", 800)
GRAPHICS_MAP = ("Local\\acpmf_graphics", 1588)
STATIC_MAP = ("Local\\acpmf_static", 784)

# ---------------------------------------------------------------------------
# Struct layouts
#
# Each entry is (name, code, count, pad):
#   code 'i' = int32, 'f' = float32, 'u' = UTF-16 string (count = wchar count)
#   pad      = extra bytes consumed after the field (ACC's structs are packed
#              with occasional 2-byte alignment gaps after odd-length strings)
#
# Field order is the C struct order from Kunos' SDK header; a wrong order
# silently yields plausible-looking garbage, so the totals are asserted below.
# ---------------------------------------------------------------------------

PHYSICS_FIELDS = [
    ("packetId", "i", 1, 0),
    ("gas", "f", 1, 0),
    ("brake", "f", 1, 0),
    ("fuel", "f", 1, 0),
    ("gear", "i", 1, 0),
    ("rpm", "i", 1, 0),
    ("steerAngle", "f", 1, 0),
    ("speedKmh", "f", 1, 0),
    ("velocity", "f", 3, 0),
    ("accG", "f", 3, 0),
    ("wheelSlip", "f", 4, 0),
    ("wheelLoad", "f", 4, 0),               # unused by ACC
    ("wheelsPressure", "f", 4, 0),
    ("wheelAngularSpeed", "f", 4, 0),
    ("tyreWear", "f", 4, 0),                # unused by ACC
    ("tyreDirtyLevel", "f", 4, 0),          # unused by ACC
    ("tyreCoreTemperature", "f", 4, 0),
    ("camberRAD", "f", 4, 0),               # unused by ACC
    ("suspensionTravel", "f", 4, 0),
    ("drs", "i", 1, 0),                     # unused by ACC
    ("tc", "f", 1, 0),
    ("heading", "f", 1, 0),
    ("pitch", "f", 1, 0),
    ("roll", "f", 1, 0),
    ("cgHeight", "f", 1, 0),                # unused by ACC
    ("carDamage", "f", 5, 0),
    ("numberOfTyresOut", "i", 1, 0),        # unused by ACC
    ("pitLimiterOn", "i", 1, 0),
    ("abs", "f", 1, 0),
    ("kersCharge", "f", 1, 0),              # unused by ACC
    ("kersInput", "f", 1, 0),               # unused by ACC
    ("autoshifterOn", "i", 1, 0),
    ("rideHeight", "f", 2, 0),              # unused by ACC
    ("turboBoost", "f", 1, 0),
    ("ballast", "f", 1, 0),                 # unused by ACC
    ("airDensity", "f", 1, 0),              # unused by ACC
    ("airTemp", "f", 1, 0),
    ("roadTemp", "f", 1, 0),
    ("localAngularVel", "f", 3, 0),
    ("finalFF", "f", 1, 0),
    ("performanceMeter", "f", 1, 0),        # unused by ACC
    ("engineBrake", "i", 1, 0),             # unused by ACC
    ("ersRecoveryLevel", "i", 1, 0),        # unused by ACC
    ("ersPowerLevel", "i", 1, 0),           # unused by ACC
    ("ersHeatCharging", "i", 1, 0),         # unused by ACC
    ("ersIsCharging", "i", 1, 0),           # unused by ACC
    ("kersCurrentKJ", "f", 1, 0),           # unused by ACC
    ("drsAvailable", "i", 1, 0),            # unused by ACC
    ("drsEnabled", "i", 1, 0),              # unused by ACC
    ("brakeTemp", "f", 4, 0),
    ("clutch", "f", 1, 0),
    ("tyreTempI", "f", 4, 0),               # unused by ACC
    ("tyreTempM", "f", 4, 0),               # unused by ACC
    ("tyreTempO", "f", 4, 0),               # unused by ACC
    ("isAIControlled", "i", 1, 0),
    ("tyreContactPoint", "f", 12, 0),       # [4][3]
    ("tyreContactNormal", "f", 12, 0),      # [4][3]
    ("tyreContactHeading", "f", 12, 0),     # [4][3]
    ("brakeBias", "f", 1, 0),
    ("localVelocity", "f", 3, 0),
    ("P2PActivations", "i", 1, 0),          # unused by ACC
    ("P2PStatus", "i", 1, 0),               # unused by ACC
    ("currentMaxRpm", "i", 1, 0),           # unused by ACC
    ("mz", "f", 4, 0),                      # unused by ACC
    ("fz", "f", 4, 0),                      # unused by ACC
    ("my", "f", 4, 0),                      # unused by ACC
    ("slipRatio", "f", 4, 0),
    ("slipAngle", "f", 4, 0),
    ("tcInAction", "i", 1, 0),              # unused by ACC
    ("absInAction", "i", 1, 0),             # unused by ACC
    ("suspensionDamage", "f", 4, 0),
    ("tyreTemp", "f", 4, 0),                # unused by ACC
    ("waterTemp", "f", 1, 0),
    ("brakePressure", "f", 4, 0),
    ("frontBrakeCompound", "i", 1, 0),
    ("rearBrakeCompound", "i", 1, 0),
    ("padLife", "f", 4, 0),
    ("discLife", "f", 4, 0),
    ("ignitionOn", "i", 1, 0),
    ("starterEngineOn", "i", 1, 0),
    ("isEngineRunning", "i", 1, 0),
    ("kerbVibration", "f", 1, 0),
    ("slipVibrations", "f", 1, 0),
    ("gVibrations", "f", 1, 0),
    ("absVibrations", "f", 1, 0),
]

GRAPHICS_FIELDS = [
    ("packetId", "i", 1, 0),
    ("status", "i", 1, 0),                  # 0 OFF, 1 REPLAY, 2 LIVE, 3 PAUSE
    ("session", "i", 1, 0),
    ("currentTime", "u", 15, 0),
    ("lastTime", "u", 15, 0),
    ("bestTime", "u", 15, 0),
    ("split", "u", 15, 0),
    ("completedLaps", "i", 1, 0),
    ("position", "i", 1, 0),
    ("iCurrentTime", "i", 1, 0),
    ("iLastTime", "i", 1, 0),
    ("iBestTime", "i", 1, 0),
    ("sessionTimeLeft", "f", 1, 0),
    ("distanceTraveled", "f", 1, 0),
    ("isInPit", "i", 1, 0),
    ("currentSectorIndex", "i", 1, 0),
    ("lastSectorTime", "i", 1, 0),
    ("numberOfLaps", "i", 1, 0),
    ("tyreCompound", "u", 33, 2),
    ("replayTimeMultiplier", "f", 1, 0),    # unused by ACC
    ("normalizedCarPosition", "f", 1, 0),
    ("activeCars", "i", 1, 0),
    ("carCoordinates", "f", 180, 0),        # [60][3]
    ("carID", "i", 60, 0),
    ("playerCarID", "i", 1, 0),
    ("penaltyTime", "f", 1, 0),
    ("flag", "i", 1, 0),
    ("penalty", "i", 1, 0),
    ("idealLineOn", "i", 1, 0),
    ("isInPitLane", "i", 1, 0),
    ("surfaceGrip", "f", 1, 0),
    ("mandatoryPitDone", "i", 1, 0),
    ("windSpeed", "f", 1, 0),
    ("windDirection", "f", 1, 0),
    ("isSetupMenuVisible", "i", 1, 0),
    ("mainDisplayIndex", "i", 1, 0),
    ("secondaryDisplayIndex", "i", 1, 0),
    ("TC", "i", 1, 0),
    ("TCCut", "i", 1, 0),
    ("EngineMap", "i", 1, 0),
    ("ABS", "i", 1, 0),
    ("fuelXLap", "f", 1, 0),
    ("rainLights", "i", 1, 0),
    ("flashingLights", "i", 1, 0),
    ("lightStage", "i", 1, 0),
    ("exhaustTemperature", "f", 1, 0),
    ("wiperStage", "i", 1, 0),
    ("driverStintTotalTimeLeft", "i", 1, 0),
    ("driverStintTimeLeft", "i", 1, 0),
    ("rainTyres", "i", 1, 0),
    ("sessionIndex", "i", 1, 0),
    ("usedFuel", "f", 1, 0),
    ("deltaLapTime", "u", 15, 2),
    ("iDeltaLapTime", "i", 1, 0),
    ("estimatedLapTime", "u", 15, 2),
    ("iEstimatedLapTime", "i", 1, 0),
    ("isDeltaPositive", "i", 1, 0),
    ("iSplit", "i", 1, 0),
    ("isValidLap", "i", 1, 0),
    ("fuelEstimatedLaps", "f", 1, 0),
    ("trackStatus", "u", 33, 2),
    ("missingMandatoryPits", "i", 1, 0),
    ("clock", "f", 1, 0),
    ("directionLightsLeft", "i", 1, 0),
    ("directionLightsRight", "i", 1, 0),
    ("globalYellow", "i", 1, 0),
    ("globalYellow1", "i", 1, 0),
    ("globalYellow2", "i", 1, 0),
    ("globalYellow3", "i", 1, 0),
    ("globalWhite", "i", 1, 0),
    ("globalGreen", "i", 1, 0),
    ("globalChequered", "i", 1, 0),
    ("globalRed", "i", 1, 0),
    ("mfdTyreSet", "i", 1, 0),
    ("mfdFuelToAdd", "f", 1, 0),
    ("mfdTyrePressureLF", "f", 1, 0),
    ("mfdTyrePressureRF", "f", 1, 0),
    ("mfdTyrePressureLR", "f", 1, 0),
    ("mfdTyrePressureRR", "f", 1, 0),
    ("trackGripStatus", "i", 1, 0),
    ("rainIntensity", "i", 1, 0),
    ("rainIntensityIn10min", "i", 1, 0),
    ("rainIntensityIn30min", "i", 1, 0),
    ("currentTyreSet", "i", 1, 0),
    ("strategyTyreSet", "i", 1, 0),
    ("gapAhead", "i", 1, 0),
    ("gapBehind", "i", 1, 0),
]

# Only walked as far as the fields we actually use (through maxFuel at offset
# 420). ACC's static block continues past that, but the trailing tyre-name
# strings run beyond the 784-byte mapping, so reading them would overrun.
STATIC_FIELDS = [
    ("smVersion", "u", 15, 0),
    ("acVersion", "u", 15, 0),
    ("numberOfSessions", "i", 1, 0),
    ("numCars", "i", 1, 0),
    ("carModel", "u", 33, 0),
    ("track", "u", 33, 0),
    ("playerName", "u", 33, 0),
    ("playerSurname", "u", 33, 0),
    ("playerNick", "u", 33, 2),
    ("sectorCount", "i", 1, 0),
    ("maxTorque", "f", 1, 0),               # unused by ACC
    ("maxPower", "f", 1, 0),                # unused by ACC
    ("maxRpm", "i", 1, 0),
    ("maxFuel", "f", 1, 0),
]


def _field_size(code: str, count: int, pad: int) -> int:
    return (2 * count if code == "u" else 4 * count) + pad


def build_offsets(fields):
    """(offset, code, count) per field name, plus the total struct size."""
    offsets = {}
    pos = 0
    for name, code, count, pad in fields:
        offsets[name] = (pos, code, count)
        pos += _field_size(code, count, pad)
    return offsets, pos


PHYSICS_OFFSETS, PHYSICS_SIZE = build_offsets(PHYSICS_FIELDS)
GRAPHICS_OFFSETS, GRAPHICS_SIZE = build_offsets(GRAPHICS_FIELDS)
STATIC_OFFSETS, STATIC_SIZE = build_offsets(STATIC_FIELDS)


def _selfcheck():
    """Catch a mistyped field table at import time rather than in the data.

    The physics and graphics tables must reproduce ACC's published block sizes
    exactly; if they don't, every offset after the mistake is wrong and the
    forwarded values would be silently meaningless.
    """
    if PHYSICS_SIZE != PHYSICS_MAP[1]:
        raise AssertionError(
            "physics layout is %d bytes, expected %d" % (PHYSICS_SIZE, PHYSICS_MAP[1]))
    if GRAPHICS_SIZE != GRAPHICS_MAP[1]:
        raise AssertionError(
            "graphics layout is %d bytes, expected %d" % (GRAPHICS_SIZE, GRAPHICS_MAP[1]))
    if STATIC_SIZE > STATIC_MAP[1]:
        raise AssertionError(
            "static layout overruns its mapping (%d > %d)" % (STATIC_SIZE, STATIC_MAP[1]))


_selfcheck()


def read_field(buf, offsets, name):
    """Decode one field out of a mapped block."""
    pos, code, count = offsets[name]
    if code == "u":
        raw = buf[pos:pos + 2 * count]
        text = raw.decode("utf-16-le", errors="ignore")
        return text.split("\x00", 1)[0]
    fmt = "<%d%s" % (count, code)
    values = struct.unpack_from(fmt, buf, pos)
    return values[0] if count == 1 else list(values)




def build_sample(physics: bytes, graphics: bytes, static: bytes) -> dict:
    """Decode the three blocks into one frame.

    Returns *raw* ACC fields grouped as p/g/s -- deliberately not app channel
    names, so the mapping in `acc_shm.py` can change without reshipping the
    Windows-side bridge. Both transports emit exactly this shape.
    """
    pf = lambda n: read_field(physics, PHYSICS_OFFSETS, n)    # noqa: E731
    gf = lambda n: read_field(graphics, GRAPHICS_OFFSETS, n)  # noqa: E731
    sf = lambda n: read_field(static, STATIC_OFFSETS, n)      # noqa: E731

    # The player's world position sits in carCoordinates at the index whose
    # carID matches playerCarID -- not at playerCarID itself.
    coords = gf("carCoordinates")
    car_ids = gf("carID")
    player_id = gf("playerCarID")
    try:
        idx = car_ids.index(player_id)
    except ValueError:
        idx = 0
    xyz = coords[3 * idx: 3 * idx + 3] if 3 * idx + 3 <= len(coords) else [0.0, 0.0, 0.0]

    return {
        "v": BRIDGE_PROTOCOL_VERSION,
        "p": {
            "packetId": pf("packetId"),
            "gas": pf("gas"),
            "brake": pf("brake"),
            "clutch": pf("clutch"),
            "gear": pf("gear"),
            "rpm": pf("rpm"),
            "steerAngle": pf("steerAngle"),
            "speedKmh": pf("speedKmh"),
            "fuel": pf("fuel"),
            "accG": pf("accG"),
            "localAngularVel": pf("localAngularVel"),
            "wheelsPressure": pf("wheelsPressure"),
            "tyreCoreTemperature": pf("tyreCoreTemperature"),
            "suspensionTravel": pf("suspensionTravel"),
            "wheelAngularSpeed": pf("wheelAngularSpeed"),
            "brakeTemp": pf("brakeTemp"),
            "brakePressure": pf("brakePressure"),
            "wheelSlip": pf("wheelSlip"),
            "slipRatio": pf("slipRatio"),
            "slipAngle": pf("slipAngle"),
            "tc": pf("tc"),
            "abs": pf("abs"),
            "brakeBias": pf("brakeBias"),
            "turboBoost": pf("turboBoost"),
            "waterTemp": pf("waterTemp"),
            "airTemp": pf("airTemp"),
            "roadTemp": pf("roadTemp"),
            "heading": pf("heading"),
            "pitch": pf("pitch"),
            "roll": pf("roll"),
            "pitLimiterOn": pf("pitLimiterOn"),
            "isEngineRunning": pf("isEngineRunning"),
        },
        "g": {
            "packetId": gf("packetId"),
            "status": gf("status"),
            "session": gf("session"),
            "completedLaps": gf("completedLaps"),
            "position": gf("position"),
            "iCurrentTime": gf("iCurrentTime"),
            "iLastTime": gf("iLastTime"),
            "iBestTime": gf("iBestTime"),
            "iDeltaLapTime": gf("iDeltaLapTime"),
            "isDeltaPositive": gf("isDeltaPositive"),
            "currentSectorIndex": gf("currentSectorIndex"),
            "lastSectorTime": gf("lastSectorTime"),
            "numberOfLaps": gf("numberOfLaps"),
            "normalizedCarPosition": gf("normalizedCarPosition"),
            # Cumulative session distance -- differenced per lap to get Lap Dist,
            # since the shared memory has no track-length field.
            "distanceTraveled": gf("distanceTraveled"),
            "isInPit": gf("isInPit"),
            "isInPitLane": gf("isInPitLane"),
            "flag": gf("flag"),
            "isValidLap": gf("isValidLap"),
            "tyreCompound": gf("tyreCompound"),
            "sessionTimeLeft": gf("sessionTimeLeft"),
            "usedFuel": gf("usedFuel"),
            "fuelXLap": gf("fuelXLap"),
            "coords": list(xyz),
        },
        "s": {
            "smVersion": sf("smVersion"),
            "carModel": sf("carModel"),
            "track": sf("track"),
            "player": ("%s %s" % (sf("playerName"), sf("playerSurname"))).strip(),
            "sectorCount": sf("sectorCount"),
            "maxRpm": sf("maxRpm"),
            "maxFuel": sf("maxFuel"),
        },
    }
