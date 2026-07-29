# ACC Real-Time Telemetry — Design & Plan

**Status:** Design proposal
**Scope:** Stream live telemetry from a running ACC session into the app — a live driver dashboard (speed/throttle/brake/steering/gear/rpm/tyres) and a moving car on the track map — and turn each completed lap into a normal analysable session, reusing the existing charts, map, library, and sync pipeline.

---

## 1. Goal

Today the app is post-session: you drive, ACC writes MoTeC `.ld` files, the sync agent imports them (see `ACC_GAME_SYNC_DESIGN.md`). This adds a **live** path: while you're on track, the same DRIVER/TYRES/DYNAMICS charts and the track map update in real time, and when you cross the line the lap is persisted as a standard session (same DuckDB schema → instantly comparable, referenceable, and covered by the library filters).

**Design principle:** the live source feeds the **exact same channel schema** the importer already produces (`Ground Speed`, `Throttle Pos`, `Brake Pos`, …). Nothing downstream — charts, map, lap logic, insights — needs to know whether data came from a `.ld` file or a live socket.

```
ACC (running) ─► live source ─► backend reader (≈60 Hz) ─► ring buffer ─► WebSocket ─► store (live mode) ─► charts + map
                                          │
                                          └─ on lap complete ─► write DuckDB (same schema) ─► normal session
```

---

## 2. What ACC exposes

ACC offers **two** real-time interfaces. They are complementary; the right choice depends on how much data you need and — critically here — that we run on **Linux/Proton**.

### 2.1 Shared Memory (full physics) — the rich source
ACC continuously writes three memory-mapped structs (Windows named shared memory). This is the only source with pedal/steering/rpm/tyre detail — i.e. everything the DRIVER/TYRES/DYNAMICS tabs show.

| Mapping name | Struct | Key fields (subset) | Rate |
|---|---|---|---|
| `Local\acpmf_physics` | `SPageFilePhysics` | `gas`, `brake`, `clutch`, `gear`, `rpms`, `speedKmh`, `steerAngle`, `accG[3]`, `velocity[3]`, `localAngularVel[3]`, `wheelSlip[4]`, `wheelsPressure[4]`, `tyreCoreTemperature[4]`, `suspensionTravel[4]`, `brakeTemp[4]`, `tc`, `abs`, `fuel`, `heading/pitch/roll` | physics (~333 Hz; sample ~60 Hz) |
| `Local\acpmf_graphics` | `SPageFileGraphics` | `status` (OFF/LIVE/PAUSE/REPLAY), `session`, `completedLaps`, `position`, `iCurrentTime/iLastTime/iBestTime` (ms), `normalizedCarPosition` (0..1), `carCoordinates[3]` (world X,Y,Z), `isInPitLane`, `currentSectorIndex`, `flag`, `tyreCompound` | ~graphics FPS |
| `Local\acpmf_static` | `SPageFileStatic` | `smVersion`, `carModel`, `track`, `playerName/Surname`, `sectorCount`, `maxRpm`, `maxFuel`, `numCars` | once/rarely |

**Why this is ideal:** `carCoordinates` gives the **real world position** (no dead-reckoning), so the track map is exact — this sidesteps the GPS reconstruction drift we just fixed for the file path. `normalizedCarPosition` (0→1 per lap) plus `completedLaps` give **precise lap segmentation** for free.

### 2.2 UDP Broadcasting (timing + positions) — the network source
ACC's broadcasting API (enable via `…/Config/broadcasting.json`: `updListenerPort`, `connectionPassword`) streams over UDP. `RealtimeCarUpdate` per car carries: `kmh`, `gear`, `worldPosX/Y`, `yaw`, `splinePosition` (0..1), `carLocation` (track/pitlane), `laps`, `currentLap`/`lastLap`/`bestSessionLap`, `delta`. Plus session/leaderboard/track events.

**What it gives:** live map position, speed, gear, lap fraction, lap times, deltas, standings — for **all** cars. **What it lacks:** throttle, brake, steering, rpm, tyres (no physics). It is **network-based**, so it works **natively from Linux with zero bridge**.

### 2.3 The Linux/Proton reality (corrected after implementation)

> **This section's original premise was wrong, and the implementation is better for it.**
> It claimed a native Linux reader *cannot* reach `acpmf_physics`. In practice it
> can: Wine backs named mappings with anonymous `memfd` objects that remain
> visible in the game process's address space, so they are readable through
> `/proc/<pid>/mem` from the same user. `live_sources/acc_shm_direct.py` does
> exactly that — **no bridge, no Proton-side Python, no Steam launch options**.
> Verified against a running ACC: `smVersion 1.9`, car `bmw_m4_gt3`, track `Spa`.
>
> Two wrinkles worth knowing:
> * Wine hashes the mapping names away, so the three blocks are identified by
>   **content**, not by name. Several unrelated Wine mappings score plausibly on
>   static field checks alone, so identification also requires the block's
>   `packetId` to be **advancing**, and rejects denormal floats (reinterpreted
>   integers land in the ~1e-45 band and would otherwise pass a `0..1` pedal test).
> * A hardened `kernel.yama.ptrace_scope` can deny the read. That, and running
>   the app on a different machine from the game, are what the bridge still covers.

