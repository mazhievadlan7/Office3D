"""AM7, the lead agent: the android in a black two-piece suit.

A second skinned mesh on the regular skeleton (rig.py), exported next to the
hooded body in hacker.glb as the node "AM7", with the same material: the
texture atlas of body.py gains six blocks (extend_atlas) for the suit cloth,
shirt, lapel satin, shoe leather, hair and the red accent line.

  * the sculpted android head and robot hands from head.py / body.py,
  * a glossy black military haircut (sides and back short, the top combed over
    to the right from a part on the left), rigid to Head,
  * a tailored jacket (peak satin lapels, collar, two buttons, flap pockets,
    breast pocket), a black turtleneck and creased straight trousers, skinned
    to the spine / arm / leg chain like the hoodie and pants,
  * polished dress shoes, rigid to Foot / ToeBase,
  * thin red accents: lightning zigzags on the lapels, cuffs and down the
    trouser side seams, a lightning-bolt lapel pin, a red pocket square and a
    red line on the shoe welt (variant "B"; variant "A" is plain piping).

Preview: blender/hacker/tools/lead_concepts.py renders it in a studio.
"""

import math

from mathutils import Matrix, Vector

import body
import head
from body import MeshBuilder, frame_from_axis, lerp_w, smooth01
from rig import UPPER_ARM, _arm_dir, head_of, tail_of

SIDES = ((1, "Left"), (-1, "Right"))
Z3 = Matrix.Identity(3)

# --- atlas: six more flat-colour blocks (16 max) ------------------------------
# name: (base rgb linear, roughness, metallic, emission rgb linear)
EXTRA_REGIONS = {
    "suit": ((0.0075, 0.0075, 0.0085), 0.6, 0.0, (0, 0, 0)),
    "shirt": ((0.0055, 0.0055, 0.006), 0.9, 0.0, (0, 0, 0)),
    "satin": ((0.0045, 0.0045, 0.005), 0.2, 0.0, (0, 0, 0)),
    "leather": ((0.0045, 0.0045, 0.005), 0.08, 0.0, (0, 0, 0)),
    "hair": ((0.0055, 0.0052, 0.0052), 0.3, 0.0, (0, 0, 0)),
    "redline": ((0.34, 0.012, 0.008), 0.35, 0.0, (0.18, 0.005, 0.003)),
}
EXTRA_SPECULAR = {"suit": 0.09, "shirt": 0.03, "satin": 0.55, "leather": 0.75, "hair": 0.3, "redline": 0.3}


def extend_atlas():
    for k, v in EXTRA_REGIONS.items():
        body.REGIONS[k] = v
    body.REGION_INDEX.clear()
    body.REGION_INDEX.update({n: i for i, n in enumerate(body.REGIONS)})
    assert len(body.REGIONS) <= 16, "atlas has 16 blocks"
    body.SPECULAR.update(EXTRA_SPECULAR)


# --- small helpers --------------------------------------------------------------
def lerp(a, b, t):
    return a + (b - a) * t


def table(tab, x):
    """Piecewise-linear lookup in [(x, value), ...]."""
    if x <= tab[0][0]:
        return tab[0][1]
    for (x0, v0), (x1, v1) in zip(tab, tab[1:]):
        if x <= x1:
            return lerp(v0, v1, (x - x0) / (x1 - x0))
    return tab[-1][1]


def quads(mb, rows, region, closed=False, smooth=True):
    for ra, rb in zip(rows, rows[1:]):
        n = len(ra)
        for k in range(n if closed else n - 1):
            k2 = (k + 1) % n
            mb.f((ra[k], ra[k2], rb[k2], rb[k]), region, smooth)


def slab(mb, P, N, W, thick, region, closed=False, edge=None):
    """A grid of points P (rows x cols) with normals N and weights W, given
    thickness along -N. Closed shell: top, bottom and the four walls."""
    top = [[mb.v(p, w) for p, w in zip(rp, rw)] for rp, rw in zip(P, W)]
    bot = [[mb.v(p - n * thick, w) for p, n, w in zip(rp, rn, rw)] for rp, rn, rw in zip(P, N, W)]
    er = edge or region
    quads(mb, top, region, closed)
    quads(mb, bot, region, closed)
    quads(mb, [top[0], bot[0]], er, closed)
    quads(mb, [top[-1], bot[-1]], er, closed)
    if not closed:
        quads(mb, [[r[0] for r in top], [r[0] for r in bot]], er)
        quads(mb, [[r[-1] for r in top], [r[-1] for r in bot]], er)


def grid_normals(P, outward):
    """Per-point normals of a grid from central differences, flipped to agree
    with outward(p)."""
    rows, cols = len(P), len(P[0])
    N = []
    for i in range(rows):
        rn = []
        for j in range(cols):
            du = P[i][min(j + 1, cols - 1)] - P[i][max(j - 1, 0)]
            dv = P[min(i + 1, rows - 1)][j] - P[max(i - 1, 0)][j]
            n = du.cross(dv)
            if n.length < 1e-9:
                n = outward(P[i][j]).copy()
            n.normalize()
            if n.dot(outward(P[i][j])) < 0:
                n = -n
            rn.append(n)
        N.append(rn)
    return N


