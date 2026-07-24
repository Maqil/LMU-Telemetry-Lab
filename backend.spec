# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_dynamic_libs

block_cipher = None

# Add data files needed at runtime. The frontend build is required; the car
# lookup CSV and discord config are optional (both features degrade gracefully
# if absent), so only bundle them when they actually exist on disk.
added_files = [('frontend/dist', 'frontend/dist')]
for src, dst in [('lmu_carname_to_modelname.csv', '.'), ('backend/discord_config.json', '.')]:
    if os.path.exists(src):
        added_files.append((src, dst))

# duckdb ships a compiled native extension that PyInstaller does not always
# pick up automatically; collect it explicitly so the bundle can query DBs.
extra_binaries = collect_dynamic_libs('duckdb')

a = Analysis(
    ['backend/main.py'],
    pathex=[],
    binaries=extra_binaries,
    datas=added_files,
    hiddenimports=[
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='lmu-telemetry-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False, # Set to False to hide the console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='lmu-telemetry-backend',
)
