"""Techwear outfit for the hacker character, used by body.build_body.

An open black bomber over the hoodie (stand collar, rib hem and cuffs, zip
edges, a flap pocket on the left sleeve), a chest harness with a sternum
buckle, tapered cargo pants (thigh pockets with flaps, knee panels, a hanging
strap, gathered cuffs), tactical gloves and lace-up combat boots. With MASK on
a fabric mask covers the android's nose, mouth and chin and runs down into a
neck gaiter, so only the metal brow and the red eyes show inside the hood.

Everything is matte near-black; the only red is two LED slits on the jacket
front and a small mark on the sleeve pocket (the "accent" block).

Like body.py, every part is authored with its own skin weights: cloth that
lies on a limb copies the weights of the ring underneath it, so it can never
slide off the surface it sits on.
"""

import math

from mathutils import Matrix, Vector

from body import HOODIE_PROFILE, frame_from_axis, lerp_w, neckline_weights, smooth01, torso_weights
from head import _in_opening, head_point, hood_point
from rig import UPPER_ARM, _arm_dir, _palm_normal, head_of, tail_of

# Fabric mask over the lower face + neck gaiter. build.py --no-mask turns it off.
MASK = True

Z = Matrix(((1, 0, 0), (0, 1, 0), (0, 0, 1)))


# --- helpers ---------------------------------------------------------------------
def loft_loops(mb, loops, weights, region, closed=True, cap_start=False, cap_end=False):
    """Loft through explicit point loops (all the same length). `weights` has
    one dict per loop, or a list of dicts (one per point) for a loop;
    `region` is a name or fn(segment index) -> name."""
    def wt(i, k):
        return weights[i][k] if isinstance(weights[i], list) else weights[i]

    idx = [[mb.v(p, wt(i, k)) for k, p in enumerate(loop)] for i, loop in enumerate(loops)]
    n = len(loops[0])
    for i in range(len(idx) - 1):
        reg = region(i) if callable(region) else region
        a, b = idx[i], idx[i + 1]
        for k in range(n if closed else n - 1):
            k2 = (k + 1) % n
            mb.f((a[k], a[k2], b[k2], b[k]), reg)
    for li, flag in ((0, cap_start), (-1, cap_end)):
        if not flag:
            continue
        c = mb.v(sum(loops[li], Vector()) / n, wt(li, 0))
        loop = idx[li]
        reg = region(0 if li == 0 else len(idx) - 2) if callable(region) else region
        for k in range(n):
            mb.f((loop[k], loop[(k + 1) % n], c), reg)
    return idx


def _se(a, ex):
    """Superellipse (cos, sin) for exponent ex, like MeshBuilder.loft."""
    c, s = math.cos(a), math.sin(a)
    return math.copysign(abs(c) ** (2 / ex), c), math.copysign(abs(s) ** (2 / ex), s)


def arc_shell(mb, rings, n, region, cap=True):
    """A padded patch on a round limb: per ring (centre, frame, r_in, r_out,
    a_centre, half_angle, weights) the loop runs along the outer arc and back
    along the inner one (buried in the cloth underneath), so the patch has a
    real edge. Frames are body.frame_from_axis frames (angle 0 = u)."""
    loops, wts = [], []
    for c, fr, r_in, r_out, ac, half, w in rings:
        u, v = fr.col[0], fr.col[1]
        outer = [c + (u * math.cos(a) + v * math.sin(a)) * r_out
                 for a in (ac - half + 2 * half * k / (n - 1) for k in range(n))]
        inner = [c + (u * math.cos(a) + v * math.sin(a)) * r_in
                 for a in (ac + half - 2 * half * k / (n - 1) for k in range(n))]
        loops.append(outer + inner)
        wts.append(w)
    return loft_loops(mb, loops, wts, region, cap_start=cap, cap_end=cap)


def slab(mb, center, along, normal, length, width, thick, weights, region, segs=12, expo=6.0):
    """A small rounded slab (buckle, LED slit, lace bar): `length` along
    `along`, `width` across, `thick` along `normal`."""
    normal = normal.normalized()
    along = (along - normal * along.dot(normal)).normalized()
    side = normal.cross(along)
    fr = Matrix((along, side, normal)).transposed()
    rings = []
    for t, k in ((-0.5, 0.85), (-0.25, 1.0), (0.25, 1.0), (0.5, 0.85)):
        rings.append((center + normal * (t * thick), fr, length / 2 * k, width / 2 * k, weights, expo))
    mb.loft(rings, region, segs=segs, cap_start=True, cap_end=True)


def ribbon(mb, pts, normals, width, thick, weights, region, segs=8):
    """A flat strap along a polyline lying on a surface with the given normals."""
    rings = []
    for i, (p, nrm) in enumerate(zip(pts, normals)):
        tan = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        nrm = (nrm - tan * nrm.dot(tan)).normalized()
        side = nrm.cross(tan)
        fr = Matrix((side, nrm, tan)).transposed()
        rings.append((p, fr, width / 2, thick / 2, weights[i] if isinstance(weights, list) else weights, 6.0))
    mb.loft(rings, region, segs=segs, cap_start=True, cap_end=True)


def _interp_profile(profile, z):
    """Linear interpolation of a (z, rx, ry, dy, ex, ...) profile at height z."""
    for a, b in zip(profile, profile[1:]):
        if a[0] <= z <= b[0]:
            t = (z - a[0]) / (b[0] - a[0])
            return tuple(x + (y - x) * t for x, y in zip(a[1:5], b[1:5]))
    row = profile[0] if z < profile[0][0] else profile[-1]
    return tuple(row[1:5])


def surface_front(profile, x, z, out=0.0):
    """Point and outward normal on the FRONT of a torso profile at (x, z)."""
    def pt(xx, zz):
        rx, ry, dy, ex = _interp_profile(profile, zz)
        k = min(abs(xx) / rx, 0.999)
        return Vector((xx, dy - ry * (1 - k ** ex) ** (1 / ex), zz))

    p = pt(x, z)
    tx = pt(x + 0.003, z) - pt(x - 0.003, z)
    tz = pt(x, z + 0.003) - pt(x, z - 0.003)
    n = tz.cross(tx).normalized()
    if n.y > 0:
        n = -n
    return p + n * out, n


# --- jacket ---------------------------------------------------------------------
# z, half-width, half-depth, y-shift, exponent, half-width of the open front.
JACKET_PROFILE = [
    # Waist-length bomber: the rib band sits at the belt line, gathered in
    # tighter than the shell above it (blouson), and the hoodie hem shows below.
    (0.885, 0.18, 0.133, 0.004, 2.5, 0.084),  # rib hem band
    (0.915, 0.181, 0.134, 0.004, 2.5, 0.082),
    (0.927, 0.19, 0.141, 0.003, 2.5, 0.08),  # the shell blouses over the band
    (0.975, 0.191, 0.142, 0.002, 2.45, 0.078),
    (1.04, 0.186, 0.138, 0.0, 2.4, 0.075),
    (1.12, 0.181, 0.137, -0.002, 2.35, 0.071),
    (1.2, 0.186, 0.14, -0.005, 2.3, 0.068),
    (1.28, 0.192, 0.144, -0.008, 2.3, 0.065),
    (1.34, 0.193, 0.145, -0.007, 2.25, 0.062),
    # Round, sloping shoulders that follow the body; the sleeve cap comes out
    # of the side and owns the shoulder point (see _clamp_under_sleeve).
    (1.38, 0.193, 0.143, -0.005, 2.2, 0.061),
    (1.415, 0.188, 0.139, -0.003, 2.1, 0.06),
    (1.44, 0.176, 0.133, 0.0, 2.05, 0.059),
    (1.456, 0.16, 0.126, 0.002, 2.0, 0.059),
    (1.467, 0.142, 0.119, 0.004, 2.0, 0.06),
    (1.475, 0.126, 0.113, 0.006, 2.0, 0.061),
    # stand collar
    (1.482, 0.116, 0.107, 0.008, 2.0, 0.063),
    (1.505, 0.112, 0.104, 0.01, 2.0, 0.068),
    (1.525, 0.112, 0.104, 0.012, 2.0, 0.075),
]
JACKET_THICK = 0.008
RIB_SEGMENTS = (0,)  # loft segments drawn as rib knit (the hem band)
JACKET_N_OUT = 40  # outer arc samples per ring (fine enough for a clean armhole)