def tube(mb, pts, radius, wts, region, segs=8, caps=True, flat=1.0, up=None):
    """Tube along a polyline with parallel-transported frames (no twisting)."""
    n = len(pts)
    tans = [(pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized() for i in range(n)]
    ref = up if up is not None else Vector((0, 0, 1))
    u = ref - tans[0] * ref.dot(tans[0])
    if u.length < 1e-6:
        u = Vector((1, 0, 0)) - tans[0] * tans[0].x
    u.normalize()
    rings = []
    for i in range(n):
        if i:
            u = tans[i - 1].rotation_difference(tans[i]) @ u
            u = (u - tans[i] * u.dot(tans[i])).normalized()
        v = tans[i].cross(u)
        r = radius[i] if isinstance(radius, (list, tuple)) else radius
        w = wts[i] if isinstance(wts, list) else wts
        rings.append([mb.v(pts[i] + u * (r * math.cos(2 * math.pi * k / segs))
                           + v * (r * flat * math.sin(2 * math.pi * k / segs)), w) for k in range(segs)])
    quads(mb, rings, region, closed=True)
    if caps:
        for ring, p, w in ((rings[0], pts[0], wts[0] if isinstance(wts, list) else wts),
                           (rings[-1], pts[-1], wts[-1] if isinstance(wts, list) else wts)):
            c = mb.v(p, w)
            for k in range(segs):
                mb.f((ring[k], ring[(k + 1) % segs], c), region)


def ribbon(mb, pts, nrms, wts, width, height, region, closed=False):
    """A thin flat strip lying on a surface (normals nrms): for piping lines."""
    n = len(pts)
    rings = []
    for i in range(n):
        if closed:
            a, b = pts[(i - 1) % n], pts[(i + 1) % n]
        else:
            a, b = pts[max(i - 1, 0)], pts[min(i + 1, n - 1)]
        t = (b - a).normalized()
        nn = nrms[i]
        bi = t.cross(nn).normalized() * (width / 2)
        w = wts[i] if isinstance(wts, list) else wts
        p = pts[i]
        rings.append([mb.v(p + bi - nn * 0.0006, w), mb.v(p + bi + nn * height, w),
                      mb.v(p - bi + nn * height, w), mb.v(p - bi - nn * 0.0006, w)])
    if closed:
        rings.append(rings[0])
    quads(mb, rings, region, closed=True)
    if not closed:
        mb.f(tuple(rings[0]), region)
        mb.f(tuple(rings[-1][::-1]), region)


def button(mb, p, n, r, wts, region="metal", th=0.0035):
    fr = frame_from_axis(n)
    mb.loft([(p - n * 0.001, fr, r, r, wts, 2.0), (p + n * th * 0.6, fr, r, r, wts, 2.0),
             (p + n * th, fr, r * 0.78, r * 0.78, wts, 2.0)], region, segs=14, cap_end=True)


# --- torso weights ----------------------------------------------------------------
CHAIN = [(0.96, "Hips"), (1.12, "Spine"), (1.24, "Spine1"), (1.38, "Spine2"), (1.52, "Neck")]


def w_torso(z):
    if z <= CHAIN[0][0]:
        return {"Hips": 1.0}
    for (z0, b0), (z1, b1) in zip(CHAIN, CHAIN[1:]):
        if z <= z1:
            t = smooth01((z - z0) / (z1 - z0))
            return {b0: 1 - t, b1: t}
    return {"Neck": 1.0}


def w_jacket(z, x):
    """The skirt of the jacket follows the thighs a little when walking."""
    w = w_torso(z)
    if z < 0.93:
        k = 0.3 * smooth01((0.93 - z) / 0.16) * smooth01(abs(x) / 0.12)
        if k > 0:
            w = {b: v * (1 - k) for b, v in w.items()}
            w[("Left" if x > 0 else "Right") + "UpLeg"] = k
    return w


# --- superellipse torso sections ---------------------------------------------------
def prof_at(prof, z):
    if z <= prof[0][0]:
        return prof[0][1:]
    for a, b in zip(prof, prof[1:]):
        if z <= b[0]:
            t = (z - a[0]) / (b[0] - a[0])
            return tuple(lerp(x, y, t) for x, y in zip(a[1:], b[1:]))
    return prof[-1][1:]


def se(a, rx, ry, e):
    c, s = math.cos(a), math.sin(a)
    return math.copysign(abs(c) ** (2 / e), c) * rx, math.copysign(abs(s) ** (2 / e), s) * ry


def se_normal(x, y, rx, ry, e):
    gx = math.copysign(abs(x / rx) ** (e - 1), x) / rx
    gy = math.copysign(abs(y / ry) ** (e - 1), y) / ry
    v = Vector((gx, gy, 0.0))
    return v.normalized() if v.length > 1e-9 else Vector((0, -1, 0))


# --- jacket -------------------------------------------------------------------------
# z, half-width, half-depth, y-shift (neg = forward), exponent
JACKET = [
    (0.772, 0.197, 0.143, 0.008, 2.5),
    (0.84, 0.191, 0.138, 0.007, 2.5),
    (0.90, 0.182, 0.131, 0.005, 2.5),
    (0.96, 0.172, 0.124, 0.003, 2.45),
    (1.02, 0.163, 0.119, 0.001, 2.4),
    (1.08, 0.159, 0.119, -0.001, 2.4),
    (1.16, 0.163, 0.123, -0.004, 2.4),
    (1.24, 0.172, 0.128, -0.007, 2.4),
    (1.31, 0.180, 0.131, -0.009, 2.4),
    (1.36, 0.184, 0.129, -0.008, 2.35),
    (1.395, 0.181, 0.123, -0.005, 2.25),
    (1.42, 0.170, 0.115, -0.002, 2.2),
    (1.44, 0.150, 0.106, 0.001, 2.1),
    (1.455, 0.125, 0.098, 0.004, 2.0),
    (1.466, 0.099, 0.089, 0.008, 2.0),
]
JK_THICK = 0.007
BUTTON_Z = (1.075, 0.975)
LAP_ZB = 1.075  # lapels roll down to the top button
LAP_ZG = 1.44  # inner top (gorge meets the collar)
LAP_PEAK = (0.160, 1.392)


def jk_xe(z):
    """Half-width of the front opening at height z."""
    if z >= LAP_ZB:
        return 0.0015 + 0.071 * min(1.0, (z - LAP_ZB) / (LAP_ZG - LAP_ZB))
    if z >= 0.968:
        return 0.0015
    t = (0.968 - z) / (0.968 - 0.772)
    return 0.0015 + 0.072 * smooth01(t) ** 0.75


def jk_front(x, z, off=0.0):
    """Point on the jacket's front surface at (x, z), pushed out by off."""
    rx, ry, dy, e = prof_at(JACKET, z)
    ax = min(abs(x) / rx, 0.995)
    y = -ry * (1 - ax ** e) ** (1 / e)
    n = se_normal(x, y, rx, ry, e)
    return Vector((x, y + dy, z)) + n * off, n


def add_jacket(mb):
    zs = []
    for a, b in zip(JACKET, JACKET[1:]):
        steps = max(1, round((b[0] - a[0]) / 0.024))
        zs += [lerp(a[0], b[0], i / steps) for i in range(steps)]
    zs.append(JACKET[-1][0])
    NS = 48
    P, N, W = [], [], []
    for z in zs:
        rx, ry, dy, e = prof_at(JACKET, z)
        xe = jk_xe(z)
        dl = math.asin(min(1.0, (xe / rx) ** (e / 2)))
        a0, a1 = -math.pi / 2 + dl, 3 * math.pi / 2 - dl
        rp, rn, rw = [], [], []
        for k in range(NS + 1):
            x, y = se(lerp(a0, a1, k / NS), rx, ry, e)
            rp.append(Vector((x, y + dy, z)))
            rn.append(se_normal(x, y, rx, ry, e))
            rw.append(w_jacket(z, x))
        P.append(rp)
        N.append(rn)
        W.append(rw)
    slab(mb, P, N, W, JK_THICK, "suit")


def lapel_xz(t, s):
    """Front-projection (x, z) of the LEFT lapel; t 0..1 from the button up,
    s 0..1 from the roll line (the jacket edge) to the outer edge."""
    zi = lerp(LAP_ZB, LAP_ZG, t)
    xi = jk_xe(zi)
    zo = lerp(LAP_ZB, LAP_PEAK[1], t)
    xo = lerp(0.004, LAP_PEAK[0], t ** 0.72)
    x, z = lerp(xi, xo, s), lerp(zi, zo, s)
    k = smooth01((t - 0.8) / 0.2)
    z -= 0.03 * max(0.0, 1 - abs(s - 0.56) / 0.2) * k  # notch
    z += 0.02 * smooth01((s - 0.7) / 0.3) * k  # the peak points up
    return x, z


LAP_OFF = 0.0035
LAP_THICK = 0.0032


def lapel_off(t, s):
    return LAP_OFF + 0.005 * math.exp(-(((s - 0.06) / 0.09) ** 2)) * (1 - 0.5 * t)


def lapel_point(side, t, s, lift=0.0):
    x, z = lapel_xz(t, s)
    p, n = jk_front(side * x, z, lapel_off(t, s) + lift)
    return p, n, z


def add_lapels(mb):
    nt, ns = 30, 9
    for side, _ in SIDES:
        P, N, W = [], [], []
        for i in range(nt + 1):
            t = 0.015 + 0.985 * i / nt
            rp, rn, rw = [], [], []
            for j in range(ns + 1):
                p, n, z = lapel_point(side, t, j / ns)
                rp.append(p)
                rn.append(n)
                rw.append(w_torso(z))
            P.append(rp)
            N.append(rn)
            W.append(rw)
        slab(mb, P, N, W, LAP_THICK, "satin")


def add_collar(mb):
    G, _, _ = lapel_point(1, 1.0, 0.0)
    Np, _, _ = lapel_point(1, 1.0, 0.56)
    thG, rG = math.atan2(G.y, G.x), math.hypot(G.x, G.y)
    thN, rN = math.atan2(Np.y, Np.x), math.hypot(Np.x, Np.y)
    nu = 16
    us = [-1 + 2 * i / (2 * nu) for i in range(2 * nu + 1)]
    P, W = [], []
    for u in us:
        side = 1 if u >= 0 else -1
        a = abs(u)
        thF = lerp(math.pi / 2, thG, a)
        rF = lerp(0.079, rG, a ** 1.6)
        zF = lerp(1.506, G.z, a ** 1.4)
        thO = lerp(math.pi / 2, thN, a)
        rO = lerp(0.112, rN, a ** 1.6)
        zO = lerp(1.452, Np.z, a ** 1.4)
        F = Vector((side * rF * math.cos(thF), rF * math.sin(thF) + 0.006 * (1 - a), zF))
        O = Vector((side * rO * math.cos(thO), rO * math.sin(thO) + 0.006 * (1 - a), zO))
        radial = Vector((F.x, F.y, 0)).normalized()
        row = []
        for s in (0.0, 0.3, 0.65, 1.0):
            p = F.lerp(O, s) + radial * (0.006 * math.sin(math.pi * s) * (1 - 0.6 * a))
            row.append(p)
        P.append(row)
        W.append([w_torso(p.z) for p in row])
    N = grid_normals(P, lambda p: Vector((p.x, p.y, 0.8 * math.hypot(p.x, p.y))).normalized())
    slab(mb, P, N, W, 0.004, "satin")


def front_patch(mb, side, x0, x1, z0, z1, off, thick, region, nx=6, nz=2, slope=0.0):
    P, N, W = [], [], []
    for i in range(nz + 1):
        z = lerp(z0, z1, i / nz)
        rp, rn, rw = [], [], []
        for j in range(nx + 1):
            x = lerp(x0, x1, j / nx)
            zz = z + slope * (x - x0)
            p, n = jk_front(side * x, zz, off)
            rp.append(p)
            rn.append(n)
            rw.append(w_jacket(zz, side * x))
        P.append(rp)
        N.append(rn)
        W.append(rw)
    slab(mb, P, N, W, thick, region)


def add_jacket_details(mb):
    for z in BUTTON_Z:
        p, n = jk_front(0.0, z, JK_THICK * 0.2)
        button(mb, p, n, 0.0105, w_torso(z))
    for side, _ in SIDES:
        # hip flap pockets
        front_patch(mb, side, 0.062, 0.158, 0.9, 0.952, 0.0045, 0.0035, "suit", nx=8)
    # breast pocket welt on the left chest
    front_patch(mb, 1, 0.098, 0.162, 1.252, 1.274, 0.004, 0.003, "suit", nx=6, slope=0.12)


def add_pocket_square(mb, region):
    """Three small folded points peeking out of the breast pocket."""
    for xc, h, wdt in ((0.118, 0.021, 0.022), (0.137, 0.015, 0.018)):
        zb = 1.268 + 0.12 * (xc - 0.098)
        P, N, W = [], [], []
        for i, (zz, ww) in enumerate(((zb - 0.004, wdt), (zb + h * 0.55, wdt * 0.6), (zb + h, 0.002))):
            rp, rn, rw = [], [], []
            for j in range(4):
                x = xc + (j / 3 - 0.5) * ww
                p, n = jk_front(x, zz, 0.0055 + 0.0015 * i)
                rp.append(p)
                rn.append(n)
                rw.append(w_torso(zz))
            P.append(rp)
            N.append(rn)
            W.append(rw)
        slab(mb, P, N, W, 0.0025, region)


# --- turtleneck -------------------------------------------------------------------
SHIRT = [
    (0.94, 0.150, 0.107, 0.004, 2.4),
    (1.00, 0.151, 0.107, 0.002, 2.4),
    (1.08, 0.149, 0.107, -0.001, 2.4),
    (1.16, 0.153, 0.111, -0.004, 2.4),
    (1.24, 0.161, 0.116, -0.006, 2.4),
    (1.31, 0.167, 0.118, -0.008, 2.4),
    (1.37, 0.169, 0.116, -0.006, 2.5),
    (1.41, 0.156, 0.107, -0.003, 2.3),
    (1.44, 0.115, 0.092, 0.003, 2.1),
    (1.46, 0.081, 0.077, 0.007, 2.0),
    (1.478, 0.064, 0.062, 0.006, 2.0),
    (1.50, 0.0585, 0.0575, 0.005, 2.0),
    (1.522, 0.0555, 0.0545, 0.004, 2.0),
    (1.538, 0.0545, 0.0535, 0.004, 2.0),
    (1.545, 0.0495, 0.0485, 0.004, 2.0),
    (1.535, 0.0455, 0.0445, 0.004, 2.0),
]


def add_turtleneck(mb):
    segs = 40
    rows = []
    for z, rx, ry, dy, e in SHIRT:
        ring = []
        for k in range(segs):
            a = 2 * math.pi * k / segs
            x, y = se(a, rx, ry, e)
            if z > 1.465:  # knitted ribs on the collar
                rib = 1 + 0.018 * math.cos(a * 20)
                x, y = x * rib, y * rib
            ring.append(mb.v(Vector((x, y + dy, z)), w_torso(z)))
        rows.append(ring)
    quads(mb, rows, "shirt", closed=True)
    c = mb.v(Vector((0, 0.004, SHIRT[0][0] - 0.02)), {"Hips": 1.0})
    for k in range(segs):
        mb.f((rows[0][(k + 1) % segs], rows[0][k], c), "shirt")


# --- sleeves ---------------------------------------------------------------------
SLEEVE = [
    # t along the arm, extent above the bone (toward the shoulder top), below it
    # (toward the armpit), and to the front/back. The shoulder joint sits at the
    # top of the arm, so near it there is little sleeve above the bone and a lot
    # below: the sleeve head stays flush with the jacket's shoulder line.
    (-0.03, 0.004, 0.07, 0.052),
    (-0.012, 0.015, 0.075, 0.061),
    (0.004, 0.028, 0.078, 0.068),
    (0.035, 0.045, 0.079, 0.0705),
    (0.08, 0.054, 0.076, 0.0675),
    (0.15, 0.058, 0.066, 0.0625),
    (0.22, 0.0585, 0.0585, 0.0578),
    (0.28, 0.0562, 0.0562, 0.055),
    (0.34, 0.0535, 0.0535, 0.0525),
    (0.42, 0.0495, 0.0495, 0.0485),
    (0.48, 0.047, 0.047, 0.046),
    (0.503, 0.0465, 0.0465, 0.0455),
    (0.506, 0.042, 0.042, 0.041),
    (0.47, 0.041, 0.041, 0.040),
]
CUFF_T = 0.49


def sleeve_w(t, pre):
    if t < 0.0:
        return {f"{pre}Shoulder": 0.75, f"{pre}Arm": 0.25}
    if t < 0.06:
        return lerp_w({f"{pre}Shoulder": 0.5, f"{pre}Arm": 0.5}, {f"{pre}Arm": 1.0}, smooth01(t / 0.06))
    if t < UPPER_ARM - 0.05:
        return {f"{pre}Arm": 1.0}
    if t < UPPER_ARM + 0.05:
        k = smooth01((t - (UPPER_ARM - 0.05)) / 0.1)
        return {f"{pre}Arm": 1 - k, f"{pre}ForeArm": k}
    return {f"{pre}ForeArm": 1.0}


def sleeve_frame(side):
    """(shoulder joint, arm direction, frame) with frame columns (up, front,
    axis): `up` is the up-and-outward side of the arm on both sides."""
    d = _arm_dir(side)
    fr = frame_from_axis(d, Vector((0, -1, 0)))
    up, fw = fr.col[0], fr.col[1]
    if up.z < 0:
        up, fw = -up, -fw
    return tail_of(("Left" if side > 0 else "Right") + "Shoulder"), d, Matrix((up, fw, d)).transposed()


def sleeve_extent(t):
    rows = SLEEVE[:12]
    return (table([(r[0], r[1]) for r in rows], t), table([(r[0], r[2]) for r in rows], t),
            table([(r[0], r[3]) for r in rows], t))


def sleeve_centre(side, t):
    start, d, fr = sleeve_frame(side)
    top, bot, _ = sleeve_extent(t)
    return start + d * t + fr.col[0] * ((top - bot) / 2)


def sleeve_radius(t):
    top, bot, rv = sleeve_extent(t)
    return (top + bot) / 2, rv


def add_sleeves(mb):
    segs = 24
    for side, pre in SIDES:
        start, d, fr = sleeve_frame(side)
        u, v = fr.col[0], fr.col[1]
        rows = []
        for t, top, bot, rv in SLEEVE:
            w = sleeve_w(t, pre)
            ring = []
            for k in range(segs):
                a = 2 * math.pi * k / segs
                c, s_ = math.cos(a), math.sin(a)
                ring.append(mb.v(start + d * t + u * ((top if c > 0 else bot) * c) + v * (rv * s_), w))
            rows.append(ring)
        quads(mb, rows, "suit", closed=True)
        t0, top0, bot0, _ = SLEEVE[0]
        c = mb.v(start + d * (t0 - 0.01) + u * ((top0 - bot0) / 2), sleeve_w(t0, pre))
        for k in range(segs):
            mb.f((rows[0][(k + 1) % segs], rows[0][k], c), "suit")
        # turtleneck cuff showing below the jacket sleeve
        rings = [(start + d * t, fr, r, r * 0.97, sleeve_w(t, pre), 2.0)
                 for t, r in ((0.47, 0.0405), (0.515, 0.037), (0.527, 0.0335), (0.523, 0.029))]
        mb.loft(rings, "shirt", segs=18)
        # three cuff buttons on the outer back of the sleeve
        for t in (0.452, 0.468, 0.484):
            ru, rv = sleeve_radius(t)
            ang = math.radians(35)
            dirn = (u * math.cos(ang) - v * math.sin(ang)).normalized()
            p = sleeve_centre(side, t) + u * (ru * math.cos(ang)) - v * (rv * math.sin(ang))
            button(mb, p, dirn, 0.0052, sleeve_w(t, pre), th=0.0025)


def sleeve_ring_points(side, t, off=0.0006, zig=0.0, teeth=16, segs=48):
    pre = "Left" if side > 0 else "Right"
    start, d, fr = sleeve_frame(side)
    u, v = fr.col[0], fr.col[1]
    pts, nrms, wts = [], [], []
    for k in range(segs):
        a = 2 * math.pi * k / segs
        tt = t
        if zig:
            ph = (k * teeth / segs) % 1.0
            tt += zig * (4 * abs(ph - 0.5) - 1)
        ru, rv = sleeve_radius(tt)
        n = (u * math.cos(a) * rv + v * math.sin(a) * ru).normalized()
        pts.append(sleeve_centre(side, tt) + u * (ru * math.cos(a)) + v * (rv * math.sin(a)) + n * off)
        nrms.append(n)
        wts.append(sleeve_w(tt, pre))
    return pts, nrms, wts


# --- trousers ------------------------------------------------------------------------
LEG_SEGS = 28


def trouser_rings(side):
    """[(centre, radius, weights, z_tilt)] down one leg."""
    pre = "Left" if side > 0 else "Right"
    hip, knee, ankle = head_of(f"{pre}UpLeg"), head_of(f"{pre}Leg"), head_of(f"{pre}Foot")
    thigh_d, shin_d = (knee - hip).normalized(), (ankle - knee).normalized()
    tl, sl = (knee - hip).length, (ankle - knee).length
    out = []
    for t, r, wt in (
        (-0.03, 0.089, {"Hips": 0.55, f"{pre}UpLeg": 0.45}),
        (0.03, 0.089, {"Hips": 0.25, f"{pre}UpLeg": 0.75}),
        (0.1, 0.087, {f"{pre}UpLeg": 1.0}),
        (0.2, 0.083, {f"{pre}UpLeg": 1.0}),
        (0.3, 0.079, {f"{pre}UpLeg": 1.0}),
        (tl - 0.04, 0.0765, {f"{pre}UpLeg": 0.8, f"{pre}Leg": 0.2}),
    ):
        out.append((hip + thigh_d * t, r, wt, 0.0))
    for t, r, wt in (
        (0.0, 0.0755, {f"{pre}UpLeg": 0.5, f"{pre}Leg": 0.5}),
        (0.05, 0.075, {f"{pre}UpLeg": 0.2, f"{pre}Leg": 0.8}),
        (0.14, 0.0745, {f"{pre}Leg": 1.0}),
        (0.24, 0.0742, {f"{pre}Leg": 1.0}),
        (0.33, 0.0742, {f"{pre}Leg": 1.0}),
    ):
        out.append((knee + shin_d * t, r, wt, 0.0))
    hem = knee + shin_d * (sl - 0.005)
    out.append((hem, 0.0745, {f"{pre}Leg": 1.0}, 0.016))
    return out


def trouser_point(c, r, a, tilt, crease=True):
    x, y = r * math.cos(a), r * 0.985 * math.sin(a)
    radial = Vector((math.cos(a), math.sin(a), 0))
    p = c + Vector((x, y, -tilt * math.sin(a)))
    if crease:
        da_f = math.atan2(math.sin(a + math.pi / 2), math.cos(a + math.pi / 2))
        da_b = math.atan2(math.sin(a - math.pi / 2), math.cos(a - math.pi / 2))
        p += radial * (0.0055 * math.exp(-((da_f / 0.12) ** 2)) + 0.003 * math.exp(-((da_b / 0.12) ** 2)))
    return p


def add_trousers(mb):
    pelvis = [
        (1.005, 0.153, 0.112, 0.0),
        (0.97, 0.155, 0.113, 0.002),
        (0.93, 0.157, 0.115, 0.004),
        (0.86, 0.158, 0.116, 0.008),
        (0.815, 0.144, 0.107, 0.01),
        (0.78, 0.1, 0.08, 0.01),
    ]
    rings = [(Vector((0, dy, z)), Z3, rx, ry, {"Hips": 1.0}, 2.6) for z, rx, ry, dy in pelvis]
    mb.loft(rings, "suit", segs=28, cap_end=True)
    # belt with a small dark buckle
    rings = [(Vector((0, 0.001, z)), Z3, 0.1585, 0.1165, {"Hips": 1.0}, 2.6) for z in (0.972, 0.974, 0.998, 1.0)]
    rings[0] = (rings[0][0], Z3, 0.155, 0.113, {"Hips": 1.0}, 2.6)
    rings[3] = (rings[3][0], Z3, 0.155, 0.113, {"Hips": 1.0}, 2.6)
    mb.loft(rings, "leather", segs=28)
    mb.box((0, -0.118, 0.986), (0.034, 0.03, 0.006), Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0))), {"Hips": 1.0},
           "metal", bevel=0.2)
    for side, pre in SIDES:
        tr = trouser_rings(side)
        rows = []
        for c, r, wt, tilt in tr:
            rows.append([mb.v(trouser_point(c, r, 2 * math.pi * k / LEG_SEGS, tilt), wt) for k in range(LEG_SEGS)])
        # inside of the hem, so it has a thickness
        c, r, wt, tilt = tr[-1]
        rows.append([mb.v(trouser_point(c, r - 0.004, 2 * math.pi * k / LEG_SEGS, tilt, False), wt)
                     for k in range(LEG_SEGS)])
        rows.append([mb.v(trouser_point(c + Vector((0, 0, 0.03)), r - 0.004, 2 * math.pi * k / LEG_SEGS, tilt, False), wt)
                     for k in range(LEG_SEGS)])
        quads(mb, rows, "suit", closed=True)