We run the backend as a **native Linux** process; ACC runs under **Proton/Wine**. Where the direct read is unavailable, two fallbacks remain:

1. **Proton-side bridge (for full physics):** a tiny Windows helper (a ~150-line `.exe`, or `wine python`) launched **inside the same Proton prefix** memory-maps the three structs and forwards frames over **UDP to `127.0.0.1`**. The native backend just receives UDP — same code path on every OS. Launch it via Steam launch options (`bridge.exe %command%`) or a Proton wrapper script.
2. **UDP broadcasting (no bridge):** works from Linux immediately, but physics-less (§2.2).

**Recommendation:** ship **UDP broadcasting first** (Tier B — native, zero-friction live map + timing), then add the **shared-memory bridge** (Tier A — full physics dashboard). Both deliver frames to the *same* backend ingestion API, so Tier A is a drop-in upgrade of the source, not a rewrite.

---

## 3. Channel mapping (live → existing schema)

The backend maps each live frame to the app's channel names — the same targets `acc_importer.CONTINUOUS_MAP` / `WHEEL_MAP` / `GFORCE_MAP` already use — so a live frame is schema-identical to an imported sample.

| App channel (DuckDB table) | Shared-memory source | UDP source | Notes |
|---|---|---|---|
| `Ground Speed` | `speedKmh` | `kmh` | km/h |
| `Throttle Pos` | `gas * 100` | — | % |
| `Brake Pos` | `brake * 100` | — | % |
| `Steering Angle` | `steerAngle * steeringLockDeg`, **negated** | — | `steerAngle` is −1..1; reuse `_INVERT_SIGN_CHANNELS` sign convention |
| `Engine RPM` | `rpms` | — | |
| `Gear` | `gear − 1` | `gear − 1` | ACC 0=R,1=N,2=1st |
| `Yaw Rate` | `localAngularVel[1]`·rad→deg | derive from `yaw` Δ | replaces reconstructed ROTY |
| `G Force Lat/Long` | `accG[0]`, `accG[2]` | — | already in G (no `/G`) |
| `TireHeat` (4) | `tyreCoreTemperature[4]` | — | LF,RF,LR,RR order |
| `TyresPressure` (4) | `wheelsPressure[4]` | — | |
| `Susp Pos` (4) | `suspensionTravel[4]` | — | |
| `TC` / `ABS` | `tc`, `abs` | — | pulse events |
| `GPS Latitude/Longitude` | `carCoordinates` (X,Z → lat/lon) | `worldPosX/Y` | **real position, no reconstruction** |
| `Lap Dist` | `normalizedCarPosition · trackLength` | `splinePosition · len` | |
| `In Pits` | `isInPitLane` | `carLocation != track` | |
| `Fuel Level` | `fuel` | — | |

World coordinates map to the app's lat/lon frame with the same neutral base `reconstruct_gps` uses (LAT0=45, LON0=9, `DEG_M=111320`), so the 2D/3D map projects them unchanged — but now from **true** positions.

---

## 4. Backend design