# Bomber sleeve: t along the arm, radius-u, radius-v, region of the segment
# after it. A domed cap (rings inside the torso close like a ball), a roomy
# upper arm, and a rib cuff the shell blouses over.
SLEEVE = [
    (-0.058, 0.03, 0.03, "jacket"),
    (-0.045, 0.048, 0.047, "jacket"),
    (-0.025, 0.06, 0.059, "jacket"),
    (0.0, 0.066, 0.065, "jacket"),
    (0.04, 0.07, 0.069, "jacket"),
    (0.12, 0.07, 0.069, "jacket"),
    (0.2, 0.066, 0.065, "jacket"),
    (0.255, 0.064, 0.063, "jacket"),
    (0.285, 0.063, 0.062, "jacket"),
    (0.32, 0.062, 0.061, "jacket"),
    (0.4, 0.059, 0.058, "jacket"),
    (0.445, 0.057, 0.056, "jacket"),
    (0.458, 0.05, 0.049, "rib"),
    (0.5, 0.047, 0.046, "rib"),
    (0.512, 0.043, 0.042, "rib"),
]
SLEEVE_SEGS = 24
SLEEVE_DROP = 0.026  # the tube sits below the bone at the root (see _sleeve_axis)


def _sleeve_axis(side):
    """start, direction, frame and 'up-out' vector of one sleeve."""
    d = _arm_dir(side)
    fr = frame_from_axis(d, Vector((0, -1, 0)))
    return tail_of(("Left" if side == 1 else "Right") + "Shoulder"), d, fr, fr.col[0] * side


def _sleeve_centre(side, t):
    """Centre of the sleeve tube at t: a little below the bone near the root
    (the shoulder joint is well below the top of the shoulder), easing out
    by the biceps."""
    start, d, _, up = _sleeve_axis(side)
    return start + d * t - up * (SLEEVE_DROP * (1 - smooth01(t / 0.14)))


def _sleeve_radius(t):
    rows = [(s[0], s[1]) for s in SLEEVE]
    if t <= rows[0][0]:
        return rows[0][1]
    for (t0, r0), (t1, r1) in zip(rows, rows[1:]):
        if t <= t1:
            return r0 + (r1 - r0) * (t - t0) / (t1 - t0)
    return rows[-1][1]


def _body_depth(p):
    """How far p lies inside the jacket body shell (negative: outside)."""
    rx, ry, dy, ex = _interp_profile(JACKET_PROFILE, p.z)
    x, y = abs(p.x), p.y - dy
    m = ((x / rx) ** ex + (abs(y) / ry) ** ex) ** (1 / ex)
    return math.hypot(x, y) * (1 / max(m, 1e-6) - 1)


# The body shell is pushed in under the sleeve cap where it runs close to the
# sleeve surface: they meet at a steep angle along a clean line (covered by a
# seam welt) instead of weaving through each other along the shoulder.
CLAMP_REACH, CLAMP_PUSH = 0.016, 0.012


def _clamp_under_sleeve(p, w):
    """Returns the body point and weights, pushed under a nearby sleeve cap."""
    side = 1 if p.x > 0 else -1
    start, d, _, _ = _sleeve_axis(side)
    t = (p - start).dot(d)
    if not -0.066 < t < 0.26:
        return p, w
    c = _sleeve_centre(side, t)
    radial = (p - c) - d * (p - c).dot(d)
    dist = radial.length
    gap = dist - _sleeve_radius(t)
    if gap >= CLAMP_REACH or dist < 1e-6:
        return p, w
    k = smooth01((CLAMP_REACH - gap) / CLAMP_REACH)
    p = p - radial / dist * (CLAMP_PUSH * k)
    # The pushed band also borrows some of the cap's weights, so it moves with
    # the arm the way a real armhole does and the seam stays put.
    return p, lerp_w(w, _sleeve_w(("Left" if side == 1 else "Right"), max(t, 0.0)), 0.5 * k)


def _jacket_ring(z, rx, ry, dy, ex, gap, n_out=JACKET_N_OUT, n_in=10):
    """Open ring: outer arc from the left front edge around the back to the
    right front edge, then back along the inner face."""
    c = min(gap / rx, 0.99) ** (ex / 2)
    a0, a1 = -math.acos(c), math.pi + math.acos(c)

    def arc(r_x, r_y, count, rev):
        pts = []
        for k in range(count):
            t = k / (count - 1)
            a = a1 + (a0 - a1) * t if rev else a0 + (a1 - a0) * t
            cx, sy = _se(a, ex)
            pts.append(Vector((r_x * cx, dy + r_y * sy, z)))
        return pts

    return arc(rx, ry, n_out, False) + arc(rx - JACKET_THICK, ry - JACKET_THICK, n_in, True)


def add_jacket(mb):
    loops, wts, edges = [], [], []
    for z, rx, ry, dy, ex, gap in JACKET_PROFILE:
        loop, lw = [], []
        for p in _jacket_ring(z, rx, ry, dy, ex, gap):
            p, w = _clamp_under_sleeve(p, neckline_weights(z))
            loop.append(p)
            lw.append(w)
        loops.append(loop)
        wts.append(lw)
        edges.append((loop[0], loop[JACKET_N_OUT - 1]))
    loft_loops(mb, loops, wts, lambda i: "rib" if i in RIB_SEGMENTS else "jacket")
    # Collar top: a rolled edge so the stand collar has thickness at the top.
    top = JACKET_PROFILE[-1]
    ring = _jacket_ring(top[0] + 0.004, top[1] - JACKET_THICK / 2, top[2] - JACKET_THICK / 2, top[3], top[4], top[5] + 0.003)
    loft_loops(mb, [loops[-1], ring], [wts[-1], wts[-1]], "jacket")
    wts = [lw[0] for lw in wts]

    # Zip tapes down both front edges, from the hem to the collar top.
    for side in (0, 1):
        pts = [e[side] for e in edges]
        rings = []
        for i, p in enumerate(pts):
            tan = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            rings.append((p + Vector((0, 0.001, 0)), frame_from_axis(tan), 0.0045, 0.0055, wts[i], 2.2))
        mb.loft(rings, "strap", segs=8, cap_start=True, cap_end=True)

    # Sleeves: a roomy bomber sleeve with a rib cuff at the wrist.
    for side, pre in ((1, "Left"), (-1, "Right")):
        start, d, fr, up = _sleeve_axis(side)
        loops, wl = [], []
        for t, ru, rv, _ in SLEEVE:
            wl.append(_sleeve_w(pre, t))
            c = _sleeve_centre(side, t)
            loops.append([c + fr.col[0] * (ru * math.cos(a)) + fr.col[1] * (rv * math.sin(a))
                          for a in (2 * math.pi * k / SLEEVE_SEGS for k in range(SLEEVE_SEGS))])
        loft_loops(mb, loops, wl, lambda i: SLEEVE[i][3], cap_start=True)
        _armhole_welt(mb, side, pre)

        if side == 1:
            _sleeve_pocket(mb, pre, side, fr)

    # LED slits: one short vertical red slit on each front panel below the collar.
    for side in (1, -1):
        for z0 in (1.365,):
            p, n = surface_front(JACKET_PROFILE, 0.103 * side, z0, out=0.0012)
            slab(mb, p, Vector((0, 0, 1)), n, 0.034, 0.0042, 0.003, torso_weights(z0), "accent", segs=8)