def trouser_seam_line(side, zig):
    """Points down the outer side seam of one leg (x = outer side)."""
    tr = trouser_rings(side)
    a = 0.0 if side > 0 else math.pi
    pts, nrms, wts = [], [], []
    # sample along the rings, finely
    for (c0, r0, w0, t0), (c1, r1, w1, t1) in zip(tr[1:], tr[2:]):
        for i in range(6):
            f = i / 6
            c, r, tl = c0.lerp(c1, f), lerp(r0, r1, f), lerp(t0, t1, f)
            if c.z > 0.76:
                continue
            p = trouser_point(c, r + 0.0006, a, tl, False)
            pts.append(p)
            nrms.append(Vector((math.cos(a), 0, 0)))
            wts.append(lerp_w(w0, w1, f))
    c, r, w, tl = tr[-1]
    pts.append(trouser_point(c + Vector((0, 0, 0.012)), r + 0.0006, a, tl, False))
    nrms.append(Vector((math.cos(a), 0, 0)))
    wts.append(w)
    if zig:
        # a straight pinline broken by three sharp lightning jags
        out_p, out_n, out_w = [], [], []
        jags = (0.64, 0.43, 0.25)
        for i, (p, n, w) in enumerate(zip(pts, nrms, wts)):
            out_p.append(p)
            out_n.append(n)
            out_w.append(w)
            if i + 1 < len(pts):
                q = pts[i + 1]
                for zc in jags:
                    if q.z < zc <= p.z:
                        base = p.lerp(q, (p.z - zc) / max(p.z - q.z, 1e-6))
                        for dz, dy in ((0.008, 0.0), (0.002, 0.009), (-0.003, -0.006), (-0.009, 0.0)):
                            out_p.append(base + Vector((0, dy, dz)))
                            out_n.append(n)
                            out_w.append(w)
        pts, nrms, wts = out_p, out_n, out_w
    return pts, nrms, wts


