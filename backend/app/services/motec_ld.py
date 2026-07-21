"""Read-only parser for MoTeC .ld binary log files.

ACC exports telemetry as a MoTeC .ld (binary log) plus a .ldx (XML lap index)
sidecar. This module reads the .ld directly so users no longer have to convert
to CSV in MoTeC first. Only the .ld is needed -- it contains all channel data;
the .ldx merely holds lap markers.

The binary layout (header, event/venue/vehicle blocks, and the linked list of
channel-meta blocks) was reverse-engineered by the `ldparser` project
(https://github.com/gotzl/ldparser, MIT License). This is a trimmed,
read-only adaptation of that format description -- the write path and the
pandas/matplotlib helpers are omitted.

Public API:
  read_ldfile(path) -> (ldHead, list[ldChan])
"""
import datetime
import struct

import numpy as np


def decode_string(raw: bytes) -> str:
    """Decode a fixed-width byte field and strip padding / trailing zeros."""
    try:
        return raw.decode("ascii").strip().rstrip("\0").strip()
    except Exception:
        # Fall back to a lenient decode rather than losing the whole file.
        return raw.decode("ascii", errors="replace").strip().rstrip("\0").strip()


class ldVehicle(object):
    fmt = "<64s128xI32s32s"

    def __init__(self, id, weight, type, comment):
        self.id, self.weight, self.type, self.comment = id, weight, type, comment

    @classmethod
    def fromfile(cls, f):
        id, weight, type, comment = struct.unpack(
            ldVehicle.fmt, f.read(struct.calcsize(ldVehicle.fmt)))
        id, type, comment = map(decode_string, [id, type, comment])
        return cls(id, weight, type, comment)


class ldVenue(object):
    fmt = "<64s1034xH"

    def __init__(self, name, vehicle_ptr, vehicle):
        self.name, self.vehicle_ptr, self.vehicle = name, vehicle_ptr, vehicle

    @classmethod
    def fromfile(cls, f):
        name, vehicle_ptr = struct.unpack(
            ldVenue.fmt, f.read(struct.calcsize(ldVenue.fmt)))
        vehicle = None
        if vehicle_ptr > 0:
            f.seek(vehicle_ptr)
            vehicle = ldVehicle.fromfile(f)
        return cls(decode_string(name), vehicle_ptr, vehicle)


class ldEvent(object):
    fmt = "<64s64s1024sH"

    def __init__(self, name, session, comment, venue_ptr, venue):
        self.name, self.session, self.comment, self.venue_ptr, self.venue = \
            name, session, comment, venue_ptr, venue

    @classmethod
    def fromfile(cls, f):
        name, session, comment, venue_ptr = struct.unpack(
            ldEvent.fmt, f.read(struct.calcsize(ldEvent.fmt)))
        name, session, comment = map(decode_string, [name, session, comment])
        venue = None
        if venue_ptr > 0:
            f.seek(venue_ptr)
            venue = ldVenue.fromfile(f)
        return cls(name, session, comment, venue_ptr, venue)


class ldHead(object):
    fmt = "<" + (
        "I4x"     # ldmarker
        "II"      # chann_meta_ptr chann_data_ptr
        "20x"     # ??
        "I"       # event_ptr
        "24x"     # ??
        "HHH"     # unknown static numbers
        "I"       # device serial
        "8s"      # device type
        "H"       # device version
        "H"       # unknown static number
        "I"       # num_channs
        "4x"      # ??
        "16s"     # date
        "16x"     # ??
        "16s"     # time
        "16x"     # ??
        "64s"     # driver
        "64s"     # vehicleid
        "64x"     # ??
        "64s"     # venue
        "64x"     # ??
        "1024x"   # ??
        "I"       # enable "pro logging"
        "66x"     # ??
        "64s"     # short comment
        "126x"    # ??
    )

    def __init__(self, meta_ptr, data_ptr, event_ptr, event, driver, vehicleid,
                 venue, datetime_, short_comment):
        self.meta_ptr = meta_ptr
        self.data_ptr = data_ptr
        self.event_ptr = event_ptr
        self.event = event
        self.driver = driver
        self.vehicleid = vehicleid
        self.venue = venue
        self.datetime = datetime_
        self.short_comment = short_comment

    @classmethod
    def fromfile(cls, f):
        (_, meta_ptr, data_ptr, event_ptr,
         _, _, _,
         _, _, _, _, _n,
         date, time,
         driver, vehicleid, venue,
         _, short_comment) = struct.unpack(ldHead.fmt, f.read(struct.calcsize(ldHead.fmt)))
        date, time, driver, vehicleid, venue, short_comment = \
            map(decode_string, [date, time, driver, vehicleid, venue, short_comment])

        _datetime = None
        for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M"):
            try:
                _datetime = datetime.datetime.strptime("%s %s" % (date, time), fmt)
                break
            except ValueError:
                continue

        event = None
        if event_ptr > 0:
            f.seek(event_ptr)
            event = ldEvent.fromfile(f)
        return cls(meta_ptr, data_ptr, event_ptr, event, driver, vehicleid,
                   venue, _datetime, short_comment)