def _sleeve_w(pre, t):
    if t < 0.05:
        # The cap, including the rings buried in the torso, turns mostly with
        # the arm: a ring left at the A-pose angle pokes a corner up out of the
        # shoulder when the arm hangs; the clavicle share keeps shrugs.
        return lerp_w({f"{pre}Shoulder": 0.35, f"{pre}Arm": 0.65}, {f"{pre}Arm": 1.0}, smooth01(max(t, 0.0) / 0.05))
    if t < UPPER_ARM - 0.05:
        return {f"{pre}Arm": 1.0}
    if t < UPPER_ARM + 0.05:
        k = smooth01((t - (UPPER_ARM - 0.05)) / 0.1)
        return {f"{pre}Arm": 1 - k, f"{pre}ForeArm": k}
    return {f"{pre}ForeArm": 1.0}


def _armhole_welt(mb, side, pre, n=32):
    """A thin raised seam where the sleeve cap meets the body shell. For each
    angle around the sleeve, march from the elbow toward the cap until the
    sleeve surface dips under the (clamped) body: the body crosses the sleeve
    where the unclamped shell is about 7 mm outside it."""
    _, d, fr, _ = _sleeve_axis(side)
    pts, wts = [], []
    for k in range(n + 1):
        a = 2 * math.pi * (k % n) / n
        radial = fr.col[0] * math.cos(a) + fr.col[1] * math.sin(a)
        t_hit = None
        t = 0.3
        while t > -0.066:
            q = _sleeve_centre(side, t) + radial * _sleeve_radius(t)
            if _body_depth(q) > 0.007:
                t_hit = t
                break
            t -= 0.002
        if t_hit is None:
            t_hit = -0.06
        pts.append(_sleeve_centre(side, t_hit) + radial * (_sleeve_radius(t_hit) + 0.0012))
        wts.append(_sleeve_w(pre, max(t_hit, 0.0)))
    rings = []
    for i, p in enumerate(pts):
        tan = (pts[(i + 1) % n] - pts[(i - 1) % n]).normalized()
        rings.append((p, frame_from_axis(tan), 0.0032, 0.0032, wts[i], 2.0))
    mb.loft(rings, "jacket", segs=6)


def _sleeve_pocket(mb, pre, side, fr):
    """Bellows pocket with a flap on the outer front of the upper arm (in the
    A-pose that is between the sleeve's u (up-out) and v (front) axes). It
    rides on the sleeve's own (dropped) axis, so it lies flat on the cloth."""
    ac = 0.75

    def r_at(t):  # sleeve radius under the pocket
        return _sleeve_radius(t)

    def c_at(t):
        return _sleeve_centre(side, t)

    def w_at(t):
        return _sleeve_w(pre, t)

    # A flat patch that follows the sleeve curvature (about 4 mm proud).
    rings = []
    for t, th, half in ((0.075, 0.0012, 0.36), (0.08, 0.004, 0.42), (0.175, 0.004, 0.42), (0.18, 0.0012, 0.36)):
        rings.append((c_at(t), fr, r_at(t) - 0.004, r_at(t) + th, ac, half, w_at(t)))
    arc_shell(mb, rings, 10, "jacket")
    rings = []
    for t, th, half in ((0.064, 0.003, 0.44), (0.068, 0.0065, 0.47), (0.098, 0.0065, 0.47), (0.102, 0.005, 0.44)):
        rings.append((c_at(t), fr, r_at(t) - 0.002, r_at(t) + th, ac, half, w_at(t)))
    arc_shell(mb, rings, 10, "jacket")
    # Small red mark on the flap (a spark, smaller than the chest slits).
    a = ac + 0.2
    nrm = fr.col[0] * math.cos(a) + fr.col[1] * math.sin(a)
    _, d, _, _ = _sleeve_axis(side)
    c = c_at(0.083) + nrm * (r_at(0.083) + 0.007)
    slab(mb, c, d, nrm, 0.011, 0.0028, 0.0018, w_at(0.083), "accent", segs=8)


# --- harness --------------------------------------------------------------------
def harness_weights(z):
    """Torso weights without the neck share: the webbing rides the rib cage
    rigidly, so head turns in Talk/Idle do not tug the straps."""
    return torso_weights(min(z, 1.38))


def _harness_x(z):
    """Half spacing of the two front straps: they come in from the shoulders
    to the sternum buckle and run on down, slightly apart, to the waist strap."""
    if z >= HARNESS_STERNUM:
        return 0.044 + 0.022 * smooth01((z - HARNESS_STERNUM) / (1.47 - HARNESS_STERNUM))
    return 0.044 + 0.008 * smooth01((HARNESS_STERNUM - z) / (HARNESS_STERNUM - HARNESS_WAIST))


HARNESS_STERNUM = 1.285  # sternum strap / buckle height
HARNESS_WAIST = 0.958  # waist strap, just above the jacket's rib hem


def add_harness(mb):
    """H-harness over the hoodie and under the open jacket: two straps from
    the shoulders down past a sternum strap with a side-release buckle to a
    waist strap; the side ends run in under the jacket."""
    zb, zw = HARNESS_STERNUM, HARNESS_WAIST
    for side in (1, -1):
        pts, nrms, wts = [], [], []
        n_pts = 17
        for i in range(n_pts):
            z = 1.47 - (1.47 - zw) * i / (n_pts - 1)
            p, n = surface_front(HOODIE_PROFILE, side * _harness_x(z), z, out=0.003)
            pts.append(p); nrms.append(n); wts.append(harness_weights(z))
        ribbon(mb, pts, nrms, 0.026, 0.004, wts, "strap")
        # Adjuster loops on the strap above the buckle and a tri-glide where
        # it meets the waist strap.
        for z, h in ((1.36, 0.012), (zw + 0.004, 0.016)):
            p, n = surface_front(HOODIE_PROFILE, side * _harness_x(z), z, out=0.0065)
            slab(mb, p, Vector((0, 0, 1)), n, h, 0.031, 0.004, harness_weights(z), "buckle", segs=8)
    for z, width in ((zb, 0.024), (zw, 0.026)):
        pts, nrms = [], []
        for i in range(13):
            x = -0.16 + 0.32 * i / 12
            p, n = surface_front(HOODIE_PROFILE, x, z, out=0.0045)
            pts.append(p); nrms.append(n)
        ribbon(mb, pts, nrms, width, 0.004, harness_weights(z), "strap")
    # Side-release buckle: body plate, a raised centre bar and two prongs.
    p, n = surface_front(HOODIE_PROFILE, 0.0, zb, out=0.01)
    w = harness_weights(zb)
    slab(mb, p, Vector((1, 0, 0)), n, 0.062, 0.036, 0.008, w, "buckle", segs=12)
    slab(mb, p + n * 0.0045, Vector((1, 0, 0)), n, 0.014, 0.027, 0.004, w, "buckle", segs=8)
    for side in (1, -1):
        slab(mb, p + Vector((0.021 * side, 0, 0)) + n * 0.004, Vector((0, 0, 1)), n, 0.028, 0.0035, 0.003, w, "strap", segs=6)
    # Small cam buckle on the waist strap.
    p, n = surface_front(HOODIE_PROFILE, 0.0, zw, out=0.008)
    slab(mb, p, Vector((1, 0, 0)), n, 0.034, 0.03, 0.006, harness_weights(zw), "buckle", segs=12)


