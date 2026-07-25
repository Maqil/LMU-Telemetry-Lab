# Desktop App Guide — Packaging SIM Telemetry Lab

This document explains, from first principles, how the **SIM Telemetry Lab** web app
(a FastAPI backend + a Vite/React frontend) was turned into a **native macOS desktop
application**, why each step exists, the macOS code-signing problem we hit and how we
solved it, and finally **how to reuse the same approach to build a Linux app**.

It's written to be a learning resource, so it explains the *why*, not just the commands.

---

## 1. The mental model

Our app was originally two dev servers you ran from `start-dev.sh`:

```
uvicorn (FastAPI)  ->  http://localhost:8000   (the API + serves the built frontend)
vite dev server    ->  http://localhost:5173   (the UI, in dev)
```

A "desktop app" doesn't change what the app *is* — it just **wraps a browser and a
server into a single double-clickable bundle** so the user never sees a terminal or a
browser URL. Three ingredients:

| Piece | Role | Tech used here |
|-------|------|----------------|
| **UI (frontend)** | The React app, compiled to static HTML/JS/CSS | Vite build → `frontend/dist/` |
| **Backend** | The Python API that reads telemetry, serves the UI | FastAPI + uvicorn, frozen into one binary by **PyInstaller** |
| **Shell** | A native window that launches the backend and displays the UI | **Electron** (Chromium + Node.js) |

The key architectural decision (already baked into this project): **the backend serves
the frontend**. In production, FastAPI mounts `frontend/dist` at `/`, so there is only
*one* server on port 8000, and Electron simply loads `http://127.0.0.1:8000`. There is
no separate Vite server in the packaged app.

```
┌─────────────────────────────────────────────┐
│  SIM Telemetry Lab.app  (Electron window)     │
│                                               │
│   Chromium renderer  ── loads ──▶ 127.0.0.1:8000
│         │                              ▲       │
│         │ spawns child process          │serves│
│         ▼                              │       │
│   lmu-telemetry-backend (PyInstaller)  ─┘       │
│     = uvicorn + FastAPI + duckdb + frontend/dist│
└─────────────────────────────────────────────┘
```

---

## 2. How the packaged app runs (runtime flow)

When you double-click the `.app`, macOS launches Electron's main process
(`desktop/main.js`). Here's the exact sequence it performs (see `createWindow()`):

1. **Create the window** — a 1600×900 `BrowserWindow`.
2. **Detect packaged mode** — `app.isPackaged` is `true` inside a built app, `false`
   when you run `electron .` in dev. This lets one file handle both.
3. **Locate the backend binary** — inside the bundle at
   `Contents/Resources/backend-dist/lmu-telemetry-backend/lmu-telemetry-backend`
   (no `.exe` on macOS/Linux; `.exe` on Windows).
4. **Free port 8000** — kills any stale process holding the port
   (`lsof -ti tcp:8000 | xargs kill -9` on mac/Linux; `netstat`/`taskkill` on Windows).
5. **Spawn the backend** as a child process.
6. **Poll `/api/v1/health`** up to 60× every 500 ms (30 s budget) until it returns 200.
7. **Load the UI** — `win.loadURL('http://127.0.0.1:8000')`.
8. **On quit** — `backendProcess.kill()` so no orphan server is left behind.

The backend itself, when frozen (`getattr(sys, 'frozen', False)` is true), runs uvicorn
on `127.0.0.1:8000` from its `if __name__ == "__main__"` block in `backend/main.py`, and
stores user data under `~/LMU_Telemetry_Lab/` (see §7).

**Why an HTTP health check and not just a delay?** The backend takes a variable amount
of time to unpack (PyInstaller) and boot uvicorn. Polling a real endpoint is robust;
a fixed `sleep` is a race condition.

---

## 3. The build pipeline (what actually produces the app)

Everything below is automated in **`build-mac-app.sh`** at the repo root. Run it with:

```bash
./build-mac-app.sh
```

But here is each stage and *why* it exists.

### Stage 1 — Build the frontend
```bash
cd frontend && npm run build      # → frontend/dist/  (static HTML/JS/CSS)
```
Vite compiles React + copies `frontend/public/**` (including our country flags and car
logos) into `frontend/dist/`. This folder is what the backend serves and what gets
bundled into the backend binary.