# --- dress shoes ------------------------------------------------------------------------
# y, half-width, upper bottom z, upper top z
SHOE = [
    (0.080, 0.030, 0.030, 0.070),
    (0.074, 0.039, 0.028, 0.080),
    (0.058, 0.044, 0.027, 0.086),
    (0.030, 0.046, 0.024, 0.090),
    (0.000, 0.047, 0.020, 0.096),
    (-0.035, 0.049, 0.015, 0.091),
    (-0.070, 0.051, 0.012, 0.076),
    (-0.105, 0.050, 0.012, 0.062),
    (-0.140, 0.045, 0.013, 0.052),
    (-0.170, 0.037, 0.015, 0.046),
    (-0.192, 0.026, 0.017, 0.042),
    (-0.206, 0.012, 0.019, 0.037),
]
SHOE_SEGS = 24


def shoe_w(pre, y):
    k = smooth01((-0.075 - y) / 0.05)
    return {f"{pre}Foot": 1 - k, f"{pre}ToeBase": k} if 0 < k < 1 else ({f"{pre}ToeBase": 1.0} if k >= 1 else {f"{pre}Foot": 1.0})


def shoe_point(x0, st, a, grow=0.0):
    y, hw, zb, zt = st
    c, s = math.cos(a), math.sin(a)
    e = 2.4 if s > 0 else 6.0  # rounded upper, flat bottom
    cx = math.copysign(abs(c) ** (2 / e), c)
    sz = math.copysign(abs(s) ** (2 / e), s)
    hh = (zt - zb) / 2
    return Vector((x0 + (hw + grow) * cx, y, zb + hh + (hh + grow) * sz))