def add_hoodie_pocket(mb):
    """Kangaroo pocket on the hoodie front, seen between the open jacket
    fronts and below its rib hem."""
    zs = (0.877, 0.881, 0.93, 0.935)
    xs = [-0.11 + 0.22 * k / 12 for k in range(13)]
    loops, wts = [], []
    for z in zs:
        th = 0.0045 if 0.88 < z < 0.932 else 0.0015
        outer = [surface_front(HOODIE_PROFILE, x * (0.92 if z > 0.925 else 1.0), z, out=th)[0] for x in xs]
        inner = [surface_front(HOODIE_PROFILE, x, z, out=-0.002)[0] for x in reversed(xs)]
        loops.append(outer + inner)
        wts.append(torso_weights(z))
    loft_loops(mb, loops, wts, "hoodie", cap_start=True, cap_end=True)


# --- pants ------------------------------------------------------------------------
# t along the thigh, radius, Hips share, Leg (knee) share. t=None is the knee end.
THIGH_RINGS = [(-0.03, 0.086, 0.55, 0.0), (0.03, 0.088, 0.25, 0.0), (0.1, 0.088, 0.0, 0.0),
               (0.2, 0.085, 0.0, 0.0), (0.3, 0.078, 0.0, 0.0), (None, 0.072, 0.0, 0.2)]
# The top of the thigh tube leans in toward the crotch so the hips stay under
# the hoodie hem (metres of inward shift at t, fading out by t=0.15).
THIGH_TUCK = 0.009

# t along the shin, radius, UpLeg share, region of the segment after it.
# Tapered to the ankle like a jogger, with two shallow folds down the shin
# (they also crease behind the knee), a soft stack (bunched rings) above the
# rib cuff, which tucks into the boot collar.
SHIN_RINGS = [(0.0, 0.07, 0.5, "pants"), (0.04, 0.068, 0.2, "pants"), (0.07, 0.067, 0.0, "pants"),
              (0.085, 0.0635, 0.0, "pants"), (0.1, 0.0655, 0.0, "pants"), (0.13, 0.06, 0.0, "pants"),
              (0.145, 0.0605, 0.0, "pants"), (0.165, 0.055, 0.0, "pants"), (0.183, 0.0525, 0.0, "pants"),
              (0.197, 0.0565, 0.0, "pants"), (0.21, 0.052, 0.0, "pants"), (0.222, 0.0555, 0.0, "pants"),
              (0.232, 0.05, 0.0, "rib"), (0.27, 0.048, 0.0, "pants"), (0.3, 0.044, 0.0, "pants"),
              (0.36, 0.042, 0.0, "pants")]


def thigh_radius(t, thigh_len):
    rows = [(thigh_len - 0.04 if tt is None else tt, r) for tt, r, _, _ in THIGH_RINGS]
    for (t0, r0), (t1, r1) in zip(rows, rows[1:]):
        if t0 <= t <= t1:
            return r0 + (r1 - r0) * (t - t0) / (t1 - t0)
    return rows[-1][1]


def _leg(pre):
    hip, knee, ankle = head_of(f"{pre}UpLeg"), head_of(f"{pre}Leg"), head_of(f"{pre}Foot")
    thigh_d, shin_d = (knee - hip).normalized(), (ankle - knee).normalized()
    return (hip, knee, thigh_d, shin_d, (knee - hip).length,
            frame_from_axis(-thigh_d, Vector((0, -1, 0))), frame_from_axis(-shin_d, Vector((0, -1, 0))))