### Stage 2 — Freeze the backend with PyInstaller
```bash
pip install pyinstaller
pyinstaller --noconfirm backend.spec   # → dist/lmu-telemetry-backend/
```
**PyInstaller** reads `backend.spec` and turns the Python app (interpreter + all
dependencies: FastAPI, uvicorn, duckdb, pandas, numpy…) into a **self-contained folder**
so the target machine needs **no Python installed**. Key parts of our `backend.spec`:

- `Analysis(['backend/main.py'], …)` — the entry point.
- `datas=added_files` — extra files copied into the bundle. We include
  `frontend/dist` (so the frozen backend can serve the UI) and *conditionally* the
  optional `lmu_carname_to_modelname.csv` / `discord_config.json` **only if they exist**
  (otherwise PyInstaller errors on a missing data file).
- `binaries=collect_dynamic_libs('duckdb')` — duckdb ships a compiled native extension
  that PyInstaller doesn't always auto-detect; we collect it explicitly so DB queries work.
- `hiddenimports=[…uvicorn.*…]` — uvicorn loads some submodules dynamically (by string),
  which static analysis misses, so we name them explicitly.
- `COLLECT(... name='lmu-telemetry-backend')` — produces a **onedir** build: a folder
  containing the launcher binary + an `_internal/` folder of libraries. (The alternative,
  onefile, is a single self-extracting binary — slower to start; onedir is preferred here.)

Output: `dist/lmu-telemetry-backend/` containing `lmu-telemetry-backend` (arm64 Mach-O)
and `_internal/`.

> ⚠️ **PyInstaller does NOT cross-compile.** A macOS run produces a macOS (arm64) binary.
> To get a Linux binary you must run PyInstaller **on Linux** (see §8).

### Stage 3 — Package with electron-builder
```bash
cd desktop
npm install                                   # electron + electron-builder
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack # → dist-electron/mac-arm64/…app  (dir target)
```
`electron-builder` reads the `build` field in `desktop/package.json`. It:
- Downloads the prebuilt Electron runtime (Chromium + Node, ~97 MB) for the target arch.
- Copies `main.js` and Electron into an `.app` bundle.
- Copies our frozen backend in via **`extraResources`**:
  ```json
  "extraResources": [
    { "from": "../dist/lmu-telemetry-backend",
      "to":   "backend-dist/lmu-telemetry-backend",
      "filter": ["**/*"] }
  ]
  ```
  → this lands at `Contents/Resources/backend-dist/lmu-telemetry-backend/` inside the app,
  exactly where `main.js` looks for it.

We used the `--dir` target (`npm run pack`) which outputs the raw `.app`. The `dmg`
target (`npm run dist`) also makes a disk image, but `hdiutil` failed in our environment
(error 35, a transient/sandbox issue) — the `.app` is all you need to run locally.

`CSC_IDENTITY_AUTO_DISCOVERY=false` tells electron-builder not to hunt for a signing
certificate (we sign manually in Stage 4).

### Stage 4 — Ad-hoc code-sign  ← **the critical macOS step**
See §4 for the full story. In short:
```bash
BK="…/SIM Telemetry Lab.app/Contents/Resources/backend-dist/lmu-telemetry-backend"
find "$BK" -type f \( -name '*.so' -o -name '*.dylib' \) -print0 \
  | xargs -0 -I{} codesign --force --sign - --timestamp=none "{}"   # 1. native libs
codesign --force --sign - --timestamp=none "$BK/lmu-telemetry-backend"   # 2. backend binary
codesign --force --deep --sign - --timestamp=none "…/SIM Telemetry Lab.app"  # 3. whole bundle
codesign --verify --deep --strict --verbose=2 "…/SIM Telemetry Lab.app"      # verify
```

---

## 4. The macOS code-signing incident (and the fix)

**Symptom:** the first build launched, then macOS popped **"Malware Blocked and Moved to
Trash — SIM Telemetry Lab.app was not opened because it contains malware."** The app
literally disappeared from disk after each launch.

**It was not malware.** On Apple Silicon and recent macOS, *all executable code must be
code-signed* — at minimum with an **ad-hoc signature**. Two things made our first build
unsigned/tampered:

1. electron-builder was configured with `"identity": null`, so it **skipped signing
   entirely** → the app had no valid signature.
2. electron-builder copies the backend into `Contents/Resources/` **after** Electron's
   own bundled signature was applied, which **breaks the bundle's seal** (the app's
   contents no longer match its signature).

macOS/XProtect treats "unsigned + seal broken" as untrusted and quarantines it to Trash.

**The fix — ad-hoc signing, inside-out.** A code signature seals a bundle *and every
nested Mach-O binary inside it*. If you re-sign only the outer app, the nested unsigned
`.so`/`.dylib` files (from PyInstaller) still fail validation. So you sign from the
inside out:

1. Sign every native library in the backend (`*.so`, `*.dylib`).
2. Sign the backend launcher binary.
3. Deep-sign the whole `.app` (which re-seals Electron's frameworks, helpers, and the
   outer bundle together).

`- ` is the **ad-hoc identity** — it signs without a certificate. The result satisfies
the OS's "must be signed" rule for **running on this machine**.

**Ad-hoc vs. notarized — important distinction:**

| | Ad-hoc (what we did) | Developer ID + notarization |
|---|---|---|
| Cost | Free | Paid Apple Developer account ($99/yr) |
| Runs on the machine that built it | ✅ (no quarantine flag on local builds) | ✅ |
| Runs on *other* Macs without warnings | ❌ (blocked; needs right-click → Open) | ✅ |
| `spctl -a` (Gatekeeper assessment) | "rejected" (expected) | "accepted" |

`spctl` reporting **rejected** is normal for ad-hoc apps and does **not** stop local
launch — a locally built app has no `com.apple.quarantine` attribute, so LaunchServices
runs it. We verified this: double-click (`open`) launched it, backend came up in ~3 s,
UI loaded, and it stayed on disk.

If you download an ad-hoc app from the internet (which *does* set the quarantine flag),
clear it with: `xattr -cr "SIM Telemetry Lab.app"` and/or right-click → Open once.

---

## 5. File-by-file changes we made

| File | Change | Why |
|------|--------|-----|
| `backend.spec` | Bundle `frontend/dist` always; CSV/discord config only if present; `collect_dynamic_libs('duckdb')` | Avoid PyInstaller errors on missing optional files; ensure duckdb's native lib ships |
| `desktop/main.js` | Made the packaged branch cross-platform: OS-specific backend binary name and port-kill (`lsof` on mac/Linux, `netstat`/`taskkill` on Windows) | The original code was Windows-only (`.exe`, `taskkill`) |
| `desktop/package.json` | Added a `mac` build target (`dmg` + `dir`, category, icon, `identity: null`) | electron-builder had only a `win` target |
| `build-mac-app.sh` *(new)* | One command: frontend → PyInstaller → electron-builder → **ad-hoc sign** → verify | Signing must run on **every** rebuild or the app gets trashed again |

---

## 6. Where the app stores data

The frozen backend uses `ProfilesService.get_app_data_dir()`:

- **Packaged/frozen:** `$LOCALAPPDATA/LMU_Telemetry_Lab` — on macOS/Linux `LOCALAPPDATA`
  is unset, so it falls back to `~/LMU_Telemetry_Lab/`.
- **Dev (not frozen):** `~/LMU_Telemetry_Lab_Dev/`.

Inside that root, per profile (`guest` by default):
```
~/LMU_Telemetry_Lab/Data/<profile>/
  ├── DuckDB_data/   # uploaded telemetry (.duckdb per session)
  ├── cache/         # derived parquet caches (regenerable, safe to delete)
  └── avatars/
```
So the **packaged app has its own data directory** separate from the dev servers'
`_Dev` directory. Logs go to `~/LMU_Telemetry_Lab/backend_debug.log` when frozen.

---

## 7. Reusing this to build a **Linux** app

The architecture is identical; only the packaging targets and a few details change. The
biggest constraint:

> 🐧 **You must build on Linux.** PyInstaller can't cross-compile, and Electron's Linux
> binaries differ from macOS. Build inside a Linux machine, VM, Docker container, or CI
> runner (matching the CPU arch you want to ship — x86_64 and/or arm64).

### 7.1 What already works unchanged
- `desktop/main.js` — the non-Windows branch already handles Linux: the backend binary
  has **no extension** (same as mac), and port cleanup uses `lsof` (present on most
  Linux distros — see caveat below).
- `backend.spec` — PyInstaller produces an ELF binary + `_internal/` on Linux the same
  way it produces Mach-O on mac.
- The backend serving the frontend on `:8000` and the health-check flow — identical.

### 7.2 Add a Linux target to `desktop/package.json`
```jsonc
"linux": {
  "target": ["AppImage", "deb"],          // AppImage = portable single file; deb = Debian/Ubuntu installer
  "category": "Utility",
  "icon": "build/icon.png",               // electron-builder generates the icon set from a ≥512px png
  "maintainer": "Your Name <you@example.com>"
}
```
- **AppImage** — a single executable file the user makes executable (`chmod +x`) and
  runs; no install, no root. Best "download and run" option, closest to the mac `.app`.
