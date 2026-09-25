"""AM7's executive desk ("command arc") and chair.

Seat contract (same as a workstation): origin = chair centre = seated
character root on the floor, the sitter faces -Y, desk top at 0.75 m, desk
front edge at y = -0.36 on the centre line, keyboard at (0, -0.5, 0.765),
mouse at (-0.3, -0.5, 0.765), seat top at 0.47.

The desk is a C sweeping round the chair (its arc centred behind the sitter):
a 75 mm piano-black top with a bullnose edge split by a thin red light seam, a
brushed waist band whose hidden red underglow washes a reeded satin-black
modesty wall, reeded pods under both ends, and one large curved monitor on a
sculpted post. The monitor's display is the "screen_exec" material with UVs
0..1 (u from the sitter's left, v up). Plan extent: x within +-1.57 m,
y from -1.15 (the far edge) to +0.12 (the end pods beside the chair), so the
sitter walks in from behind the chair, between the pods.

The chair is a high-back executive chair: channel-quilted black leather with
red piping, a tapered gloss shell with wings and a headrest, a brushed rear
spine and a black-chrome star base; a thin red light line traces the shell,
the seat pan and the armrests.
"""

import math

import bmesh
from mathutils import Matrix, Vector

import props_lib
from props_lib import Prop, _autosharp, _new_bm

PI = math.pi
TOP = 0.75


# --- geometry helpers (bmesh in prop-local metres; Prop.merge places them) ---------------
def rrect2d(w, h, r, segs=6, cx=0.0, cy=0.0):
    """Counter-clockwise rounded rectangle as (x, y, nx, ny) with outward normals."""
    r = max(1e-4, min(r, w / 2 - 1e-4, h / 2 - 1e-4))
    hw, hh = w / 2 - r, h / 2 - r
    pts = []
    for ox, oy, a0 in ((hw, hh, 0), (-hw, hh, 90), (-hw, -hh, 180), (hw, -hh, 270)):
        for k in range(segs + 1):
            a = math.radians(a0 + 90 * k / segs)
            c, s = math.cos(a), math.sin(a)
            pts.append((cx + ox + r * c, cy + oy + r * s, c, s))
    return pts


def _reeds(length, pitch, amp):
    """Convex reeds (half-round ribs with crisp valleys) along a run of `length`."""
    count = max(1, round(length / pitch))
    pitch = length / count

    def f(s):
        t = (s / pitch) % 1.0
        return amp * math.sin(PI * t)

    return f, count


def circle2d(r, n=64, cx=0.0, cy=0.0, reed=None):
    pts = []
    f = None
    if reed:
        f, count = _reeds(2 * PI * r, *reed)
        n = count * 6
    for k in range(n):
        a = 2 * PI * k / n
        c, s = math.cos(a), math.sin(a)
        rr = r + (f(a * r) if f else 0.0)
        pts.append((cx + rr * c, cy + rr * s, c, s))
    return pts