def add_cargo_pants(mb):
    # The seat stays close to the thighs (it shows below the raised hoodie hem).
    pelvis = [
        (1.0, 0.152, 0.11, 0.0),
        (0.93, 0.157, 0.112, 0.004),
        (0.865, 0.155, 0.104, 0.006),
        (0.825, 0.132, 0.092, 0.008),
        (0.79, 0.086, 0.07, 0.008),
    ]
    rings = [(Vector((0, dy, z)), Z, rx, ry, {"Hips": 1.0}, 2.6) for z, rx, ry, dy in pelvis]
    mb.loft(rings, "pants", segs=24, cap_end=True)

    for side, pre in ((1, "Left"), (-1, "Right")):
        hip, knee, thigh_d, shin_d, thigh_len, fr_t, fr_s = _leg(pre)
        loops, wl, regs = [], [], []
        # The thigh frame's u axis is -X: angle pi is the character's left.
        inward = Vector((-side, 0, 0))
        for t, r, hs, ks in THIGH_RINGS:
            t = thigh_len - 0.04 if t is None else t
            c = hip + thigh_d * t + inward * (THIGH_TUCK * (1 - smooth01(t / 0.15)))
            loops.append([c + fr_t.col[0] * (r * math.cos(a)) + fr_t.col[1] * (r * 0.98 * math.sin(a))
                          for a in (2 * math.pi * k / 20 for k in range(20))])
            base = {f"{pre}UpLeg": 1.0 - hs - ks}
            if hs:
                base["Hips"] = hs
            if ks:
                base[f"{pre}Leg"] = ks
            wl.append(base)
            regs.append("pants")
        for t, r, us, reg in SHIN_RINGS:
            c = knee + shin_d * t
            loops.append([c + fr_s.col[0] * (r * math.cos(a)) + fr_s.col[1] * (r * math.sin(a))
                          for a in (2 * math.pi * k / 20 for k in range(20))])
            wl.append({f"{pre}UpLeg": us, f"{pre}Leg": 1.0 - us} if us else {f"{pre}Leg": 1.0})
            regs.append(reg)
        loft_loops(mb, loops, wl, lambda i, rg=regs: rg[i])

        # Cargo pocket with a flap at mid-thigh, on the outer front. A flat
        # bellows (about 1.3 cm) with rounded edges: the rim rings step up.
        ac = math.pi / 2 + side * 0.95
        w = {f"{pre}UpLeg": 1.0}

        def r_at(t):
            return thigh_radius(t, thigh_len)

        def nrm_at(a):
            return fr_t.col[0] * math.cos(a) + fr_t.col[1] * math.sin(a)

        rings = []
        for t, th, half in ((0.225, 0.002, 0.5), (0.231, 0.009, 0.56), (0.24, 0.013, 0.59),
                            (0.36, 0.013, 0.59), (0.369, 0.009, 0.56), (0.375, 0.002, 0.5)):
            rings.append((hip + thigh_d * t, fr_t, r_at(t) - 0.005, r_at(t) + th, ac, half, w))
        arc_shell(mb, rings, 12, "pants")
        rings = []
        for t, th, half in ((0.212, 0.008, 0.6), (0.217, 0.017, 0.64), (0.262, 0.017, 0.64), (0.267, 0.012, 0.61)):
            rings.append((hip + thigh_d * t, fr_t, r_at(t) - 0.004, r_at(t) + th, ac, half, w))
        arc_shell(mb, rings, 12, "pants")
        # Flap snap tab.
        slab(mb, hip + thigh_d * 0.262 + nrm_at(ac) * (r_at(0.262) + 0.0175), thigh_d, nrm_at(ac),
             0.018, 0.016, 0.003, w, "strap", segs=8)

        # Knee panel: a low (3 mm) patch over the front of the knee, riding on
        # the pants rings underneath (same weights), so it bends with the knee.
        # Its ends narrow in steps, so the top and bottom edges read curved
        # and it blends into the leg instead of being a flat plaque.
        rings = []
        for seg, t, th, half in (("t", thigh_len - 0.04, 0.0005, 0.2), ("t", thigh_len - 0.036, 0.0015, 0.42),
                                 ("t", thigh_len - 0.028, 0.0028, 0.58), ("t", thigh_len - 0.01, 0.003, 0.66),
                                 ("s", 0.012, 0.003, 0.66), ("s", 0.032, 0.0028, 0.58),
                                 ("s", 0.041, 0.0015, 0.42), ("s", 0.046, 0.0005, 0.2)):
            if seg == "t":
                c, fr, r = hip + thigh_d * t, fr_t, r_at(t)
                ks = 0.2 * smooth01((t - (thigh_len - 0.08)) / 0.04)
                wt = {f"{pre}UpLeg": 1 - ks, f"{pre}Leg": ks}
            else:
                c, fr, r = knee + shin_d * t, fr_s, 0.07 - 0.05 * t
                us = 0.5 * (1 - smooth01(t / 0.08))
                wt = {f"{pre}UpLeg": us, f"{pre}Leg": 1 - us}
            rings.append((c, fr, r - 0.004, r + th, math.pi / 2, half, wt))
        arc_shell(mb, rings, 10, "pants")

        # Hanging strap on the front of the right thigh, just in front of the
        # pocket: from under the hoodie hem down past the pocket, the loose end
        # standing off the leg, with a metal end tip.
        if side == -1:
            a = math.pi / 2 + side * 0.3
            pts, nrms, wts = [], [], []
            n_pts = 10
            for i in range(n_pts):
                t = 0.09 + 0.26 * i / (n_pts - 1)
                sway = 0.003 + 0.01 * smooth01((t - 0.24) / 0.11)
                pts.append(hip + thigh_d * t + nrm_at(a) * (r_at(t) + sway))
                nrms.append(nrm_at(a))
                wts.append(w)
            ribbon(mb, pts, nrms, 0.024, 0.003, wts, "strap")
            slab(mb, pts[-1] - thigh_d * 0.006, thigh_d, nrms[-1], 0.014, 0.027, 0.005, w, "buckle", segs=8)


# --- boots --------------------------------------------------------------------------
# The upper is one surface of horizontal slices, so the shaft flows into the
# vamp without a step: high slices are the oval around the ankle, lower ones
# reach further toward the toe (their front edge draws the instep slope), and
# the bottom slices are the whole foot outline.
# Front edge (y) of the upper per height: the toe, a low toe box, the instep.
BOOT_FRONT = [(0.03, -0.199), (0.042, -0.204), (0.055, -0.198), (0.066, -0.18), (0.076, -0.15),
              (0.087, -0.115), (0.1, -0.084), (0.113, -0.062), (0.126, -0.049), (0.14, -0.043)]
# Back edge per height: the heel counter bulges a little above the sole.
BOOT_BACK = [(0.03, 0.074), (0.05, 0.082), (0.08, 0.083), (0.11, 0.078), (0.14, 0.073)]
# Foot outline half-width along y: narrow heel, widest at the ball, slim toe.
BOOT_OUTLINE = [(0.085, 0.036), (0.06, 0.041), (0.02, 0.043), (-0.03, 0.045), (-0.08, 0.048),
                (-0.12, 0.048), (-0.16, 0.042), (-0.19, 0.032), (-0.21, 0.016)]
# Shaft above the instep: z, half-width (depth is SHAFT_DEPTH times that),
# with a padded collar on top that the pants' rib cuff tucks into.
BOOT_SHAFT = [(0.16, 0.046), (0.185, 0.046), (0.2, 0.048), (0.211, 0.051), (0.221, 0.05), (0.228, 0.046)]
SHAFT_DEPTH = 1.17
SHAFT_Y = 0.018  # shaft centre (over the ankle)
BOOT_SEGS = 28


def _table(rows, x):
    """Piecewise-linear lookup in a (key, value) table sorted by key."""
    rows = sorted(rows)
    if x <= rows[0][0]:
        return rows[0][1]
    for (x0, v0), (x1, v1) in zip(rows, rows[1:]):
        if x <= x1:
            return v0 + (v1 - v0) * (x - x0) / (x1 - x0)
    return rows[-1][1]


def _boot_slice(z):
    """(front y, back y, width fn(y), exponent) of the upper at height z."""
    up = smooth01((z - 0.045) / 0.1)
    if z >= BOOT_SHAFT[0][0]:
        rx = _table(BOOT_SHAFT, z)
        return SHAFT_Y - rx * SHAFT_DEPTH, SHAFT_Y + rx * SHAFT_DEPTH, (lambda y, rx=rx: rx), 2.2
    yf, yb = _table(BOOT_FRONT, z), _table(BOOT_BACK, z)
    if z > BOOT_FRONT[-1][0]:  # ease the instep into the shaft
        s = smooth01((z - BOOT_FRONT[-1][0]) / (BOOT_SHAFT[0][0] - BOOT_FRONT[-1][0]))
        r0 = BOOT_SHAFT[0][1]
        yf += (SHAFT_Y - r0 * SHAFT_DEPTH - yf) * s
        yb += (SHAFT_Y + r0 * SHAFT_DEPTH - yb) * s
    k = smooth01((z - 0.1) / 0.06)
    ex = 3.5 + (2.2 - 3.5) * k

    def width(y):
        foot = _table(BOOT_OUTLINE, y) * (1 - 0.1 * up)
        return foot + (BOOT_SHAFT[0][1] - foot) * k

    return yf, yb, width, ex


def _boot_weights(pre, y, z):
    F, T, L = {f"{pre}Foot": 1.0}, {f"{pre}ToeBase": 1.0}, {f"{pre}Leg": 1.0}
    w = lerp_w(F, T, smooth01((-0.075 - y) / 0.04))
    return lerp_w(w, L, smooth01((z - 0.1) / 0.09))


def _toe_spring(y, z):
    """The toe lifts off the floor a little (more at the bottom)."""
    return 0.011 * smooth01((-0.16 - y) / 0.045) * (1 - smooth01((z - 0.03) / 0.08))