class ldChan(object):
    """Channel meta block. Data is read lazily via the `data` property."""

    fmt = "<" + (
        "IIII"    # prev_addr next_addr data_ptr n_data
        "H"       # some counter?
        "HHH"     # datatype_a datatype rec_freq
        "hhhh"    # shift mul scale dec_places
        "32s"     # name
        "8s"      # short name
        "12s"     # unit
        "40x"     # ? (40 bytes for ACC, 32 bytes for acti)
    )

    def __init__(self, _f, meta_ptr, prev_meta_ptr, next_meta_ptr, data_ptr,
                 data_len, dtype, freq, shift, mul, scale, dec,
                 name, short_name, unit):
        self._f = _f
        self.meta_ptr = meta_ptr
        self._data = None
        self.prev_meta_ptr = prev_meta_ptr
        self.next_meta_ptr = next_meta_ptr
        self.data_ptr = data_ptr
        self.data_len = data_len
        self.dtype = dtype
        self.freq = freq
        self.shift = shift
        self.mul = mul
        self.scale = scale
        self.dec = dec
        self.name = name
        self.short_name = short_name
        self.unit = unit

    @classmethod
    def fromfile(cls, _f, meta_ptr):
        with open(_f, "rb") as f:
            f.seek(meta_ptr)
            (prev_meta_ptr, next_meta_ptr, data_ptr, data_len, _,
             dtype_a, dtype, freq, shift, mul, scale, dec,
             name, short_name, unit) = struct.unpack(
                ldChan.fmt, f.read(struct.calcsize(ldChan.fmt)))

        name, short_name, unit = map(decode_string, [name, short_name, unit])

        def safe_get(lst, idx):
            if idx < 0 or idx >= len(lst):
                return None
            return lst[idx]

        if dtype_a in (0x07,):
            dtype = safe_get([None, np.float16, None, np.float32], dtype - 1)
        elif dtype_a in (0, 0x03, 0x05):
            dtype = safe_get([None, np.int16, None, np.int32], dtype - 1)
        elif dtype_a == 0x08 and dtype == 0x08:
            dtype = np.dtype("<d")
        else:
            dtype = None

        return cls(_f, meta_ptr, prev_meta_ptr, next_meta_ptr, data_ptr,
                   data_len, dtype, freq, shift, mul, scale, dec,
                   name, short_name, unit)

    @property
    def data(self) -> np.ndarray:
        """Read and de-scale the channel's samples."""
        if self.dtype is None:
            raise ValueError("Channel %s has unknown data type" % self.name)
        if self._data is None:
            with open(self._f, "rb") as f:
                f.seek(self.data_ptr)
                data = np.fromfile(f, count=self.data_len, dtype=self.dtype)
            if len(data) != self.data_len:
                raise ValueError("Not all data read for channel %s" % self.name)
            # De-scale to physical units (matches MoTeC's CSV export values).
            scale = self.scale if self.scale else 1
            self._data = (data / scale * pow(10., -self.dec) + self.shift) * self.mul
        return self._data


def read_channels(path, meta_ptr):
    """Walk the linked list of channel-meta blocks starting at meta_ptr."""
    chans = []
    seen = set()
    while meta_ptr and meta_ptr not in seen:
        seen.add(meta_ptr)  # guard against a corrupt self-referential chain
        chan = ldChan.fromfile(path, meta_ptr)
        chans.append(chan)
        meta_ptr = chan.next_meta_ptr
    return chans


def read_ldfile(path):
    """Read a MoTeC .ld file -> (ldHead, list[ldChan])."""
    with open(path, "rb") as f:
        head = ldHead.fromfile(f)
    chans = read_channels(path, head.meta_ptr)
    return head, chans
