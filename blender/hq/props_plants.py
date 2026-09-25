"""Procedural foliage for the planters: broad layered leaves, grass blades and
fern fronds. All foliage uses the shared "plant_leaf" material and carries
its colour in vertex colours (dark at the base and the midrib's edges, lighter
toward sunlit tips, a little hue jitter per leaf), so a whole planter stays a
single draw call.
"""

import math

from mathutils import Matrix, Vector

from props_lib import lerp3

# Linear RGB. Deep, slightly blue greens so the plants sit in the dark red room
# instead of glowing like a garden centre.
LEAF_DARK = (0.002, 0.012, 0.005)
LEAF_MID = (0.004, 0.032, 0.011)
LEAF_LIGHT = (0.011, 0.065, 0.02)
STEM = (0.02, 0.014, 0.009)
GRASS_DARK = (0.003, 0.015, 0.006)
GRASS_TIP = (0.014, 0.055, 0.018)


def _jitter(rng, c, amount=0.25):
    k = 1.0 + rng.uniform(-amount, amount)
    h = rng.uniform(-0.12, 0.12)
    return (max(0.0, c[0] * k * (1 + h)), c[1] * k, max(0.0, c[2] * k * (1 - h)))


def _frame(direction):
    d = direction.normalized()
    up = Vector((0, 0, 1))
    side = d.cross(up)
    if side.length < 1e-4:
        side = Vector((1, 0, 0))
    side.normalize()
    nrm = side.cross(d).normalized()
    return d, side, nrm


def broad_leaf(prop, base, direction, length, width, rng, droop=0.9, fold=0.22,
               curl=0.12, segs=5, tint=None):
    """An elliptical leaf with a folded midrib that arches and droops.

    base: attachment point, direction: initial growth direction.
    """
    d, side, nrm = _frame(Vector(direction))
    verts, cols, faces = [], [], []
    p = Vector(base)
    step = length / segs
    dark = _jitter(rng, tint or LEAF_DARK)
    mid = _jitter(rng, LEAF_MID)
    light = _jitter(rng, LEAF_LIGHT)
    rows = []
    for i in range(segs + 1):
        t = i / segs
        # width: rounded base, widest a little below the middle, pointed tip
        w = width * (math.sin(math.pi * min(1.0, t * 0.92 + 0.04)) ** 0.8) * (1.0 - 0.25 * t)
        if i == segs:
            w = 0.0
        s = side * (w / 2)
        drop = nrm * (-fold * w)  # edges sit below the midrib: a V fold
        c_mid = lerp3(mid, light, t ** 1.4)
        c_edge = lerp3(dark, mid, t)
        row = []
        if i == segs:
            verts.append(p.copy())
            cols.append(c_mid)
            row = [len(verts) - 1] * 3
        else:
            # curl lifts the leaf edges a little near the tip
            lift = nrm * (curl * w * t)
            for off, c in ((-s + drop + lift, c_edge), (Vector((0, 0, 0)), c_mid), (s + drop + lift, c_edge)):
                verts.append(p + off)
                cols.append(c)
                row.append(len(verts) - 1)
        rows.append(row)
        # arch: bend the growth direction toward the ground more and more
        bend = Matrix.Rotation(-droop * step / length * (0.4 + 1.6 * t), 3, side)
        d = (bend @ d).normalized()
        nrm = side.cross(d).normalized()
        p = p + d * step
    for a, b in zip(rows, rows[1:]):
        if b[0] == b[1]:
            faces.append((a[0], a[1], b[0]))
            faces.append((a[1], a[2], b[0]))
        else:
            faces.append((a[0], a[1], b[1], b[0]))
            faces.append((a[1], a[2], b[2], b[1]))
    prop.mesh("plant_leaf", verts, faces, colors=cols, smooth=True)