def _boot_panel(mb, pre, x, zs, y_cut, front, n=17, lift=0.0018, sink=0.003):
    """A patch on the upper, about 2 mm proud: the part of each slice in front
    of (front=True) or behind y_cut(z), sampled evenly from one cut edge
    around the toe or heel to the other, so its edge is a clean curve. Like
    arc_shell it runs out along the outer face and back along a buried inner
    one, so the edge has thickness."""
    rows = []
    for z in zs:
        yf, yb, width, ex = _boot_slice(z)
        yc, ry = (yf + yb) / 2, (yb - yf) / 2
        s_cut = max(-0.999, min(0.999, (y_cut(z) - yc) / ry))
        # Superellipse angle of the cut on the +x side; the patch spans from
        # there around the toe (-pi/2) or the heel (+pi/2) to the -x side,
        # sampled evenly in angle like the upper itself.
        a_c = math.asin(math.copysign(abs(s_cut) ** (ex / 2), s_cut))
        a_end = (-math.pi - a_c) if front else (math.pi - a_c)

        def arc(off, rev, dz=0.0):
            pts = []
            for i in range(n):
                f = (n - 1 - i if rev else i) / (n - 1)
                cx, sy = _se(a_c + (a_end - a_c) * f, ex)
                y = yc + ry * sy
                # Offset along the slice's outward normal (approximately).
                nx, ny = cx / max(width(y), 1e-6), sy / ry
                nl = math.hypot(nx, ny) or 1.0
                pts.append(Vector((x + width(y) * cx + off * nx / nl, y + off * ny / nl, z + dz + _toe_spring(y, z))))
            return pts

        rows.append(arc(lift, False) + arc(-sink, True))
    # A rounded lip closes the top edge.
    mid = (lift - sink) / 2
    rows.append(arc(mid + 0.0004, False, 0.0016) + arc(mid, True, 0.0016))
    loft_loops(mb, rows, [[_boot_weights(pre, p.y, p.z) for p in row] for row in rows], "sole")


def add_combat_boots(mb):
    Y = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))  # axis = -Y (toward the toes)
    for side, pre in ((1, "Left"), (-1, "Right")):
        x = 0.095 * side
        F, T = {f"{pre}Foot": 1.0}, {f"{pre}ToeBase": 1.0}

        # Upper: closed at the bottom (on the sole), open at the collar, with
        # an inner lip so the collar has thickness.
        zs = [0.03, 0.042, 0.055, 0.066, 0.076, 0.087, 0.1, 0.113, 0.126, 0.14, 0.16, 0.185, 0.2, 0.211,
              0.221, 0.228]
        rows = []
        for z in zs:
            yf, yb, width, ex = _boot_slice(z)
            yc, ry = (yf + yb) / 2, (yb - yf) / 2
            row = []
            for k in range(BOOT_SEGS):
                cx, sy = _se(2 * math.pi * k / BOOT_SEGS, ex)
                y = yc + ry * sy
                p = Vector((x + width(y) * cx, y, z + _toe_spring(y, z)))
                row.append(p)
            rows.append(row)
        lip = [Vector((x + (p.x - x) * 0.95, SHAFT_Y + (p.y - SHAFT_Y) * 0.95, 0.214)) for p in rows[-1]]
        rows.append(lip)
        loft_loops(mb, rows, [[_boot_weights(pre, p.y, p.z) for p in row] for row in rows], "boots",
                   cap_start=True)
        # Toe cap and heel counter: thin overlaid panels in the tougher
        # (darker, rougher) material, cut along smooth edges.
        _boot_panel(mb, pre, x, (0.03, 0.042, 0.055, 0.064), lambda z: -0.148 + 0.35 * (z - 0.03), front=True)
        _boot_panel(mb, pre, x, (0.03, 0.05, 0.07, 0.086), lambda z: 0.052 - 0.25 * (z - 0.03), front=False)

        # Chunky lugged sole: blocks and grooves along the length read as lugs
        # from the side; the toe springs up with the upper.
        def sole_hw(y):
            return _table(BOOT_OUTLINE, y) * 1.06 + 0.005

        def sole_w(y):
            return F if y > -0.08 else (lerp_w(F, T, 0.5) if y > -0.11 else T)

        rings = []
        y = 0.088
        while y > -0.2:
            for dy, inset in ((0.0, 0.0), (-0.014, 0.0), (-0.016, 0.005)):
                yy = y + dy
                if yy < -0.2:
                    break
                rings.append((Vector((x, yy, 0.015 + _toe_spring(yy, 0.0))), Y, sole_hw(yy) - inset,
                              0.015 - inset * 0.3, sole_w(yy), 6.0))
            y -= 0.022
        rings.append((Vector((x, -0.206, 0.026 + _toe_spring(-0.206, 0.0))), Y, 0.02, 0.008, T, 6.0))
        mb.loft(rings, "sole", segs=8, cap_start=True, cap_end=True)
        # Welt: a thin rim where the upper meets the sole.
        rings = [(Vector((x, yy, 0.031 + _toe_spring(yy, 0.0))), Y, sole_hw(yy) * 1.02 + 0.002, 0.004, sole_w(yy), 6.0)
                 for yy in (0.084, 0.06, 0.0, -0.06, -0.12, -0.17, -0.197)]
        mb.loft(rings, "sole", segs=12, cap_start=True, cap_end=True)

        # The lacing runs down the front edge of the upper from the collar to
        # the toe box: (y, z) points and the outward normal of that curve.
        path = [Vector((x, _boot_slice(z)[0], z)) for z in (0.214, 0.19, 0.165, 0.145, 0.13, 0.117, 0.105, 0.094, 0.083)]
        path = [p + Vector((0, 0, _toe_spring(p.y, p.z))) for p in path]

        def along(s):
            """Point, tangent (downward) and outward normal at arc fraction s."""
            lengths = [0.0]
            for a, b in zip(path, path[1:]):
                lengths.append(lengths[-1] + (b - a).length)
            target = s * lengths[-1]
            for i in range(len(path) - 1):
                if target <= lengths[i + 1] or i == len(path) - 2:
                    t = (target - lengths[i]) / max(lengths[i + 1] - lengths[i], 1e-9)
                    tan = (path[i + 1] - path[i]).normalized()
                    nrm = Vector((0, -tan.z, tan.y))
                    if nrm.y > 0:
                        nrm = -nrm
                    return path[i].lerp(path[i + 1], t), tan, nrm.normalized()

        # Tongue: a padded strip up the front that rises above the collar.
        pts = [along(s)[0] + along(s)[2] * -0.0015 for s in (0.3, 0.2, 0.1, 0.0)]
        pts.append(Vector((x, _boot_slice(0.226)[0] - 0.004, 0.243)))
        ribbon(mb, pts, [along(0.0)[2]] * len(pts), 0.03, 0.005, [_boot_weights(pre, p.y, p.z) for p in pts], "boots")

        # Crossed laces, recessed between the eyelets (speed hooks on the
        # shaft, flat eyelets on the vamp).
        n_cross = 6
        for i in range(n_cross):
            p, tan, nrm = along(0.04 + 0.92 * i / (n_cross - 1))
            wt = _boot_weights(pre, p.y, p.z)
            for s in (1, -1):
                slab(mb, p + nrm * 0.0005, Vector((1, 0, 0)) + tan * (0.45 * s), nrm, 0.03, 0.0034, 0.0026, wt, "rib", segs=4)
            hook = p.z > 0.14
            for s in (1, -1):
                q = p + Vector((s * 0.0175, 0.0025 if hook else 0.001, 0)) + nrm * 0.0005
                slab(mb, q, tan, nrm, 0.0065 if hook else 0.005, 0.0055 if hook else 0.005, 0.0035 if hook else 0.0022,
                     wt, "buckle", segs=6)