def arc_stadium(C, r_in, r_out, a0, a1, n_arc=160, n_cap=20, n_inner=None, reed=None):
    """A bent stadium: annular sector between r_in and r_out from angle a0 to a1
    (radians, CCW) with fully rounded ends. Optional reeds on the outer arc."""
    cx, cy = C
    rm, rc = (r_in + r_out) / 2, (r_out - r_in) / 2
    f = None
    if reed:
        f, count = _reeds(r_out * (a1 - a0), *reed)
        n_arc = count * 6
    pts = []
    for i in range(n_arc):
        a = a0 + (a1 - a0) * i / n_arc
        c, s = math.cos(a), math.sin(a)
        rr = r_out + (f(r_out * (a - a0)) if f else 0.0)
        pts.append((cx + rr * c, cy + rr * s, c, s))
    pcx, pcy = cx + rm * math.cos(a1), cy + rm * math.sin(a1)
    for j in range(n_cap):
        ph = a1 + PI * j / n_cap
        pts.append((pcx + rc * math.cos(ph), pcy + rc * math.sin(ph), math.cos(ph), math.sin(ph)))
    ni = n_inner or max(24, n_arc // 2)
    for i in range(ni):
        a = a1 - (a1 - a0) * i / ni
        c, s = math.cos(a), math.sin(a)
        pts.append((cx + r_in * c, cy + r_in * s, -c, -s))
    pcx, pcy = cx + rm * math.cos(a0), cy + rm * math.sin(a0)
    for j in range(n_cap):
        ph = a0 + PI + PI * j / n_cap
        pts.append((pcx + rc * math.cos(ph), pcy + rc * math.sin(ph), math.cos(ph), math.sin(ph)))
    return pts


def inset(outline, d):
    return [(x - nx * d, y - ny * d, nx, ny) for x, y, nx, ny in outline]


def sweep_closed(outline, profile, cap_bottom=True, cap_top=True, sharp=38.0):
    """Sweep an (inset, z) edge profile round a closed CCW plan outline.

    Every ring is the outline offset inward by `inset` at height z. The profile
    runs from the bottom face up the edge to the top face; caps are flat ngons
    with hard edges so large glossy tops shade cleanly."""
    bm = _new_bm()
    uvl = bm.loops.layers.uv.active
    rings = [[bm.verts.new((x - nx * i, y - ny * i, z)) for x, y, nx, ny in outline] for i, z in profile]
    n = len(outline)
    for a, b in zip(rings, rings[1:]):
        for k in range(n):
            k2 = (k + 1) % n
            bm.faces.new((a[k], a[k2], b[k2], b[k]))
    caps = []
    if cap_bottom:
        caps.append(bm.faces.new(list(reversed(rings[0]))))
    if cap_top:
        caps.append(bm.faces.new(rings[-1]))
    for f in bm.faces:
        for lp in f.loops:
            lp[uvl].uv = (lp.vert.co.x, lp.vert.co.y)
    _autosharp(bm, sharp)
    for f in caps:
        for e in f.edges:
            e.smooth = False
    return bm


def sweep_arc(C, R, a0, a1, n, prof, caps=True, closed=True, sharp=50.0):
    """Sweep a (dr, z) cross-section along a horizontal arc of radius R round C."""
    bm = _new_bm()
    rings = []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n
        c, s = math.cos(a), math.sin(a)
        rings.append([bm.verts.new((C[0] + (R + dr) * c, C[1] + (R + dr) * s, z)) for dr, z in prof])
    m = len(prof)
    for A, B in zip(rings, rings[1:]):
        for k in range(m if closed else m - 1):
            k2 = (k + 1) % m
            bm.faces.new((A[k], A[k2], B[k2], B[k]))
    if caps and closed:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    _autosharp(bm, sharp)
    return bm


def loft(centers, sides, ups, profiles, sharp=45.0):
    """Closed loft through cross-sections (lists of (u, v)) placed at centers."""
    bm = _new_bm()
    rings = []
    for c, sd, up, prof in zip(centers, sides, ups, profiles):
        rings.append([bm.verts.new(c + sd * u + up * v) for u, v in prof])
    m = len(profiles[0])
    for A, B in zip(rings, rings[1:]):
        for k in range(m):
            k2 = (k + 1) % m
            bm.faces.new((A[k], A[k2], B[k2], B[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    _autosharp(bm, sharp)
    return bm


def to_xz(bm, y=0.0):
    """Stand a plan-built mesh up: (x, y, z) -> (x, y0 + z, y). Outline in XZ,
    thickness along +Y."""
    bm.transform(Matrix(((1, 0, 0, 0), (0, 0, 1, y), (0, 1, 0, 0), (0, 0, 0, 1))))
    bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
    return bm


def moved(bm, loc=(0, 0, 0), rot=None, scale=None):
    bm.transform(props_lib.xform(loc, rot, scale))
    return bm


def rbox_bm(size, loc=(0, 0, 0), **kw):
    """props_lib's rounded upholstery box as a free bmesh (so it can be bent)."""
    tmp = Prop("_tmp")
    tmp.rbox("leather", size, loc, **kw)
    return tmp.bms.pop("leather")


def uv_sphere(r, loc, scale=(1, 1, 1), segs=32, rings=16):
    bm = _new_bm()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=r)
    bm.transform(props_lib.xform(loc, None, scale))
    for f in bm.faces:
        f.smooth = True
    return bm


def ribbon_closed(outline, z0, z1, out=0.0008):
    """Thin light line (vertical band) just proud of a swept surface."""
    return sweep_closed(outline, [(-out, z0), (-out, z1)], cap_bottom=False, cap_top=False)


def flat_ring(outline, z, width):
    return sweep_closed(outline, [(0.0, z), (width, z)], cap_bottom=False, cap_top=False)


def arc_band(C, R, pa, pb, z0, z1, n):
    """Display strip on the concave face of an arc; u runs from the viewer's
    left (the arc's end at pb) to the right, v from bottom to top."""
    bm = _new_bm()
    uvl = bm.loops.layers.uv.active
    cols = []
    for i in range(n + 1):
        a = pb - (pb - pa) * i / n
        c, s = math.cos(a), math.sin(a)
        cols.append((bm.verts.new((C[0] + R * c, C[1] + R * s, z0)), bm.verts.new((C[0] + R * c, C[1] + R * s, z1)),
                     i / n))
    for (a0, a1, ua), (b0, b1, ub) in zip(cols, cols[1:]):
        f = bm.faces.new((a0, b0, b1, a1))
        for lp, uv in zip(f.loops, ((ua, 0.0), (ub, 0.0), (ub, 1.0), (ua, 1.0))):
            lp[uvl].uv = uv
        f.smooth = True
    return bm


# --- chair ------------------------------------------------------------------------------
WRAP = 0.3  # back wrap: y -= WRAP * x^2 in the back frame


def _wrap(bm, k=WRAP):
    for v in bm.verts:
        v.co.y -= k * v.co.x ** 2
    return bm


def exec_chair(p):
    """Premium high-back executive chair. Seat top 0.47, seat centre y = 0,
    backrest from y = +0.235 reclined 10 degrees, faces -Y."""
    # five-star base in black chrome, sculpted tapering spokes, twin casters
    hub_z = 0.11
    p.lathe("chrome_dark", [(0.0, hub_z - 0.03), (0.058, hub_z - 0.03), (0.064, hub_z - 0.01),
                            (0.058, hub_z + 0.025), (0.0, hub_z + 0.03)], segs=32, true_poles=True)
    Z = Vector((0, 0, 1))
    for i in range(5):
        a = PI / 2 + 2 * PI * i / 5
        d = Vector((math.cos(a), math.sin(a), 0.0))
        side = Vector((-math.sin(a), math.cos(a), 0.0))
        cs, profs = [], []
        n = 8
        for k in range(n + 1):
            t = k / n
            rad = 0.045 + 0.305 * t
            z = hub_z - 0.038 * t ** 1.5
            w, h = 0.062 - 0.026 * t, 0.042 - 0.016 * t
            cs.append(d * rad + Z * z)
            profs.append([(u, v) for u, v, _, _ in rrect2d(w, h, min(w, h) * 0.42, 3)])
        p.merge("chrome_dark", loft(cs, [side] * (n + 1), [Z] * (n + 1), profs))
        tip = d * 0.36
        p.rbox("black_gloss", (0.055, 0.034, 0.04), (tip.x, tip.y, 0.066), r=0.013, rot=(0, 0, a), steps=2)
        for s in (-1, 1):
            wc = tip + d * 0.012 + side * (s * 0.0115)
            p.cyl("black_gloss", 0.029, 0.014, (wc.x, wc.y, 0.031), rot=(PI / 2, 0, a + PI), segs=16)
    # gas column: gloss shroud and black-chrome piston; tilt mechanism
    p.lathe("black_gloss", [(0.0, 0.12), (0.042, 0.12), (0.038, 0.2), (0.031, 0.275), (0.0, 0.275)],
            segs=28, true_poles=True)
    p.cyl("chrome_dark", 0.021, 0.1, (0, 0, 0.32), segs=20)
    p.box("metal_dark", (0.22, 0.27, 0.04), (0, 0.04, 0.372), bevel=0.01)
    p.box("chrome_dark", (0.1, 0.016, 0.008), (-0.16, -0.03, 0.372), rot=(0, 0, 0.35), bevel=0.003)

    # seat: gloss pan, four quilted channels, raised side bolsters
    p.slab("black_gloss", 0.6, 0.56, 0.035, (0, 0.01, 0.405), corner=0.1, csegs=8, bevel=0.01)
    p.merge("emissive_red", ribbon_closed(rrect2d(0.6, 0.56, 0.1, 8, 0, 0.01), 0.3975, 0.4005))
    for x in (-0.162, -0.054, 0.054, 0.162):
        p.rbox("leather", (0.106, 0.5, 0.06), (x, 0.0, 0.437), r=0.026, steps=2, splits=(1, 4, 0),
               bulge=(0.0, 0.0, 0.008))
    for sx in (-1, 1):
        p.rbox("leather", (0.07, 0.52, 0.085), (sx * 0.253, 0.005, 0.449), r=0.03, steps=2, splits=(0, 4, 1),
               bulge=(0.004, 0.0, 0.006))
    for x in (-0.216, -0.108, 0.0, 0.108, 0.216):
        p.tube("stitch", [(x, -0.238, 0.452), (x, 0.238, 0.452)], 0.0022, segs=5)

    # back: tapered gloss shell wrapping quilted channels, wings, headrest and a
    # brushed spine on the rear with a red light line
    H, TAPER = 1.0, 0.14

    def tw(z):
        return 1.0 - TAPER * z / H

    with p.frame((0, 0.235, 0.44), (-0.175, 0, 0)):
        outline = [(x * tw(y), y, nx, ny) for x, y, nx, ny in rrect2d(0.64, H, 0.15, 8, 0, H / 2)]
        shell = sweep_closed(outline, [(0.014, 0.0), (0.004, 0.003), (0.0, 0.012), (0.0, 0.038),
                                       (0.004, 0.047), (0.014, 0.05)], sharp=50)
        p.merge("black_gloss", _wrap(to_xz(shell, 0.02)))
        p.merge("emissive_red", _wrap(to_xz(ribbon_closed(outline, 0.023, 0.027, out=0.0012), 0.02)))
        ch_h, z_base = 0.112, 0.035
        for i in range(6):
            zc = z_base + (i + 0.5) * ch_h
            p.merge("leather", _wrap(rbox_bm((0.5 * tw(zc), 0.075, ch_h - 0.002), (0, -0.018, zc), r=0.03,
                                             steps=2, splits=(6, 0, 1), bulge=(0.0, 0.012, 0.0))))
        for i in range(1, 6):
            zs = z_base + i * ch_h
            hw = 0.235 * tw(zs)
            xs = [-hw + 2 * hw * k / 10 for k in range(11)]
            p.tube("stitch", [(x, -0.05 - WRAP * x * x, zs) for x in xs], 0.0022, segs=5)
        for sx in (-1, 1):
            zc = 0.39
            wing = rbox_bm((0.075, 0.12, 0.72), r=0.032, steps=2, splits=(0, 1, 4), bulge=(0.006, 0.006, 0.0))
            p.merge("leather", _wrap(moved(wing, (sx * 0.282 * tw(zc), -0.03, zc), (0.0, sx * 0.04, -sx * 0.32))))
        p.merge("leather", _wrap(rbox_bm((0.4, 0.095, 0.15), (0, -0.022, 0.85), r=0.04, steps=2,
                                         splits=(4, 0, 1), bulge=(0.0, 0.014, 0.0))))
        xs = [-0.17 + 0.34 * k / 8 for k in range(9)]
        p.tube("stitch", [(x, -0.071 - WRAP * x * x, 0.85) for x in xs], 0.0022, segs=5)
        # rear: a leather panel inset in the gloss rim
        rear = inset(outline, 0.028)
        p.merge("leather", _wrap(to_xz(sweep_closed(rear, [(0.012, 0.0), (0.003, 0.004), (0.0, 0.01),
                                                           (0.0, 0.012)], sharp=60), 0.063)))
        spine = rrect2d(0.1, 0.84, 0.05, 6, 0, 0.45)
        p.merge("metal_brushed", _wrap(to_xz(sweep_closed(spine, [(0.006, 0.0), (0.0, 0.005), (0.0, 0.016),
                                                                  (0.004, 0.02)]), 0.074)))
        p.box("emissive_red", (0.005, 0.003, 0.68), (0, 0.0955, 0.45), bevel=0.0)
    # bar from the mechanism up to the spine plate
    p.tube("chrome_dark", [(0, 0.15, 0.372), (0, 0.28, 0.378), (0, 0.33, 0.42), (0, 0.345, 0.5)], 0.02, segs=12)

    # armrests: black-chrome loop, gloss under-plate, leather pad, red edge line
    for sx in (-1, 1):
        x = sx * 0.335
        p.tube("chrome_dark", [(sx * 0.1, 0.08, 0.37), (sx * 0.3, 0.08, 0.372), (x, 0.08, 0.41),
                               (x, 0.07, 0.56), (x, 0.05, 0.614)], 0.014, segs=10)
        p.box("black_gloss", (0.078, 0.28, 0.012), (x, 0.0, 0.618), bevel=0.004)
        p.rbox("leather", (0.085, 0.3, 0.034), (x, 0.0, 0.64), r=0.015, steps=2, splits=(0, 3, 0),
               bulge=(0.0, 0.0, 0.004))
        p.tube("stitch", [(x - 0.03, -0.14, 0.655), (x - 0.03, 0.14, 0.655)], 0.0016, segs=5)
        p.box("emissive_red", (0.002, 0.26, 0.003), (x + sx * 0.0405, 0.0, 0.618), bevel=0.0)


# --- desk ---------------------------------------------------------------------------------
A_C = (0.0, 0.9)          # arc centre, behind the sitter
A_RIN = 0.9 + 0.36        # front edge passes y = -0.36 at the centre line
A_ROUT = A_RIN + 0.78
A_SPAN = math.radians(45)
MON_C, MON_R = (0.0, -0.05), 0.95   # the monitor's arc: 1000R-like curve round the eyes
MON_W, MON_Z = 1.5, (0.855, 1.275)  # arc length of the panel, bottom and top


def _desk_set(p, pad=(0.86, 0.36), pad_y=-0.565):
    pw, pd = pad
    p.slab("leather", pw, pd, 0.005, (0, pad_y, TOP + 0.0025), corner=0.03, csegs=5, bevel=0.0015)
    p.merge("stitch", flat_ring(rrect2d(pw - 0.026, pd - 0.026, 0.018, 5, 0, pad_y), TOP + 0.0053, 0.0016))
    # low-profile keyboard: brushed frame, gloss caps, red underglow
    p.slab("metal_brushed", 0.44, 0.145, 0.012, (0, -0.5, TOP + 0.011), corner=0.012, csegs=3, bevel=0.002)
    p.box("emissive_red_soft", (0.42, 0.126, 0.001), (0, -0.5, TOP + 0.0175), bevel=0.0)
    for r in range(5):
        y = -0.5 - 0.049 + r * 0.0245
        if r == 4:
            cols = [(-0.19 + c * 0.0272, 0.0245) for c in range(4)] + [(0.0, 0.16)] + \
                   [(0.19 - c * 0.0272, 0.0245) for c in range(4)]
        else:
            cols = [(-0.19 + c * 0.0272, 0.0245) for c in range(15)]
        for x, w in cols:
            p.box("black_gloss", (w, 0.0222, 0.0065), (x, y, TOP + 0.0205), bevel=0.0018)
    p.merge("black_gloss", uv_sphere(1.0, (-0.3, -0.5, TOP + 0.0075), (0.031, 0.056, 0.019), segs=20, rings=10))
    p.box("emissive_red", (0.002, 0.03, 0.002), (-0.3, -0.52, TOP + 0.026), bevel=0.0)


def _cup(p, x, y):
    p.lathe("black_satin", [(0.0, 0.0), (0.075, 0.0), (0.078, 0.004), (0.06, 0.008), (0.0, 0.008)],
            loc=(x, y, TOP), segs=28, true_poles=True)
    p.lathe("black_satin", [(0.0, 0.008), (0.028, 0.008), (0.04, 0.03), (0.043, 0.085), (0.039, 0.085),
                            (0.036, 0.03), (0.0, 0.03)], loc=(x, y, TOP), segs=28, true_poles=True)
    p.tube("black_satin", [(x + 0.042, y, TOP + 0.075), (x + 0.066, y, TOP + 0.07), (x + 0.07, y, TOP + 0.05),
                           (x + 0.06, y, TOP + 0.035), (x + 0.042, y, TOP + 0.035)], 0.005, segs=8)


def _tablet(p, x, y, rot):
    with p.frame((x, y, TOP), (0, 0, rot)):
        p.slab("black_gloss", 0.18, 0.26, 0.007, (0, 0, 0.0035), corner=0.014, csegs=4, bevel=0.0015)
        p.box("emissive_red_dim", (0.165, 0.245, 0.0005), (0, 0, 0.0071), bevel=0.0)
        p.tube("chrome_dark", [(0.12, -0.11, 0.006), (0.12, 0.1, 0.006)], 0.0045, segs=8)


def exec_desk(p):
    a0, a1 = -PI / 2 - A_SPAN, -PI / 2 + A_SPAN
    ol = arc_stadium(A_C, A_RIN, A_ROUT, a0, a1, n_arc=140, n_cap=20, n_inner=100)
    # 75 mm piano-black top with a soft bullnose; red seam at the nose
    p.merge("black_gloss", sweep_closed(ol, [(0.03, 0.672), (0.013, 0.676), (0.004, 0.687), (0.0, 0.703),
                                             (0.0, 0.722), (0.004, 0.736), (0.012, 0.746), (0.026, 0.75)]))
    p.merge("emissive_red", ribbon_closed(ol, 0.7115, 0.7143))
    # brushed waist band; its red light faces down and washes the reeds below
    p.merge("metal_brushed", sweep_closed(ol, [(0.046, 0.6), (0.046, 0.674)]))
    p.merge("emissive_red_soft", flat_ring(inset(ol, 0.05), 0.5995, 0.012))
    # sculpted base: reeded modesty wall under the outer arc, reeded pods under both ends
    rm = (A_RIN + A_ROUT) / 2
    wall = arc_stadium(A_C, A_ROUT - 0.36, A_ROUT - 0.2, a0 + math.radians(5), a1 - math.radians(5),
                       n_cap=10, n_inner=70, reed=(0.034, 0.0065))
    base_prof = [(0.02, 0.045), (0.006, 0.075), (0.0, 0.13), (0.0, 0.6)]
    p.merge("black_satin", sweep_closed(wall, base_prof))
    p.merge("black_matte", sweep_closed(wall, [(0.045, 0.0), (0.045, 0.046)]))
    p.merge("emissive_red_soft", ribbon_closed(inset(wall, 0.03), 0.03, 0.034))
    for a in (a0, a1):
        cx, cy = A_C[0] + rm * math.cos(a), A_C[1] + rm * math.sin(a)
        p.merge("black_satin", sweep_closed(circle2d(0.26, cx=cx, cy=cy, reed=(0.034, 0.0065)), base_prof))
        plain = circle2d(0.26, 72, cx, cy)
        p.merge("black_matte", sweep_closed(plain, [(0.045, 0.0), (0.045, 0.046)]))
        p.merge("emissive_red_soft", ribbon_closed(inset(plain, 0.03), 0.03, 0.034))

    # one large curved monitor round the sitter's eyes, on a sculpted post
    z0, z1 = MON_Z
    th = 0.024
    span = MON_W / MON_R
    pa, pb = -PI / 2 - span / 2, -PI / 2 + span / 2
    body = [(u, v) for u, v, _, _ in rrect2d(th, z1 - z0, 0.008, 3, th / 2, (z0 + z1) / 2)]
    p.merge("black_gloss", sweep_arc(MON_C, MON_R, pa, pb, 64, body))
    bezel = 0.008 / MON_R
    p.merge("screen_exec", arc_band(MON_C, MON_R - 0.0008, pa + bezel, pb - bezel, z0 + 0.008, z1 - 0.008, 64))
    # a thin red light line along the back of the chin
    p.merge("emissive_red", sweep_arc(MON_C, MON_R, pa + 0.03, pb - 0.03, 48,
                                      [(th + 0.0009, z0 + 0.028), (th + 0.0009, z0 + 0.032)], caps=False,
                                      closed=False))
    # brushed spine across the back and a central post down to an oval foot
    spine = [(u, v) for u, v, _, _ in rrect2d(0.024, 0.055, 0.01, 3, 0.0, 1.05)]
    p.merge("metal_brushed", sweep_arc(MON_C, MON_R + th + 0.03, -PI / 2 - span * 0.3, -PI / 2 + span * 0.3,
                                       32, spine))
    py = MON_C[1] - (MON_R + th + 0.03)
    p.box("metal_dark", (0.16, 0.05, 0.1), (0, py + 0.02, 1.05), bevel=0.008)
    p.lathe("metal_brushed", [(0.0, TOP), (0.12, TOP), (0.12, TOP + 0.006), (0.108, TOP + 0.012),
                              (0.045, TOP + 0.026), (0.032, 0.9), (0.03, 1.04), (0.0, 1.04)],
            loc=(0, py, 0), scale=(1, 0.55, 1), segs=36, true_poles=True)
    p.lathe("emissive_red", [(0.1215, TOP + 0.0045), (0.1215, TOP + 0.0065)], loc=(0, py, 0), scale=(1, 0.55, 1),
            segs=36)

    _desk_set(p)
    _cup(p, -0.86, -0.4)
    _tablet(p, 0.66, -0.62, 0.3)
    # AI core orb on a black-chrome ring (right wing)
    ox, oy = 1.02, -0.5
    p.lathe("chrome_dark", [(0.0, TOP), (0.05, TOP), (0.052, TOP + 0.004), (0.046, TOP + 0.018),
                            (0.0, TOP + 0.018)], loc=(ox, oy, 0), segs=32, true_poles=True)
    p.merge("black_gloss", uv_sphere(0.058, (ox, oy, TOP + 0.07), segs=32, rings=16))
    p.merge("emissive_red", ribbon_closed(circle2d(0.058, 48, ox, oy), TOP + 0.068, TOP + 0.072, out=0.0006))