### 4.1 New service: `backend/app/services/live_telemetry_service.py`
- **Source adapters** (pluggable): `UdpBroadcastSource` (Tier B) and `SharedMemoryBridgeSource` (Tier A, receives the bridge's UDP frames). Both emit a normalized `LiveFrame` dict keyed by app channel names + `t` (monotonic seconds) + `meta` (track/car/lap).
- **Reader thread**: opens the source, reads at the source rate, **downsamples to ~60 Hz**, and pushes each frame into a bounded **ring buffer** (e.g. last 90 s) and an async broadcast queue.
- **Lap segmenter**: watches `completedLaps` (or `normalizedCarPosition` wrap 1→0). On a boundary it (a) emits a `lap_complete` event and (b) hands the buffered lap samples to the persister.
- **Session lifecycle**: `status` transitions (OFF→LIVE) start a session; `OFF`/exit ends it.

### 4.2 Persistence (reuse everything)
On lap complete, resample the buffered lap to a uniform grid and append per-channel rows to a **DuckDB in the exact schema** `acc_importer` writes (`GPS Time`, `Ground Speed`, …, `Lap`, `Lap Time`, `metadata` with `Game=ACC`, `Source=live`). Factor the DataFrame-building out of `acc_importer._build_tables` into a shared helper both paths call. Result: a live session becomes a normal session — analysable, referenceable, and listed under a new **`source: 'live'`** (extend the Phase-1 provenance: `sync | manual | live`).

Two persistence modes: **per-stint file** (append laps until pit/OFF) or **per-lap file**. Per-stint matches how `.ld` sessions look today.

### 4.3 Transport: WebSocket
- `GET /live/ws` (FastAPI `WebSocket`): on connect, send the current ring-buffer tail (so charts fill instantly), then stream frames. Broadcast via an `asyncio.Queue` per client fed by the reader thread (thread → loop via `run_coroutine_threadsafe`).
- Control REST: `GET /live/status` (source, connected, session/track/car, hz), `POST /live/start`, `POST /live/stop`, `POST /live/config` (source type, UDP port/password, bridge port).
- **Message schema** (compact, batched ~10–20 Hz to the client even if sampled at 60 Hz):
  ```json
  { "type": "frames",
    "meta": { "track": "brands_hatch", "car": "mclaren_720s_gt3_evo", "lap": 3, "status": "LIVE" },
    "t0": 1234.5,
    "channels": ["Ground Speed","Throttle Pos","Brake Pos","Steering Angle","Gear","Engine RPM","GPS Latitude","GPS Longitude"],
    "rows": [[212.4, 100, 0, -3.1, 5, 7400, 45.0009, 9.0011], ...] }
  ```
  Plus `{"type":"lap_complete","lap":3,"time":84562,"sessionId":"…"}` and `{"type":"status", …}`.

---

## 5. Frontend design

### 5.1 Store (`telemetryStore.ts`)
Add a **live slice**: `liveMode`, `liveConnected`, `liveMeta`, and a **rolling window** buffer that appends incoming frames into the same `telemetryData` array shape the charts already read. A `LiveTelemetryClient` (WebSocket) parses `frames` and appends; on `lap_complete` it can auto-refresh the session list so the finished lap appears.

### 5.2 Reuse the existing live rendering
`TelemetryChart.tsx` already has an `isPlaying`/live path with a **"LIVE"** badge and a real-time cursor — reuse it. In live mode the charts show a **moving window** (e.g. last 30–60 s or the current lap by distance) with the cursor pinned to the newest sample. `TrackMap.tsx`'s follow-camera (`cameraMode !== 'static'`) already interpolates the car marker along GPS — feed it the live position and it "just works".

### 5.3 Entry point & UX
A **LIVE** control in the ACC Track Library / dashboard header (sibling to the sync icon): shows connection state (waiting for game / connected / driving / paused), current track+car+lap, and Start/Stop. States mirror the sync-icon pattern. When ACC isn't running: "Waiting for ACC…". On `status=PAUSE`/`REPLAY`: freeze the window and dim the badge.

### 5.4 API client
Add `getLiveStatus`, `startLive`, `stopLive`, `setLiveConfig`, and a `connectLiveSocket()` returning the WS. (Note `client.ts` already routes through `_fetchJson`; keep the WS separate since it's not `fetch`.)

---

## 6. The Proton bridge (Tier A) in detail

A minimal Windows helper shipped alongside the app (or as a downloadable), run **inside ACC's Proton prefix**:

1. `mmap` the three named regions (`Local\acpmf_physics|graphics|static`) and `ctypes.Structure`-decode them (layouts are public and stable).
2. At ~60 Hz, pack the mapped fields into the normalized `LiveFrame` and `sendto('127.0.0.1', <bridgePort>)` as UDP (msgpack/JSON).
3. Exit when `status == OFF` for N seconds or the maps disappear.

**Launching it on Linux/Steam:** set ACC launch options to `path/to/bridge.exe %command%` (Steam runs the wrapper, which spawns both bridge and game in the same prefix), or a small Proton `compatdata` script. The native backend's `SharedMemoryBridgeSource` is just a UDP listener — identical to Tier B plumbing, richer payload. Document the exact struct offsets in the bridge source; keep a `smVersion` check to guard against future layout changes.

> Portability: on **native Windows** (no Proton), the backend can `mmap` the shared memory **directly** (no bridge). So: Windows → direct; Linux/Proton → bridge or UDP broadcasting.

---

## 7. Edge cases & decisions

- **Game not running / socket silent:** status `waiting`; reader retries opening the source on an interval; no error spam.
- **Pause / replay / menu (`status != LIVE`):** stop appending, freeze the window, keep the connection; resume cleanly.
- **Teleport to pits / session reset:** `completedLaps` decreasing or a big `normalizedCarPosition` jump → discard the in-progress lap buffer, don't persist a garbage lap.
- **Lap validity:** carry ACC's invalidation (cut track / pit) into `isValid` so live laps match the file path's validity semantics.
- **Rate vs. bandwidth:** sample physics at ~60 Hz, batch to the client at ~15 Hz; the DuckDB persist resamples to the app's standard freq (matches the importer).
- **Units/signs:** reuse the importer's conventions (steering negation, gear −1, accG already in G) so live and imported laps overlay exactly.
- **Multiple viewers:** the WebSocket broadcasts to all connected clients from one reader (single source of truth).
- **Security:** bridge and UDP bind to `127.0.0.1` only; broadcasting password read server-side.

---

## 8. Phased roadmap

| Phase | Deliverable | Status |
|---|---|---|
| **1 — Ingestion spine** | `live_telemetry_service` + `LiveFrame` schema + ring buffer + `/live/ws` + `/live/status`. Fed by a **mock source** (replays a stored lap) so the whole frontend live path is built and tested without the game. | ✅ done |
| **2 — Live UI** | Store live slice + WS client + reuse `TelemetryChart` "LIVE" window + track-map follow marker + LIVE header control. | ✅ done |
| **3 — UDP broadcasting source (Linux-native)** | `UdpBroadcastSource`; live map, speed, gear, lap times, deltas — no bridge. Real end-to-end on this machine. | ✅ done (`live_sources/acc_udp.py`) |
| **4 — Shared-memory bridge (full physics)** | Proton bridge + `SharedMemoryBridgeSource`; full DRIVER/TYRES/DYNAMICS live. | ✅ done (`tools/acc_bridge/` + `live_sources/acc_shm.py`) |
| **5 — Persistence & integration** | Lap segmenter → DuckDB (shared builder with `acc_importer`), `source:'live'` provenance + library filter chip, auto-appear in the session list, referenceable/insights-ready. | ⬜ next |

**Phase 4 as shipped.** The bridge sends *raw* ACC fields rather than app channel
names, so the mapping (`live_sources/acc_shm.py`) can change without reshipping
the Windows-side helper. There is no separate Windows direct-mmap source: on
native Windows the same bridge runs locally, which keeps one code path
everywhere. The shared memory has no track-length field, so `Lap Dist` is
derived by differencing ACC's cumulative `distanceTraveled` per lap, which also
self-calibrates the track length. The live map is pinned to **2D** — the 3D lab
needs a completed lap's mesh and elevation, which a stream hasn't produced.

Phase 1–2 stand alone via the mock source; Phase 3 makes it live on Linux without any Windows component; Phase 4 unlocks the full physics dashboard; Phase 5 folds live laps into the existing analysis/library/sync world.

---

## 9. File-by-file change list

**Backend**
- `services/live_telemetry_service.py` *(new)* — sources, reader thread, ring buffer, lap segmenter, broadcast.
- `services/live_sources/` *(new)* — `udp_broadcast.py`, `shared_memory_bridge.py`, `mock_replay.py`.
- `services/acc_importer.py` — extract a shared `build_channel_tables(samples, meta, source)` helper the live persister reuses.
- `api/endpoints.py` — `GET /live/ws`, `GET /live/status`, `POST /live/{start,stop,config}`; extend `Source` provenance to include `live`.
- `main.py` — optional autostart of the reader when a source is configured; clean shutdown.

**Bridge (Tier A)**
- `tools/acc_bridge/` *(new)* — Windows helper (`ctypes` structs + UDP forwarder) + build + launch-option docs.

**Frontend**
- `store/telemetryStore.ts` — live slice + rolling-window append + `lap_complete` handling.
- `api/client.ts` — live REST helpers + `connectLiveSocket()`.
- `components/LiveTelemetryControl.tsx` *(new)* — header LIVE control.
- `components/TelemetryChart.tsx` — reuse/extend the existing `isPlaying` live window for streamed data.
- `components/TrackMap.tsx` — feed the follow marker from the live position.
- `types.ts` — `LiveFrame`/`LiveState` types; add `'live'` to `Session.source`.

---

## 10. Key decisions (summary)

1. **Same schema as imports.** Live frames map to the existing channel tables, so every downstream feature works unchanged and live laps become normal sessions.
2. **Two-tier source, one ingestion API.** UDP broadcasting (native Linux, no bridge) for a fast live map+timing MVP; a Proton shared-memory bridge for full physics — both deliver UDP to the same backend.
3. **Real positions beat reconstruction.** `carCoordinates`/`worldPos` give exact track position and free, precise lap segmentation — no dead-reckoning drift.
4. **Mock-source first.** Build and test the entire live UI against a replayed lap before wiring the game, de-risking the game-dependent parts.