def grass_blade(prop, base, direction, length, width, rng, droop=1.2, segs=3):
    d, side, nrm = _frame(Vector(direction))
    verts, cols, faces = [], [], []
    p = Vector(base)
    step = length / segs
    dark = _jitter(rng, GRASS_DARK, 0.3)
    tip = _jitter(rng, GRASS_TIP, 0.3)
    rows = []
    for i in range(segs + 1):
        t = i / segs
        if i == segs:
            verts.append(p.copy())
            cols.append(tip)
            rows.append([len(verts) - 1])
            break
        w = width * (1.0 - t * 0.85)
        c = lerp3(dark, tip, t)
        verts.append(p - side * (w / 2))
        verts.append(p + side * (w / 2))
        cols += [c, c]
        rows.append([len(verts) - 2, len(verts) - 1])
        bend = Matrix.Rotation(-droop * step / length * (0.3 + 1.4 * t), 3, side)
        d = (bend @ d).normalized()
        p = p + d * step
    for a, b in zip(rows, rows[1:]):
        if len(b) == 1:
            faces.append((a[0], a[1], b[0]))
        else:
            faces.append((a[0], a[1], b[1], b[0]))
    prop.mesh("plant_leaf", verts, faces, colors=cols, smooth=True)


def fern_frond(prop, base, direction, length, rng, pinnae=13, droop=1.5, pinna_len=0.11):
    """Arching rachis with alternating narrow pinnae that shrink toward the tip."""
    d, side, nrm = _frame(Vector(direction))
    verts, cols, faces = [], [], []
    p = Vector(base)
    n = pinnae
    step = length / n
    dark = _jitter(rng, LEAF_DARK, 0.2)
    light = _jitter(rng, (0.012, 0.07, 0.02), 0.2)
    for i in range(n):
        t = (i + 0.5) / n
        bend = Matrix.Rotation(-droop * step / length * (0.4 + 1.4 * t), 3, side)
        d = (bend @ d).normalized()
        nrm = side.cross(d).normalized()
        p_next = p + d * step
        # pinna length peaks in the lower third
        L = pinna_len * math.sin(math.pi * min(1.0, 0.15 + t * 0.95)) ** 0.7
        w = L * 0.36
        c0 = lerp3(dark, light, t * 0.6)
        c1 = lerp3(dark, light, 0.4 + t * 0.6)
        for sgn in (-1, 1):
            root = p + d * (step * (0.3 if sgn < 0 else 0.7))
            out = (side * sgn * 0.9 + d * 0.45 - nrm * 0.25).normalized()
            tipp = root + out * L
            midp = root + out * (L * 0.55)
            wv = (d - out * out.dot(d)).normalized() * (w / 2)
            i0 = len(verts)
            verts += [root, midp - wv - nrm * 0.004, tipp, midp + wv - nrm * 0.004]
            cols += [c0, c0, c1, c0]
            faces.append((i0, i0 + 1, i0 + 2, i0 + 3) if sgn > 0 else (i0, i0 + 3, i0 + 2, i0 + 1))
        p = p_next
    prop.mesh("plant_leaf", verts, faces, colors=cols, smooth=True)