def add_shoes(mb):
    for side, pre in SIDES:
        x0 = 0.095 * side
        rows = []
        for st in SHOE:
            w = shoe_w(pre, st[0])
            rows.append([mb.v(shoe_point(x0, st, 2 * math.pi * k / SHOE_SEGS), w) for k in range(SHOE_SEGS)])
        quads(mb, rows, "leather", closed=True)
        for ring, st, sgn in ((rows[0], SHOE[0], 1), (rows[-1], SHOE[-1], -1)):
            c = mb.v(Vector((x0, st[0] + 0.002 * sgn, (st[2] + st[3]) / 2)), shoe_w(pre, st[0]))
            for k in range(SHOE_SEGS):
                mb.f((ring[k], ring[(k + 1) % SHOE_SEGS], c), "leather")
        # sole: a thin welted slab with a stacked heel
        def bottom(y):
            if y > 0.012:
                return 0.0  # heel block
            if y > -0.045:
                return lerp(0.009, 0.004, (0.012 - y) / 0.057)  # arched waist
            if y > -0.17:
                return 0.0
            return 0.005 * (-0.17 - y) / 0.036  # toe spring
        srows = []
        for y, hw, zb, zt in SHOE[1:]:
            top = zb + 0.002
            bot = bottom(y)
            wdt = hw + 0.004
            w = shoe_w(pre, y)
            ring = []
            for k in range(20):
                a = 2 * math.pi * k / 20
                c, s = math.cos(a), math.sin(a)
                cx = math.copysign(abs(c) ** (2 / 8), c)
                sz = math.copysign(abs(s) ** (2 / 8), s)
                ring.append(mb.v(Vector((x0 + wdt * cx, y, lerp(bot, top, 0.5 + 0.5 * sz))), w))
            srows.append(ring)
        # the front of the heel block
        quads(mb, srows, "sole", closed=True)
        for ring, sgn in ((srows[0], 1), (srows[-1], -1)):
            c = mb.v(Vector((x0, SHOE[1][0] if sgn > 0 else SHOE[-1][0], 0.01)), {f"{pre}Foot": 1.0} if sgn > 0 else {f"{pre}ToeBase": 1.0})
            for k in range(20):
                mb.f((ring[k], ring[(k + 1) % 20], c), "sole")
        # cap-toe seam and laces
        st = SHOE[8]
        pts = [shoe_point(x0, st, math.pi * (0.1 + 0.8 * i / 10), 0.0006) for i in range(11)]
        nrm = [(p - Vector((x0, st[0], (st[2] + st[3]) / 2))).normalized() for p in pts]
        ribbon(mb, pts, nrm, shoe_w(pre, st[0]), 0.0022, 0.0004, "visor")
        for y in (-0.045, -0.03, -0.015, 0.0):
            st = next(s for s in SHOE if s[0] <= y + 1e-6)
            zt = table([(s[0], s[3]) for s in reversed(SHOE)], y)
            pts = [Vector((x0 + dx, y, zt + 0.0005 - 180 * dx * dx)) for dx in (-0.013, 0.0, 0.013)]
            tube(mb, pts, 0.0017, shoe_w(pre, y), "leather", segs=6)


