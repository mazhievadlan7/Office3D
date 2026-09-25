"""Sculpted android head, neck and hooded top, used by body.build_body.
"""

import math

from mathutils import Vector

from body import frame_from_axis, smooth01


def _dense(n, t0, b):
    """n+1 samples of 0..1, denser around t0 by a factor 1/(1-b)."""
    h0 = -b * math.sin(2 * math.pi * (0 - t0)) / (2 * math.pi)
    out = [i / n - b * math.sin(2 * math.pi * (i / n - t0)) / (2 * math.pi) - h0 for i in range(n + 1)]
    lo, hi = out[0], out[-1]
    return [(v - lo) / (hi - lo) for v in out]


def _grid(mb, thetas, phis, point, weights, region, keep=None):
    """A surface closed in phi over a (theta, phi) grid of unit directions."""
    grid = []
    for th in thetas:
        row = []
        for ph in phis:
            d = Vector((math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)))
            row.append((mb.v(point(d), weights(d) if callable(weights) else weights), d))
        grid.append(row)
    n = len(phis)
    for i in range(len(thetas) - 1):
        for j in range(n):
            j2 = (j + 1) % n
            quad = (grid[i][j], grid[i + 1][j], grid[i + 1][j2], grid[i][j2])
            dmid = sum((q[1] for q in quad), Vector()) / 4
            if keep and not keep(dmid):
                continue
            mb.f(tuple(q[0] for q in quad), region)


def _g(u, w, u0, w0, su, sw):
    return math.exp(-(((u - u0) / su) ** 2) - (((w - w0) / sw) ** 2))


HEAD_C = Vector((0, -0.004, 1.672))
HEAD_R = (0.079, 0.097, 0.117)


def head_point(d):
    """The face is carved with displacement fields in the direction domain:
    u = d.x across the face, w = d.z up, f = -d.y toward the front."""
    u, w, f = d.x, d.z, -d.y
    p = Vector((d.x * HEAD_R[0], d.y * HEAD_R[1], d.z * HEAD_R[2]))
    if d.y > 0:
        p.y *= 1.06  # fuller back of the skull
    else:
        p.y *= 1 - 0.1 * f  # flatter face plane
    if w > 0.6:
        p.z *= 1 - 0.05 * (w - 0.6) / 0.4
    p.x *= 1 - 0.27 * smooth01((0.05 - w) / 0.85)  # jaw narrows to the chin
    au = abs(u)
    front = smooth01((f - 0.3) / 0.35)
    fwd = 0.010 * math.exp(-(((w - 0.21) / 0.055) ** 2)) * (1 - smooth01((au - 0.34) / 0.2))  # brow ridge
    fwd -= 0.003 * _g(u, w, 0, 0.2, 0.07, 0.06)  # glabella
    fwd -= 0.012 * _g(au, w, 0.33, 0.1, 0.12, 0.07)  # eye sockets
    fwd += 0.010 * _g(u, w, 0, 0.0, 0.05, 0.15)  # nose bridge
    fwd += 0.020 * _g(u, w, 0, -0.2, 0.07, 0.085)  # nose
    fwd += 0.007 * _g(u, w, 0, -0.25, 0.04, 0.04)  # nose tip
    fwd += 0.007 * _g(au, w, 0.09, -0.27, 0.05, 0.04)  # nostril wings
    fwd -= 0.004 * _g(u, w, 0, -0.34, 0.06, 0.03)  # under the nose
    fwd += 0.009 * _g(u, w, 0, -0.42, 0.16, 0.04)  # upper lip
    fwd -= 0.007 * _g(u, w, 0, -0.475, 0.17, 0.02)  # mouth line
    fwd += 0.008 * _g(u, w, 0, -0.53, 0.14, 0.035)  # lower lip
    fwd += 0.013 * _g(u, w, 0, -0.73, 0.14, 0.12)  # chin
    fwd += 0.007 * _g(au, w, 0.5, -0.05, 0.14, 0.1)  # cheekbones
    fwd -= 0.006 * _g(au, w, 0.45, -0.38, 0.14, 0.13)  # cheek hollows
    p.y -= fwd * front
    side = math.copysign(1.0, u) if au > 1e-6 else 0.0
    p.x += side * (0.004 * _g(au, w, 0.55, -0.05, 0.15, 0.1) - 0.004 * _g(au, w, 0.62, 0.22, 0.1, 0.15))
    return HEAD_C + p