# --- gloves -------------------------------------------------------------------------
def _glove_finger(mb, hand, b1, b2, thick, wide):
    """One padded glove finger over two phalanx bones: a single continuous
    shell (no robot joint balls) that starts flared inside the palm, so the
    finger grows out of it without a pinch, fuller at the middle knuckle,
    with a round tip. `thick` is the radius across the palm normal, `wide`
    across the hand."""
    h1, j, t2 = head_of(b1), tail_of(b1), tail_of(b2)
    a1, a2 = (j - h1).normalized(), (t2 - j).normalized()
    ax_j = (a1 + a2).normalized()
    w1, w2, wj = {b1: 1.0}, {b2: 1.0}, {b1: 0.5, b2: 0.5}
    rings = [
        (h1 - a1 * 0.018, frame_from_axis(a1), thick * 1.25, wide * 1.08, {hand: 1.0}, 2.6),
        (h1 - a1 * 0.004, frame_from_axis(a1), thick * 1.12, wide * 1.06, {hand: 0.5, b1: 0.5}, 2.5),
        (h1.lerp(j, 0.5), frame_from_axis(a1), thick * 1.03, wide * 1.02, w1, 2.3),
        (j, frame_from_axis(ax_j), thick * 1.06, wide * 1.03, wj, 2.3),
        (j.lerp(t2, 0.5), frame_from_axis(a2), thick * 0.98, wide * 0.97, w2, 2.3),
        (t2 - a2 * 0.004, frame_from_axis(a2), thick * 0.9, wide * 0.9, w2, 2.3),
        (t2 + a2 * 0.002, frame_from_axis(a2), thick * 0.62, wide * 0.62, w2, 2.3),
    ]
    mb.loft(rings, "glove", segs=8, cap_start=True, cap_end=True)


def add_gloves(mb):
    """Tactical gloves on the rig's hand bones: a padded gauntlet cuff that
    overlaps the jacket rib (no bare wrist), a thick padded palm that the
    fingers grow out of, one raised knuckle plate across the back of the hand
    and padded one-piece fingers that sit close together."""
    for side, pre in ((1, "Left"), (-1, "Right")):
        d = _arm_dir(side)
        n = _palm_normal(side)
        wrist = head_of(f"{pre}Hand")
        fr = frame_from_axis(d)  # u: across the palm normal (-n), v: across the hand
        fa, hd = {f"{pre}ForeArm": 1.0}, {f"{pre}Hand": 1.0}
        # Gauntlet: starts inside the sleeve rib, flares over its end to about
        # 1.6x the wrist and closes onto the palm.
        cuff = [
            (-0.055, 0.034, 0.038, fa),
            (-0.032, 0.04, 0.045, fa),
            (-0.017, 0.046, 0.051, fa),
            (-0.004, 0.047, 0.053, lerp_w(fa, hd, 0.3)),
            (0.01, 0.043, 0.05, lerp_w(fa, hd, 0.7)),
            (0.02, 0.033, 0.045, hd),
        ]
        rings = [(wrist + d * t, fr, ru, rv, w, 2.2) for t, ru, rv, w in cuff]
        mb.loft(rings, "glove", segs=16)
        # Hook-and-loop strap: a low band in the glove's own black.
        rings = [(wrist + d * t, fr, ru, rv, lerp_w(fa, hd, 0.3), 2.4)
                 for t, ru, rv in ((-0.013, 0.046, 0.052), (-0.011, 0.0488, 0.0548),
                                   (0.001, 0.0488, 0.0548), (0.003, 0.047, 0.053))]
        mb.loft(rings, "glove", segs=16)
        # Palm: a padded, slightly boxy shell from the cuff to the finger
        # roots; its end tapers to the fingers' thickness.
        palm = [(0.012, 0.025, 0.037), (0.03, 0.021, 0.042), (0.055, 0.0195, 0.044),
                (0.075, 0.0175, 0.044), (0.085, 0.0145, 0.042), (0.09, 0.011, 0.036)]
        mb.loft([(wrist + d * t, fr, ru, rv, hd, 2.8) for t, ru, rv in palm], "glove", segs=16,
                cap_start=True, cap_end=True)
        # Knuckle guard: one raised plate across the back of the hand over the
        # finger roots, and a flatter padded plate behind it.
        side_axis = Vector((0, 1, 0))
        slab(mb, wrist + d * 0.074 - n * 0.0195, side_axis, -n, 0.082, 0.024, 0.0075, hd, "strap", segs=12)
        slab(mb, wrist + d * 0.045 - n * 0.0205, side_axis, -n, 0.064, 0.03, 0.005, hd, "glove", segs=12)
        for fname, thick, wide in (("Index", 0.0112, 0.0096), ("Middle", 0.0116, 0.0098),
                                   ("Ring", 0.0112, 0.0096), ("Pinky", 0.0102, 0.0089)):
            _glove_finger(mb, f"{pre}Hand", f"{pre}Hand{fname}1", f"{pre}Hand{fname}2", thick, wide)
        _glove_finger(mb, f"{pre}Hand", f"{pre}HandThumb1", f"{pre}HandThumb2", 0.0128, 0.0122)


# --- mask ---------------------------------------------------------------------------
MASK_TOP = 1.678  # peak of the upper edge, over the nose bridge between the eyes
MASK_BOTTOM = 1.452  # the gaiter tucks into the collar here
MASK_SEGS = 48
MASK_CENTRE = (0.0, -0.004)
MASK_SAG = 0.3  # how far the fabric sags from the tent toward the face (0..1)
# Gaiter around the neck: inside the hood's tucked base (head.HOOD_NECK) and
# the hoodie's funnel neck, with room for head turns.
NECK_RX, NECK_RY, NECK_DY = 0.062, 0.064, 0.006


def mask_top(a):
    """Height of the mask's upper edge at angle `a` from the front: it rises
    over the nose bridge, runs about 1 cm under the eyes and dips under the
    cheekbones toward the sides."""
    return 1.65 + 0.016 * math.exp(-((a / 0.55) ** 2)) + (MASK_TOP - 1.666) * math.exp(-((a / 0.13) ** 2))


def _hull2d(pts):
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def _polar(poly, phis):
    """Distance from MASK_CENTRE to a convex polygon along each angle."""
    cx, cy = MASK_CENTRE
    out = []
    for ph in phis:
        dx, dy = math.cos(ph), math.sin(ph)
        best = 0.0
        for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
            ex, ey = x1 - x0, y1 - y0
            den = dx * ey - dy * ex
            if abs(den) < 1e-12:
                continue
            t = ((x0 - cx) * ey - (y0 - cy) * ex) / den
            s = ((x0 - cx) * dy - (y0 - cy) * dx) / den
            if t > 0 and -1e-9 <= s <= 1 + 1e-9:
                best = max(best, t)
        out.append(best)
    return out


def _polar_max(band, phis):
    """Outermost band point per angular bin (the real, non-convex outline)."""
    cx, cy = MASK_CENTRE
    step = 2 * math.pi / len(phis)
    out = [0.0] * len(phis)
    for x, y in band:
        a = math.atan2(y - cy, x - cx)
        k = int(round((a - phis[0]) / step)) % len(phis)
        out[k] = max(out[k], math.hypot(x - cx, y - cy))
    return out