def shoe_welt_line(side):
    pre = "Left" if side > 0 else "Right"
    x0 = 0.095 * side
    pts, nrms, wts = [], [], []
    stations = SHOE[1:]
    ring = [(st, 1) for st in stations] + [(st, -1) for st in reversed(stations)]
    for st, sgn in ring:
        y, hw, zb, zt = st
        p = Vector((x0 + sgn * (hw + 0.0028), y, zb + 0.0035))
        pts.append(p)
        nrms.append(Vector((sgn, 0, 0)))
        wts.append(shoe_w(pre, y))
    return pts, nrms, wts


# --- hair -------------------------------------------------------------------------------
# Hairline elevation (d.z of the head direction) by azimuth |psi| in degrees:
# 0 = the middle of the forehead, 90 = over the ear, 180 = the nape.
HAIRLINE = [(0, 0.50), (22, 0.53), (40, 0.48), (52, 0.37), (60, 0.24), (66, 0.1), (72, 0.12),
            (78, 0.27), (100, 0.28), (110, 0.1), (125, -0.1), (150, -0.28), (180, -0.35)]
PART_X = 0.30  # the part is on the character's left; the top is combed to the right
SIDE_HAIR = 0.0042  # short sides and back
GROOVE_SEED = [0.9, 0.55, 1.0, 0.7, 0.85, 0.45, 1.0, 0.65, 0.8, 0.95, 0.5, 0.75]