def add_head(mb):
    thetas = [math.pi * t for t in _dense(44, 0.555, 0.7)]
    phis = [-math.pi / 2 + 2 * math.pi * (t - 0.5) for t in _dense(56, 0.5, 0.72)[:-1]]
    _grid(mb, thetas, phis, head_point, {"Head": 1.0}, "metal")

    # Eyes: glowing red globes set into the sockets, with a white-hot core.
    for side in (1, -1):
        dd = Vector((0.33 * side, 0.0, 0.1))
        dd.y = -math.sqrt(1 - dd.x * dd.x - dd.z * dd.z)
        centre = head_point(dd) + Vector((0, 0.0035, 0))
        mb.ellipsoid(centre, (0.0118, 0.0105, 0.0105), {"Head": 1.0}, "eyes", segs=14, rings=8)
        mb.ellipsoid(centre + Vector((0, -0.0098, 0)), (0.0036, 0.0022, 0.0036), {"Head": 1.0}, "eyecore", segs=10, rings=6)

    # Ear modules: a disc, a red ring and a raised cap.
    for side in (1, -1):
        c = Vector((0.074 * side, 0.004, 1.667))
        axis = Vector((side, 0, 0))
        fr = frame_from_axis(axis, Vector((0, -1, 0)))
        mb.loft([
            (c, fr, 0.029, 0.029, {"Head": 1.0}, 2.0),
            (c + axis * 0.009, fr, 0.03, 0.03, {"Head": 1.0}, 2.0),
            (c + axis * 0.013, fr, 0.027, 0.027, {"Head": 1.0}, 2.0),
        ], "joint", segs=20, cap_end=True)
        mb.loft([
            (c + axis * 0.0135, fr, 0.0205, 0.0205, {"Head": 1.0}, 2.0),
            (c + axis * 0.0145, fr, 0.0205, 0.0205, {"Head": 1.0}, 2.0),
        ], "accent", segs=20)
        mb.loft([
            (c + axis * 0.012, fr, 0.017, 0.017, {"Head": 1.0}, 2.0),
            (c + axis * 0.017, fr, 0.016, 0.016, {"Head": 1.0}, 2.0),
        ], "metal", segs=16, cap_end=True)

    # Mechanical neck: a core, a throat piston and two cables.
    from mathutils import Matrix

    Z = Matrix(((1, 0, 0), (0, 1, 0), (0, 0, 1)))
    mb.loft([
        (Vector((0, 0.01, 1.46)), Z, 0.042, 0.04, {"Neck": 1.0}, 2.0),
        (Vector((0, 0.01, 1.53)), Z, 0.036, 0.035, {"Neck": 1.0}, 2.0),
        (Vector((0, 0.008, 1.6)), Z, 0.034, 0.034, {"Neck": 0.3, "Head": 0.7}, 2.0),
    ], "joint", segs=14)
    for x, r, reg in ((0.0, 0.009, "metal"), (0.022, 0.0055, "joint"), (-0.022, 0.0055, "joint")):
        top = Vector((x * 0.8, -0.036, 1.6))
        bot = Vector((x, -0.04, 1.47))
        fr = frame_from_axis((top - bot).normalized())
        mb.loft([
            (bot, fr, r, r, {"Neck": 1.0}, 2.0),
            (bot.lerp(top, 0.5), fr, r, r, {"Neck": 1.0}, 2.0),
            (top, fr, r, r, {"Neck": 0.3, "Head": 0.7}, 2.0),
        ], reg, segs=8, cap_start=True, cap_end=True)


HOOD_C = Vector((0, 0.022, 1.686))
HOOD_R = (0.116, 0.132, 0.146)
# Face opening: an ellipse in the (d.x, d.z) direction plane on the front.
OPEN_X, OPEN_Z, OPEN_Z0 = 0.68, 0.7, 0.1


