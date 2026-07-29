# ACC Shared-Memory Bridge

Forwards ACC's full physics telemetry — throttle, brake, clutch, steering, RPM,
tyres, brakes, G-forces — to the telemetry backend.

> **You probably don't need this.** On Linux the backend reads ACC's shared
> memory *directly* out of the running game
> (`backend/app/services/live_sources/acc_shm_direct.py`) — just pick
> **Live Telemetry → Source → Physics** with ACC running. The live panel shows
> "Reading ACC's memory directly" when that path is active.
>
> The bridge is the fallback for the two cases the direct read can't cover:
> * a hardened `kernel.yama.ptrace_scope` that forbids reading the game's memory;
> * the app running on a **different machine** from the game.
>
> You can force either path with the `shmTransport` config value
> (`auto` / `direct` / `bridge`).

## Why this exists

ACC publishes its physics state in **Windows named shared memory**
(`Local\acpmf_physics`, `…_graphics`, `…_static`). Wine does not expose named
shared memory to native Linux processes, so the app's Linux backend cannot read
it directly. This script runs on the **Windows side** of ACC's Proton prefix,
reads those blocks, and forwards each sample to the backend over loopback UDP:

```
ACC --(shared memory)--> acc_bridge.py --(UDP 127.0.0.1:9600)--> backend
```

The app's other live source (`Timing`) uses ACC's UDP broadcasting API, which
works natively from Linux but carries **no** pedals, steering, RPM or tyre data.
That's the gap this closes.

On native Windows you can run the bridge exactly the same way — the backend
always receives UDP, so there is one code path everywhere.

## Setup

### 1. Point the app at the bridge

In the app: **Live Telemetry → Source → Physics**. The default bridge port is
`9600`; if you change it here, pass the same value to `--port` below.

### 2. Run the bridge inside ACC's Proton prefix

The bridge needs a *Windows* Python, running in the same prefix as ACC. The
simplest route is Steam launch options — right-click **Assetto Corsa
Competizione → Properties → Launch Options**:

```
python C:\path\to\acc_bridge.py & %command%
```

If the prefix has no Python, use `protontricks` to install one, or compile the
bridge to a standalone `.exe` on any Windows machine:

```
pip install pyinstaller
pyinstaller --onefile --console acc_bridge.py
```

and then launch that instead:

```
Z:\path\to\acc_bridge.exe & %command%
```

Run it manually inside the prefix (useful while setting up):

```bash
protontricks-launch --appid 805550 /path/to/python.exe acc_bridge.py --verbose
```

## Verifying it works

Before trusting the feed, check the decoded values against the in-game HUD:

```bash
python acc_bridge.py --dump
```

With the car on track this prints a line per sample:

```
t=  12.40 status=2 brands_hatch | mclaren_720s_gt3_evo | gas=1.00 brake=0.00 clutch=0.00 gear=4 rpm= 7180 steer=-0.043 speed= 214.3 | norm=0.3312 lap=2 | tyreT=82,84,79,80
```

`gas`/`brake` are 0..1, `steer` is −1..1 of the car's lock, `norm` is the 0→1
lap fraction. If these track what the car is doing, the layout is being read
correctly and the UDP path will be correct too.

`status` is ACC's own: `0` OFF, `1` REPLAY, `2` LIVE, `3` PAUSE. The backend
only logs samples in LIVE/PAUSE, so menus and replays don't pollute the feed.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--host` | `127.0.0.1` | Backend address. Set to the LAN IP if the app runs on another machine. |
| `--port` | `9600` | Backend UDP port. Must match the app's **Bridge Port**. |
| `--hz` | `60` | Sample rate. The backend downsamples to 60 Hz anyway. |
| `--dump` | off | Print decoded values instead of sending. |
| `--verbose` | off | Log connection state and send counts. |

## Notes on correctness

The struct layouts are transcribed from Kunos' published SDK header. Field
*order* is what matters: one wrong entry shifts every offset after it and
produces plausible-looking garbage. As a guard, `acc_bridge.py` asserts at
import time that its physics and graphics field tables sum to exactly the block
sizes ACC allocates (800 and 1588 bytes). If ACC ever changes the layout, that
assertion fires immediately instead of silently feeding you wrong numbers.

The static block's trailing fields (tyre names) extend past the 784-byte
mapping, so the table deliberately stops at `maxFuel` — everything the app needs
sits before that.

## What the backend does with it

`backend/app/services/live_sources/acc_shm.py` maps the raw fields onto the
app's channel names, so live data is schema-identical to an imported `.ld` lap:

| App channel | ACC field |
|---|---|
| `Throttle Pos` / `Brake Pos` / `Clutch Pos` | `gas` / `brake` / `clutch` × 100 |
| `Steering Angle` | `steerAngle` × lock/2, negated |
| `Engine RPM`, `Ground Speed`, `Gear` | `rpms`, `speedKmh`, `gear − 1` |
| `G Force Lat` / `Long` / `Vert` | `accG[0]` / `accG[2]` / `accG[1]` |
| `GPS Latitude` / `Longitude` | `carCoordinates` X/Z of the player's car |
| `Lap Dist` | `distanceTraveled` differenced per lap |
| `TyresPressure`, `TyresCoreTemp`, `Susp Pos`, `Brake Temp`, `Slip Ratio` | per-wheel arrays (LF, RF, LR, RR) |
| `Fuel Level`, `TC`, `ABS`, `Brake Bias`, water/air/road temps | direct |

Because the bridge sends **raw** ACC fields rather than app channel names, that
mapping can change without reshipping the bridge.
