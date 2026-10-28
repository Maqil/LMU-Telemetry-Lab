"""Trace track outlines from the user's own LMU recordings.

Each session stores GPS Latitude/Longitude per sample plus Lap Dist; one clean
lap of that gives the real circuit shape, which we project to metres, simplify,
smooth and emit as an SVG in the same shape/structure as the existing
/acc-tracks outlines (520x380 viewBox, currentColor).
"""
import duckdb, glob, os, math, collections

# Recordings live in the app data dir; outlines land next to the ACC ones.
ROOT = os.environ.get("APP_DATA_DIR") or os.path.expanduser("~/LMU_Telemetry_Lab_Dev")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "frontend", "public", "acc-tracks")

TARGETS = {
    'bahrain':    ['bahrain'],
    'interlagos': ['carlos pace', 'interlagos'],
    'lemans':     ['sarthe', 'le mans'],
    'sebring':    ['sebring'],
    'fuji':       ['fuji'],
    'daytona':    ['daytona'],
}

def sessions():
    for f in glob.glob(os.path.join(ROOT, "**", "*.duckdb"), recursive=True):
        try:
            with duckdb.connect(f, read_only=True) as con:
                m = dict(con.execute("select key, value from metadata").fetchall())
                n = con.execute('select count(*) from "GPS Latitude"').fetchone()[0]
            yield f, m, n
        except Exception:
            continue

def load(f):
    with duckdb.connect(f, read_only=True) as con:
        lat = [r[0] for r in con.execute('select value from "GPS Latitude"').fetchall()]
        lon = [r[0] for r in con.execute('select value from "GPS Longitude"').fetchall()]
        dst = [r[0] for r in con.execute('select value from "Lap Dist"').fetchall()]
    return lat, lon, dst

def best_lap_range(dst):
    """Longest run of monotonically rising Lap Dist -- i.e. one full lap."""
    best = (0, 0)
    start = 0
    for i in range(1, len(dst)):
        if dst[i] < dst[i - 1] - 1.0:          # crossed the line (or reset)
            if i - start > best[1] - best[0]:
                best = (start, i)
            start = i
    if len(dst) - start > best[1] - best[0]:
        best = (start, len(dst))
    return best

def to_metres(lat, lon):
    lat0 = sum(lat) / len(lat)
    k = math.cos(math.radians(lat0))
    return [(lo * 111320.0 * k, la * 110540.0) for la, lo in zip(lat, lon)]

def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1e-9
    idx, dmax = 0, 0.0
    for i in range(1, len(pts) - 1):
        x, y = pts[i]
        d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
        if d > dmax:
            idx, dmax = i, d
    if dmax > eps:
        return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]

def catmull_rom(pts):
    """Closed Catmull-Rom through the points, as cubic beziers."""
    n = len(pts)
    d = [f"M{pts[0][0]:.1f},{pts[0][1]:.1f}"]
    for i in range(n):
        p0, p1, p2, p3 = pts[(i - 1) % n], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d.append(f"C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}")
    d.append("Z")
    return "".join(d)

W, H, STROKE, PAD = 520, 380, 9, 14

def build_svg(key, pts):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    w = (max(xs) - min(xs)) or 1.0
    h = (max(ys) - min(ys)) or 1.0
    room_w, room_h = W - 2 * (PAD + STROKE / 2), H - 2 * (PAD + STROKE / 2)
    s = min(room_w / w, room_h / h)
    ox = (W - w * s) / 2 - min(xs) * s
    oy = (H - h * s) / 2 + max(ys) * s            # flip Y: north is up
    placed = [(x * s + ox, -y * s + oy) for x, y in pts]
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 380" fill="none" '
            f'stroke="currentColor"><g id="{key}"><path d="{catmull_rom(placed)}" '
            f'stroke-width="{STROKE}" stroke-linejoin="round" stroke-linecap="round"/></g></svg>\n')

pool = collections.defaultdict(list)
for f, m, n in sessions():
    name = (m.get('TrackName', '') + ' ' + m.get('TrackLayout', '')).lower()
    for key, kws in TARGETS.items():
        if any(k in name for k in kws):
            pool[key].append((n, f, m.get('TrackLayout', '') or m.get('TrackName', '')))

for key in TARGETS:
    cands = sorted(pool.get(key, []), reverse=True)
    if not cands:
        print(f"{key}: NO TELEMETRY"); continue
    # Prefer the layout with the most recordings, then its longest session.
    layouts = collections.Counter(l for _, _, l in cands)
    layout = layouts.most_common(1)[0][0]
    n, f, _ = next(c for c in cands if c[2] == layout)
    lat, lon, dst = load(f)
    a, b = best_lap_range(dst)
    span = dst[b - 1] - dst[a]
    pts = to_metres(lat[a:b], lon[a:b])
    eps = max(2.0, span / 3000.0)
    simp = rdp(pts, eps)
    if simp[0] != simp[-1]:
        simp = simp[:-1]
    open(os.path.join(OUT, f"{key}.svg"), "w").write(build_svg(key, simp))
    print(f"{key:11} {layout:42} samples={n:6} lap={span:7.0f}m pts={len(pts)}->{len(simp)}")