def hood_weights(d):
    s = smooth01((-0.1 - d.z) / 0.7)
    return {"Head": 1 - s, "Neck": s * 0.45, "Spine2": s * 0.55}


def hood_point(d):
    p = Vector((d.x * HOOD_R[0], d.y * HOOD_R[1], d.z * HOOD_R[2]))
    # Soft peak at the top-back, like a real hood's seam.
    if d.z > 0.2 and d.y > -0.1:
        k = (d.z - 0.2) * (d.y + 0.1)
        p.z += 0.03 * k
        p.y += 0.03 * k
    # The lower back drapes over the shoulders with soft folds.
    if d.z < -0.1:
        k = -0.1 - d.z
        p.z -= 0.075 * k
        p.x *= 1 + 0.14 * k
        if d.y > 0:
            p.y += 0.035 * k
            p.x += 0.006 * math.sin(d.x * 9.0) * k
    # The front edge comes forward a little so the face sits in its shadow.
    if d.y < -0.2:
        p.y -= 0.014 * min(1.0, (-0.2 - d.y) / 0.4)
    return HOOD_C + p


def _in_opening(d):
    return d.y < 0 and (d.x / OPEN_X) ** 2 + ((d.z - OPEN_Z0) / OPEN_Z) ** 2 < 1.0


def add_hood(mb):
    thetas = [math.pi * t for t in _dense(30, 0.5, 0.3)]
    phis = [2 * math.pi * t for t in _dense(44, 0.75, 0.4)[:-1]]
    _grid(mb, thetas, phis, hood_point, hood_weights, "hoodie", keep=lambda d: not _in_opening(d) and d.z > -0.82)

    # Rolled rim around the face opening (also hides the stepped cut).
    n = 48
    pts = []
    for i in range(n + 1):
        a = 2 * math.pi * i / n
        dx = OPEN_X * math.cos(a) * 0.985
        dz = OPEN_Z0 + OPEN_Z * math.sin(a) * 0.985
        d = Vector((dx, -math.sqrt(max(0.0, 1 - dx * dx - dz * dz)), dz)).normalized()
        pts.append((hood_point(d), hood_weights(d)))
    rings = []
    for i, (p, wts) in enumerate(pts):
        tangent = (pts[min(i + 1, n)][0] - pts[max(i - 1, 0)][0]).normalized()
        rings.append((p, frame_from_axis(tangent), 0.0075, 0.006, wts, 2.0))
    mb.loft(rings, "hoodie", segs=8)

    # Centre seam from the front top over the back.
    seam = [Vector((0, -math.cos(math.radians(a)), math.sin(math.radians(a)))) for a in range(40, 171, 10)]
    rings = []
    for i, d in enumerate(seam):
        tangent = (hood_point(seam[min(i + 1, len(seam) - 1)]) - hood_point(seam[max(i - 1, 0)])).normalized()
        rings.append((hood_point(d) + d * 0.002, frame_from_axis(tangent), 0.004, 0.004, hood_weights(d), 2.0))
    mb.loft(rings, "hoodie", segs=6)

    # Drawstrings with red metal aglets.
    for side in (1, -1):
        top = Vector((0.036 * side, -0.108, 1.505))
        bot = Vector((0.04 * side, -0.132, 1.34))
        axis = (bot - top).normalized()
        fr = frame_from_axis(axis)
        rings = []
        for i in range(6):
            t = i / 5
            p = top.lerp(bot, t) + Vector((0, -0.01 * math.sin(t * math.pi), 0))
            rings.append((p, fr, 0.0042, 0.0042, {"Spine2": 1.0}, 2.0))
        mb.loft(rings, "hoodie", segs=6)
        mb.loft([
            (bot, fr, 0.0052, 0.0052, {"Spine2": 1.0}, 2.0),
            (bot + axis * 0.026, fr, 0.0052, 0.0052, {"Spine2": 1.0}, 2.0),
        ], "accent", segs=6, cap_end=True)