def ficus_bush(prop, rng, soil_z, top_z):
    """Multi-stem broad-leaf plant: canes of different heights leaning out,
    leaves in a phyllotactic spiral, bigger and more drooping near the bottom,
    a dense crown on each cane and a skirt of low leaves over the rim."""
    canes = [
        (Vector((0.02, -0.02, soil_z)), top_z, (0.08, -0.1)),
        (Vector((-0.05, 0.03, soil_z)), top_z - 0.2, (-0.26, 0.08)),
        (Vector((0.05, 0.04, soil_z)), top_z - 0.36, (0.24, 0.2)),
        (Vector((-0.02, -0.05, soil_z)), top_z - 0.52, (-0.12, -0.26)),
    ]
    golden = math.radians(137.5)
    for ci, (root, tip_z, lean) in enumerate(canes):
        h = tip_z - soil_z
        pts = []
        for k in range(6):
            t = k / 5
            sway = math.sin(t * 2.6 + ci) * 0.02
            pts.append(root + Vector((lean[0] * t ** 1.5 + sway, lean[1] * t ** 1.5 - sway, h * t)))
        r0 = 0.018 - ci * 0.002
        prop.tube("plant_leaf", pts, r0, segs=6, color=STEM, radii=[r0 - 0.009 * (k / 5) for k in range(6)])
        leaves = (34, 28, 22, 16)[ci]
        start = 0.3 + 0.05 * ci
        for j in range(leaves):
            t = start + (1.0 - start) * (j / (leaves - 1)) ** 0.8
            seg = min(4, int(t * 5))
            at = pts[seg].lerp(pts[seg + 1], t * 5 - seg)
            ang = j * golden + ci * 1.3
            up = 0.2 + 0.65 * t ** 2  # low leaves spread out, upper leaves rise (not a funnel)
            direction = Vector((math.cos(ang), math.sin(ang), up))
            size = 1.0 - 0.4 * t + rng.uniform(-0.1, 0.1)
            broad_leaf(prop, at, direction, length=0.34 * size + 0.08, width=0.16 * size + 0.035,
                       rng=rng, droop=1.6 - 0.9 * t + rng.uniform(-0.25, 0.25), segs=4)
        # young leaves at the tip, angled out so the crown does not read as a cup
        for j in range(3):
            ang = j * 2 * math.pi / 3 + ci
            direction = Vector((0.9 * math.cos(ang), 0.9 * math.sin(ang), 0.8))
            broad_leaf(prop, pts[-1], direction, length=0.22, width=0.1, rng=rng, droop=1.3, segs=4,
                       tint=LEAF_MID)
    for j in range(12):
        ang = j * golden
        at = Vector((0.05 * math.cos(ang), 0.05 * math.sin(ang), soil_z + 0.04))
        direction = Vector((math.cos(ang), math.sin(ang), 0.6))
        broad_leaf(prop, at, direction, length=0.32 + rng.uniform(-0.03, 0.05), width=0.15,
                   rng=rng, droop=1.9, segs=4)


def grass_bed(prop, rng, x0, x1, y0, y1, z, clumps=11, ferns=5):
    """Fill a rectangle with ferns and soft arching grass clumps between them."""
    for i in range(ferns):
        cx = x0 + (x1 - x0) * (i + 0.5) / ferns + rng.uniform(-0.03, 0.03)
        cy = (y0 + y1) / 2 + rng.uniform(-0.03, 0.03)
        fronds = 7
        for f in range(fronds):
            ang = f * 2 * math.pi / fronds + rng.uniform(-0.3, 0.3) + i
            direction = Vector((math.cos(ang), math.sin(ang) * 0.8, 0.9 + rng.uniform(-0.2, 0.3)))
            fern_frond(prop, Vector((cx, cy, z)), direction, length=0.44 + rng.uniform(-0.07, 0.06),
                       rng=rng, pinnae=18, droop=2.2, pinna_len=0.12)
    for c in range(clumps):
        cx = x0 + (x1 - x0) * (c + rng.uniform(0.2, 0.8)) / clumps
        cy = rng.uniform(y0 + 0.03, y1 - 0.03)
        for b in range(12):
            ang = rng.uniform(0, 2 * math.pi)
            spread = rng.uniform(0.15, 0.5)
            direction = Vector((math.cos(ang) * spread, math.sin(ang) * spread * 0.7, 1.0))
            base = Vector((cx + rng.uniform(-0.015, 0.015), cy + rng.uniform(-0.015, 0.015), z))
            grass_blade(prop, base, direction, length=rng.uniform(0.2, 0.34), width=rng.uniform(0.009, 0.013),
                        rng=rng, droop=rng.uniform(1.0, 1.9))