def head_normal(d):
    R = head.HEAD_R
    return Vector((d.x / R[0], d.y / R[1], d.z / R[2])).normalized()


def hairline_dir(psi_deg, above=0.0):
    w = min(0.97, table(HAIRLINE, abs(psi_deg)) + above)
    el, psi = math.asin(w), math.radians(psi_deg)
    return Vector((math.sin(psi) * math.cos(el), -math.cos(psi) * math.cos(el), math.sin(el)))


def hair_dir(psi, v):
    e0 = math.asin(table(HAIRLINE, abs(math.degrees(psi))))
    el = lerp(e0, math.pi / 2, v)
    return Vector((math.sin(psi) * math.cos(el), -math.cos(psi) * math.cos(el), math.sin(el)))


def valley(x):
    """0..1 groove profile with period 1: 1 at integer x (between two strands)."""
    f = x % 1.0
    return max(0.0, 1 - min(f, 1 - f) / 0.3) ** 2


def add_hair(mb):
    W = {"Head": 1.0}
    # 1) Short sides and back: a shell from the hairline to the crown, with a
    #    faint vertical comb texture and a soft edge at the hairline.
    npsi, nv = 96, 18
    rows = []
    for i in range(nv + 1):
        v = (i / nv) ** 1.3
        row = []
        for j in range(npsi):
            psi = 2 * math.pi * j / npsi - math.pi
            d = hair_dir(psi, v)
            th = 0.0004 + (SIDE_HAIR - 0.0004) * smooth01(v / 0.14)
            th -= 0.0006 * valley(j / 3.0) * smooth01(v / 0.1) * (1 - smooth01((d.z - 0.5) / 0.2))
            row.append(mb.v(head.head_point(d) + head_normal(d) * th, W))
        rows.append(row)
    quads(mb, rows, "hair", closed=True)

    # 2) The longer top, combed over from the part: a strand-aligned grid
    #    (a across the strands, b along them) so the comb grooves follow the hair.
    def combed(a_count, grooves, b_count, d0_fn, d1_fn, top_fn, bow):
        P = []
        for i in range(a_count + 1):
            a = i / a_count
            d0, d1 = d0_fn(a), d1_fn(a)
            ang = d0.angle(d1)
            row = []
            for j in range(b_count + 1):
                b = j / b_count
                if ang > 1e-5:
                    d = (d0 * math.sin((1 - b) * ang) + d1 * math.sin(b * ang)) / math.sin(ang)
                else:
                    d = d0.copy()
                d = (d + Vector((0, bow * math.sin(math.pi * b), 0))).normalized()
                t = top_fn(a, b)
                g = valley(a * grooves + 0.35 * math.sin(3.0 * b + a * 2.0))
                depth = 0.001 * GROOVE_SEED[int(a * grooves) % len(GROOVE_SEED)] * smooth01(t / 0.005)
                th = SIDE_HAIR + 0.0009 + t - depth * g
                row.append(mb.v(head.head_point(d) + head_normal(d) * th, W))
            P.append(row)
        quads(mb, P, "hair")

    def part(a):  # the part line, front hairline -> crown
        y = lerp(-0.765, 0.56, a)
        return Vector((PART_X, y, math.sqrt(max(1 - PART_X ** 2 - y * y, 0.02)))).normalized()

    def right_end(a):  # just above the right-side hairline, further back
        return hairline_dir(lerp(-44, -128, a), lerp(0.05, 0.3, a))

    def left_end(a):  # the short left side below the part
        return hairline_dir(lerp(46, 118, a), lerp(0.08, 0.3, a))

    def top_right(a, b):
        length = 0.013 * lerp(1.0, 0.5, a)
        prof = smooth01(b / 0.1) * (1 - 0.8 * smooth01((b - 0.4) / 0.6))
        front = smooth01(a / 0.13)
        back = 1 - 0.7 * smooth01((a - 0.85) / 0.15)
        quiff = 0.0035 * math.exp(-(((a - 0.12) / 0.1) ** 2)) * smooth01(b / 0.15) * (1 - smooth01((b - 0.45) / 0.4))
        return length * prof * front * back + quiff * front

    def top_left(a, b):
        prof = smooth01(b / 0.08) * (1 - 0.85 * smooth01((b - 0.3) / 0.7))
        return 0.006 * lerp(1.0, 0.6, a) * prof * smooth01(a / 0.06) * (1 - 0.7 * smooth01((a - 0.85) / 0.15))

    combed(125, 25, 26, part, right_end, top_right, 0.07)
    combed(60, 12, 12, part, left_end, top_left, 0.03)