- **deb** / **rpm** — proper installers that put the app in `/opt` and add a menu entry.

### 7.3 Code signing on Linux
**There is no equivalent of the macOS "must be signed or it's trashed" rule.** Linux
does not require code signing to run. So you can **skip Stage 4 entirely** on Linux.
(Optional: `.deb`/`.rpm` can be GPG-signed for repository trust, and AppImages can carry
a GPG signature, but neither is required to launch.)

### 7.4 A `build-linux-app.sh` (adapt from `build-mac-app.sh`)
```bash
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"; cd "$SCRIPT_DIR"

# 1. Frontend
[ -f .venv/bin/activate ] && source .venv/bin/activate
(cd frontend && npm run build)

# 2. Backend (PyInstaller must run ON Linux → produces an ELF binary)
python -c "import PyInstaller" 2>/dev/null || pip install pyinstaller
pyinstaller --noconfirm backend.spec        # → dist/lmu-telemetry-backend/

# 3. Electron package (AppImage + deb). No signing needed on Linux.
(cd desktop && [ -d node_modules ] || npm install)
(cd desktop && npx electron-builder --linux AppImage deb)

echo "Done → dist-electron/*.AppImage and *.deb"
```

### 7.5 Linux gotchas to watch for
1. **`lsof` may be absent** on minimal distros. Either add it as a dependency, or make
   `main.js` fall back to `fuser -k 8000/tcp` or the pure-Node approach of just letting
   uvicorn fail to bind and retrying. (Our current code assumes `lsof` exists.)
2. **AppImage + `process.resourcesPath`** — Electron resolves this correctly inside a
   mounted AppImage, so the `backend-dist/lmu-telemetry-backend` path still works. Test it.
3. **Native lib compatibility (glibc)** — a PyInstaller binary built on a *newer* distro
   won't run on an *older* one (glibc version mismatch). Build on the **oldest** distro
   you intend to support (a common trick: build in an old Ubuntu LTS Docker image).
4. **Architecture** — build separately for `x86_64` and `arm64`; don't mix.
5. **Sandbox / `--no-sandbox`** — some Linux environments need Electron's Chromium
   sandbox disabled or `chrome-sandbox` correctly `setuid`. electron-builder handles the
   permissions for AppImage/deb, but if the window fails to open, this is the usual cause.
6. **File dialogs / GPU** — install `libgtk-3-0`, `libnss3`, etc. (deb dependencies are
   auto-added by electron-builder; AppImage users may need them present).

---

## 8. Quick command reference

```bash
# macOS — full build (frontend + backend + electron + sign + verify)
./build-mac-app.sh
# result: dist-electron/mac-arm64/SIM Telemetry Lab.app

# Run it
open "dist-electron/mac-arm64/SIM Telemetry Lab.app"

# Inspect the signature
codesign -dv --verbose=4 "dist-electron/mac-arm64/SIM Telemetry Lab.app"

# If a copied/downloaded ad-hoc app is blocked, clear quarantine
xattr -cr "SIM Telemetry Lab.app"

# Dev mode (no packaging) — run backend + electron against source
#   terminal 1: (cd backend && uvicorn main:app --port 8000)
#   terminal 2: (cd desktop && npm start)   # loads http://127.0.0.1:8000
```

---

## 9. Glossary

- **Electron** — a runtime that bundles Chromium (browser) + Node.js so web apps run as
  desktop apps in their own window.
- **PyInstaller** — freezes a Python program + its interpreter + dependencies into a
  standalone executable/folder; the user needs no Python.
- **onedir vs onefile** — PyInstaller output modes: a folder (faster start) vs a single
  self-extracting file (tidier, slower start). We use onedir.
- **electron-builder** — packages an Electron app into platform installers/bundles
  (`.app`/`.dmg`, `.exe`/nsis, `.AppImage`/`.deb`/`.rpm`).
- **extraResources** — files electron-builder copies into the bundle's `Resources/`
  (here: our frozen backend).
- **Code signing** — cryptographically sealing an app so the OS can verify it's
  unmodified. **Ad-hoc** = signed without a certificate (local use). **Notarization** =
  Apple scans and blesses it for distribution.
- **Gatekeeper / XProtect / quarantine** — macOS security layers that decide whether an
  app may run; `spctl` is the CLI to query Gatekeeper's verdict.
- **AppImage** — a portable Linux app format: one executable file, no installation.
```