def _hood_inside(zs, phis):
    """Per sample height: the hood's innermost radius per angular bin around
    MASK_CENTRE (0 where the hood has no cloth, e.g. the face opening). The
    gaiter stays inside the hood's under-chin section."""
    cx, cy = MASK_CENTRE
    pts = []
    for i in range(1, 90):
        th = math.pi * (0.5 + 0.5 * i / 90)
        for j in range(160):
            ph = 2 * math.pi * j / 160
            d = Vector((math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)))
            if d.z > -0.82 and not _in_opening(d):
                pts.append(hood_point(d))
    step = 2 * math.pi / len(phis)
    out = []
    for z in zs:
        row = [0.0] * len(phis)
        for p in pts:
            if abs(p.z - z) < 0.004:
                k = int(round((math.atan2(p.y - cy, p.x - cx) - phis[0]) / step)) % len(phis)
                r = math.hypot(p.x - cx, p.y - cy)
                row[k] = r if row[k] == 0.0 else min(row[k], r)
        out.append(row)
    return out


def _mask_weights(z):
    # Ends at body.NECKLINE_W, like the hood base and the hoodie funnel.
    s = smooth01((1.585 - z) / 0.08)
    return {"Head": 1 - s, "Neck": s * 0.45, "Spine2": s * 0.55}


def _interp_col(zs, rs, z):
    """Radius at height z along one column (zs descending)."""
    for (z0, r0), (z1, r1) in zip(zip(zs, rs), zip(zs[1:], rs[1:])):
        if z1 <= z <= z0:
            return r0 + (r1 - r0) * (z0 - z) / max(z0 - z1, 1e-9)
    return rs[0] if z > zs[0] else rs[-1]


def add_mask(mb):
    """Fabric stretched over the android's lower face. Each horizontal slice is
    the convex hull of the head's cross-section (the fabric tents from the nose
    to the cheeks), each vertical column its concave envelope (it tents from
    the nose tip to the chin); then the fabric sags part of the way back
    toward the face, so the nose ridge and the chin read under it. Below the
    chin it drapes down into a neck gaiter."""
    # Fine sample heights over the face, then the gaiter rows.
    zs = []
    z = MASK_TOP + 0.004
    while z > 1.556:
        zs.append(z)
        z -= 0.004
    zs += [1.548, 1.53, 1.51, 1.49, 1.47, MASK_BOTTOM]

    # Dense samples of the sculpted head surface plus the ear modules.
    pts = []
    n_th, n_ph = 160, 200
    for i in range(n_th + 1):
        th = math.pi * (0.25 + 0.75 * i / n_th)
        for j in range(n_ph):
            ph = 2 * math.pi * j / n_ph
            d = Vector((math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)))
            pts.append(head_point(d))
    for s in (1, -1):
        for k in range(24):
            a = 2 * math.pi * k / 24
            for dx in (0.0, 0.017):
                pts.append(Vector((s * (0.074 + dx), 0.004 + 0.03 * math.cos(a), 1.667 + 0.03 * math.sin(a))))

    phis = [-math.pi / 2 + 2 * math.pi * k / MASK_SEGS for k in range(MASK_SEGS)]
    fronts = [abs(math.remainder(ph + math.pi / 2, 2 * math.pi)) for ph in phis]
    tops = [mask_top(a) for a in fronts]
    cx, cy = MASK_CENTRE
    hull, surf = [], []
    for z in zs:
        band = [(p.x, p.y) for p in pts if abs(p.z - z) < 0.004]
        if z < 1.5:
            band = []
        # The neck ellipse holds up the bottom of the gaiter.
        if z < 1.56:
            band += [(NECK_RX * math.cos(a), NECK_DY + NECK_RY * math.sin(a))
                     for a in (2 * math.pi * k / 32 for k in range(32))]
        ok = len(band) >= 3
        hull.append(_polar(_hull2d(band), phis) if ok else [0.0] * MASK_SEGS)
        surf.append(_polar_max(band, phis) if ok else [0.0] * MASK_SEGS)

    # Per column: the upper concave envelope of the hull radii r(z), using only
    # the heights the mask covers there, then the sag toward the real surface.
    cols = []
    for k in range(MASK_SEGS):
        col = [(zs[i], hull[i][k]) for i in range(len(zs)) if hull[i][k] > 0 and zs[i] <= tops[k] + 0.004]
        env = []
        for zz, rr in sorted(col):
            while len(env) >= 2:
                (z0, r0), (z1, r1) = env[-2], env[-1]
                if (r1 - r0) * (zz - z0) <= (rr - r0) * (z1 - z0):
                    env.pop()
                else:
                    break
            env.append((zz, rr))
        rs = []
        for i, zz in enumerate(zs):
            tent = hull[i][k]
            for (z0, r0), (z1, r1) in zip(env, env[1:]):
                if z0 <= zz <= z1:
                    tent = max(tent, r0 + (r1 - r0) * (zz - z0) / max(z1 - z0, 1e-9))
            under = surf[i][k] or tent
            rs.append(max(under + 0.001, tent - MASK_SAG * (tent - under)))
        cols.append(rs)

    # Rows: the upper rows follow the curved top edge (per column), then the
    # lower rows are shared heights.
    n_top = 10
    z_mid = 1.582
    shared = [z for z in (1.572, 1.563, 1.556, 1.548, 1.53, 1.51, 1.49, 1.47, MASK_BOTTOM)]
    hood_z = [1.5 + 0.004 * i for i in range(20)]
    hood_in = _hood_inside(hood_z, phis)
    loops, wts = [], []
    for r_i in range(n_top + len(shared)):
        loop = []
        for k, ph in enumerate(phis):
            if r_i < n_top:
                z = tops[k] + (z_mid - tops[k]) * (r_i / (n_top - 1)) ** 1.15
            else:
                z = shared[r_i - n_top]
            off = 0.0015 if r_i == 0 else 0.0045  # the top edge hugs the face
            r = _interp_col(zs, cols[k], z) + off
            # Under the chin the gaiter drapes inside the hood, clear of its
            # rolled rim (the rim tube reaches 7.5 mm inside the cloth).
            hz = min(range(len(hood_z)), key=lambda i: abs(hood_z[i] - z))
            if abs(hood_z[hz] - z) < 0.004 and hood_in[hz][k] > 0:
                r = min(r, hood_in[hz][k] - 0.008)
            loop.append(Vector((cx + math.cos(ph) * r, cy + math.sin(ph) * r, z)))
        loops.append(loop)
        wts.append(_mask_weights(min(p.z for p in loop)))
    loft_loops(mb, loops, wts, "mask")
    # Hemmed top edge: a thin roll along the upper rim.
    rim = loops[1]
    rings = []
    for k in range(MASK_SEGS + 1):
        p = rim[k % MASK_SEGS]
        q = loops[0][k % MASK_SEGS]
        tan = (rim[(k + 1) % MASK_SEGS] - rim[(k - 1) % MASK_SEGS]).normalized()
        rings.append(((p + q) / 2 + Vector((0, 0, 0.0015)), frame_from_axis(tan), 0.0022, 0.0022, wts[0], 2.0))
    mb.loft(rings, "mask", segs=4)