# --- red accents ---------------------------------------------------------------------------
# A lightning path: (fraction along the lapel, offset across it), sharp corners.
BOLT = [(0.0, 0.0), (0.11, 0.05), (0.15, -0.035), (0.29, 0.045), (0.33, -0.02), (0.36, 0.03),
        (0.52, -0.045), (0.57, 0.02), (0.69, -0.03), (0.73, 0.04), (0.86, -0.02), (0.9, 0.02), (1.0, 0.0)]


def lapel_line(side, s, t0, t1, n=40, path=None):
    """Points on the lapel at s (across), from t0 to t1; with `path` the line
    follows a lightning polyline (corners kept exact, straight runs subdivided)."""
    samples = []
    if path:
        for (f0, o0), (f1, o1) in zip(path, path[1:]):
            steps = max(1, round((f1 - f0) * n))
            for i in range(steps):
                k = i / steps
                samples.append((lerp(t0, t1, lerp(f0, f1, k)), s + lerp(o0, o1, k)))
        samples.append((t1, s + path[-1][1]))
    else:
        samples = [(lerp(t0, t1, i / n), s) for i in range(n + 1)]
    pts, nrms, wts = [], [], []
    for t, ss in samples:
        p, nn, z = lapel_point(side, t, ss, 0.0)
        pts.append(p)
        nrms.append(nn)
        wts.append(w_torso(z))
    return pts, nrms, wts


def lapel_pin(mb, t, s, radius, red):
    """A small dark metal disc on the left lapel with a thin red ring."""
    p, n, z = lapel_point(1, t, s, 0.0)
    w = w_torso(z)
    button(mb, p, n, radius, w, th=0.003)
    e1 = n.cross(Vector((0, 0, 1))).normalized()
    e2 = n.cross(e1)
    ring = [p + n * 0.0031 + (e1 * math.cos(a) + e2 * math.sin(a)) * (radius * 0.62)
            for a in (2 * math.pi * k / 20 for k in range(20))]
    ribbon(mb, ring, [n] * 20, w, 0.0013, 0.0004, red, closed=True)


def add_accents(mb, variant):
    red = "redline"
    add_pocket_square(mb, red)
    for side, _ in SIDES:
        pts, nrms, wts = shoe_welt_line(side)
        ribbon(mb, pts, nrms, wts, 0.0022, 0.0006, red, closed=True)
    if variant == "A":
        for side, _ in SIDES:
            # piping just inside the lapel's outer edge, up over the peak
            pts, nrms, wts = lapel_line(side, 0.955, 0.05, 0.985, 44)
            ribbon(mb, pts, nrms, wts, 0.0022, 0.0006, red)
            pts, nrms, wts = sleeve_ring_points(side, CUFF_T)
            ribbon(mb, pts, nrms, wts, 0.0024, 0.0006, red, closed=True)
            pts, nrms, wts = sleeve_ring_points(side, CUFF_T - 0.008)
            ribbon(mb, pts, nrms, wts, 0.0012, 0.0005, red, closed=True)
        lapel_pin(mb, 0.66, 0.5, 0.0075, red)
    else:
        for side, _ in SIDES:
            pts, nrms, wts = lapel_line(side, 0.8, 0.1, 0.93, 60, BOLT)
            ribbon(mb, pts, nrms, wts, 0.0018, 0.0006, red)
            pts, nrms, wts = sleeve_ring_points(side, CUFF_T - 0.004, zig=0.006, teeth=14, segs=56)
            ribbon(mb, pts, nrms, wts, 0.0018, 0.0006, red, closed=True)
            pts, nrms, wts = trouser_seam_line(side, True)
            ribbon(mb, pts, nrms, wts, 0.0016, 0.0006, red)
        # lightning-bolt lapel pin
        pts, nrms, wts = [], [], []
        for t, s in ((0.70, 0.56), (0.655, 0.40), (0.65, 0.55), (0.60, 0.40)):
            p, nn, z = lapel_point(1, t, s, 0.0)
            pts.append(p)
            nrms.append(nn)
            wts.append(w_torso(z))
        ribbon(mb, pts, nrms, wts, 0.0032, 0.0012, red)


# --- the lead's mesh ---------------------------------------------------------------------
def build_lead(arm, material, variant="B"):
    """AM7's skinned mesh on the shared skeleton, with the shared material
    (call extend_atlas() before the material is built)."""
    mb = MeshBuilder()
    add_jacket(mb)
    add_lapels(mb)
    add_collar(mb)
    add_jacket_details(mb)
    add_turtleneck(mb)
    add_sleeves(mb)
    add_trousers(mb)
    add_shoes(mb)
    head.add_head(mb)
    add_hair(mb)
    body.add_hands(mb)
    add_accents(mb, variant)
    obj = mb.build("AM7", arm)
    obj.data.materials.append(material)
    print(f"[lead] verts={len(mb.verts)} faces={len(mb.faces)}")
    return obj
