"""Mesh helpers for blender/hq/workstation.py.

Every builder returns a fresh bmesh in metres; `Parts.add` turns it into an
object in a named bucket (one bucket = one exported mesh = one material).
Dimensions are baked into vertices, never into object scale, so bevel widths
stay in real millimetres.
"""

import math

import bmesh
import bpy
from mathutils import Matrix, Vector

V = Vector


class Parts:
    def __init__(self, collection):
        self.coll = collection
        self.buckets = {}

    def add(self, bucket, bm, name=None, *, matrix=None, bevel=0.0, segments=2,
            smooth=True, sharp_deg=40.0, subsurf=0, harden=True, recalc=True, angle_deg=30.0):
        if recalc:
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        me = bpy.data.meshes.new(name or bucket)
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(me.name, me)
        self.coll.objects.link(ob)
        if matrix is not None:
            ob.matrix_world = matrix
        if smooth:
            me.shade_smooth()
            if sharp_deg is not None:
                me.set_sharp_from_angle(angle=math.radians(sharp_deg))
        else:
            me.shade_flat()
        if bevel > 0:
            m = ob.modifiers.new("bevel", "BEVEL")
            m.width = bevel
            m.segments = segments
            m.limit_method = "ANGLE"
            m.angle_limit = math.radians(angle_deg)
            m.harden_normals = harden and smooth
            m.use_clamp_overlap = True
        if subsurf:
            m = ob.modifiers.new("subsurf", "SUBSURF")
            m.levels = subsurf
            m.render_levels = subsurf
        self.buckets.setdefault(bucket, []).append(ob)
        return ob


# --- transforms -----------------------------------------------------------------
def trs(loc=(0, 0, 0), rz=0.0, rx=0.0, ry=0.0):
    """Translation @ Rz @ Ry @ Rx (radians)."""
    return (Matrix.Translation(V(loc)) @ Matrix.Rotation(rz, 4, "Z")
            @ Matrix.Rotation(ry, 4, "Y") @ Matrix.Rotation(rx, 4, "X"))


# --- primitives -----------------------------------------------------------------
def box(x0, x1, y0, y1, z0, z1):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = x1 - x0, y1 - y0, z1 - z0
    cx, cy, cz = (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2
    for v in bm.verts:
        v.co = V((v.co.x * sx + cx, v.co.y * sy + cy, v.co.z * sz + cz))
    return bm


def hexa(corners, open_bottom=False, bm=None):
    """Eight corners: bottom quad counter-clockwise from above, then top quad.
    Pass `bm` to append into an existing bmesh."""
    bm = bm if bm is not None else bmesh.new()
    vs = [bm.verts.new(V(c)) for c in corners]
    if not open_bottom:
        bm.faces.new((vs[0], vs[3], vs[2], vs[1]))
    bm.faces.new((vs[4], vs[5], vs[6], vs[7]))
    for a, b in ((0, 1), (1, 2), (2, 3), (3, 0)):
        bm.faces.new((vs[a], vs[b], vs[b + 4], vs[a + 4]))
    return bm


def frustum(cx, cz, y0, y1, front, back):
    """Box along -Y whose x/z half extents go from `front` at y0 to `back` at y1.
    front/back = (hx, z_lo, z_hi)."""
    fx, fz0, fz1 = front
    bx, bz0, bz1 = back
    c = [
        (cx - fx, y0, cz + fz0), (cx + fx, y0, cz + fz0), (cx + bx, y1, cz + bz0), (cx - bx, y1, cz + bz0),
        (cx - fx, y0, cz + fz1), (cx + fx, y0, cz + fz1), (cx + bx, y1, cz + bz1), (cx - bx, y1, cz + bz1),
    ]
    return hexa(c)


def cylinder(r, z0, z1, segs=16, r2=None, x=0.0, y=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r,
                          radius2=r if r2 is None else r2, depth=z1 - z0,
                          matrix=Matrix.Translation((x, y, (z0 + z1) / 2)))
    return bm


def cylinder_axis(r, a, b, segs=12):
    """Cylinder between two points."""
    a, b = V(a), V(b)
    d = b - a
    rot = d.to_track_quat("Z", "Y").to_matrix().to_4x4()
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=r,
                          depth=d.length, matrix=Matrix.Translation((a + b) / 2) @ rot)
    return bm


def rrect_outline(hx, hy, r, segs=4, cx=0.0, cy=0.0):
    pts = []
    for qx, qy, a0 in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        ox, oy = cx + qx * (hx - r), cy + qy * (hy - r)
        for k in range(segs + 1):
            a = math.radians(a0 + 90 * k / segs)
            pts.append((ox + r * math.cos(a), oy + r * math.sin(a)))
    return pts


def prism(outline, z0, z1):
    """Extrude a counter-clockwise XY outline between two heights."""
    bm = bmesh.new()
    lo = [bm.verts.new((x, y, z0)) for x, y in outline]
    hi = [bm.verts.new((x, y, z1)) for x, y in outline]
    n = len(outline)
    bm.faces.new(lo[::-1])
    bm.faces.new(hi)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    return bm


def rect_profile(hw, hh, chamfer=0.0):
    if chamfer <= 0:
        return [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
    c = min(chamfer, hw * 0.9, hh * 0.9)
    return [(-hw + c, -hh), (hw - c, -hh), (hw, -hh + c), (hw, hh - c),
            (hw - c, hh), (-hw + c, hh), (-hw, hh - c), (-hw, -hh + c)]


def circle_profile(r, segs=8):
    return [(r * math.cos(2 * math.pi * k / segs), r * math.sin(2 * math.pi * k / segs)) for k in range(segs)]


def round_path(points, radius, segs=3, closed=False, min_turn_deg=25.0):
    """Replace each interior corner sharper than min_turn_deg with a quadratic
    Bezier fillet; gentle bends keep their single point."""
    pts = [V(p) for p in points]
    n = len(pts)
    out = []
    for i in range(n):
        p = pts[i]
        if not closed and (i == 0 or i == n - 1):
            out.append(p)
            continue
        a, b = pts[i - 1], pts[(i + 1) % n]
        d1, d2 = p - a, b - p
        if d1.normalized().angle(d2.normalized(), 0.0) < math.radians(min_turn_deg):
            out.append(p)
            continue
        r = min(radius, d1.length * 0.45, d2.length * 0.45)
        s = p - d1.normalized() * r
        e = p + d2.normalized() * r
        for k in range(segs + 1):
            t = k / segs
            out.append(s * (1 - t) ** 2 + p * (2 * (1 - t) * t) + e * (t * t))
    return out


def sweep(path, profile, normal, closed=False, caps=True):
    """Extrude a 2D profile along a polyline. Profile axes: (side, up), where
    side = tangent x normal and up = side x tangent. `normal` is a vector or a
    per-point list. Corners are mitred so the section keeps its thickness."""
    bm = bmesh.new()
    path = [V(p) for p in path]
    n = len(path)
    rings = []
    for i in range(n):
        p = path[i]
        tin = (p - path[i - 1]).normalized() if (closed or i > 0) else None
        tout = (path[(i + 1) % n] - p).normalized() if (closed or i < n - 1) else None
        if tin is not None and tout is not None:
            t = tin + tout
            t = t.normalized() if t.length > 1e-6 else tout
        else:
            t = tin if tin is not None else tout
        nrm = V(normal[i]) if isinstance(normal, list) else V(normal)
        side = t.cross(nrm).normalized()
        up = side.cross(t).normalized()
        bend, k = None, 1.0
        if tin is not None and tout is not None:
            c = max(tin.dot(t), 0.35)
            b = tout - tin
            if b.length > 1e-6:
                bend, k = b.normalized(), 1.0 / c
        ring = []
        for a, bb in profile:
            o = side * a + up * bb
            if bend is not None:
                o = o + bend * (o.dot(bend) * (k - 1.0))
            ring.append(bm.verts.new(p + o))
        rings.append(ring)
    m = len(profile)
    for i in range(n if closed else n - 1):
        r0, r1 = rings[i], rings[(i + 1) % n]
        for j in range(m):
            bm.faces.new((r0[j], r0[(j + 1) % m], r1[(j + 1) % m], r1[j]))
    if caps and not closed:
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])
    return bm


def ring_xz(outer, inner, y0, y1):
    """Rectangular frame in the XZ plane (a bezel or a glass frame), extruded
    from y0 to y1. outer/inner = (x0, x1, z0, z1)."""
    bm = bmesh.new()

    def quad(r, y):
        x0, x1, z0, z1 = r
        return [bm.verts.new((x0, y, z0)), bm.verts.new((x1, y, z0)),
                bm.verts.new((x1, y, z1)), bm.verts.new((x0, y, z1))]

    of, ob_, inf, inb = quad(outer, y1), quad(outer, y0), quad(inner, y1), quad(inner, y0)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((of[i], of[j], inf[j], inf[i]))  # front ring
        bm.faces.new((ob_[j], ob_[i], inb[i], inb[j]))  # back ring
        bm.faces.new((ob_[i], ob_[j], of[j], of[i]))  # outer wall
        bm.faces.new((inf[i], inf[j], inb[j], inb[i]))  # inner wall
    return bm


def cage(nx, ny, nz, fn):
    """Closed lattice box (for subdivision cushions); fn(u, v, w) -> point, all in 0..1."""
    bm = bmesh.new()
    verts = {}

    def v(i, j, k):
        key = (i, j, k)
        if key not in verts:
            verts[key] = bm.verts.new(V(fn(i / nx, j / ny, k / nz)))
        return verts[key]

    for i in range(nx):
        for j in range(ny):
            bm.faces.new((v(i, j, 0), v(i, j + 1, 0), v(i + 1, j + 1, 0), v(i + 1, j, 0)))
            bm.faces.new((v(i, j, nz), v(i + 1, j, nz), v(i + 1, j + 1, nz), v(i, j + 1, nz)))
    for i in range(nx):
        for k in range(nz):
            bm.faces.new((v(i, 0, k), v(i + 1, 0, k), v(i + 1, 0, k + 1), v(i, 0, k + 1)))
            bm.faces.new((v(i, ny, k), v(i, ny, k + 1), v(i + 1, ny, k + 1), v(i + 1, ny, k)))
    for j in range(ny):
        for k in range(nz):
            bm.faces.new((v(0, j, k), v(0, j, k + 1), v(0, j + 1, k + 1), v(0, j + 1, k)))
            bm.faces.new((v(nx, j, k), v(nx, j + 1, k), v(nx, j + 1, k + 1), v(nx, j, k + 1)))
    return bm


def surface_slab(fn, nu, nv, thick, back_hint):
    """Thin shell: front surface fn(u, v) and a copy pushed `thick` toward back_hint."""
    bm = bmesh.new()
    pts = [[V(fn(i / nu, j / nv)) for j in range(nv + 1)] for i in range(nu + 1)]
    hint = V(back_hint)
    front, back = {}, {}
    for i in range(nu + 1):
        for j in range(nv + 1):
            du = pts[min(i + 1, nu)][j] - pts[max(i - 1, 0)][j]
            dv = pts[i][min(j + 1, nv)] - pts[i][max(j - 1, 0)]
            nrm = du.cross(dv).normalized()
            if nrm.dot(hint) < 0:
                nrm = -nrm
            front[i, j] = bm.verts.new(pts[i][j])
            back[i, j] = bm.verts.new(pts[i][j] + nrm * thick)
    for i in range(nu):
        for j in range(nv):
            bm.faces.new((front[i, j], front[i + 1, j], front[i + 1, j + 1], front[i, j + 1]))
            bm.faces.new((back[i, j], back[i, j + 1], back[i + 1, j + 1], back[i + 1, j]))
    border = ([(i, 0) for i in range(nu)] + [(nu, j) for j in range(nv)]
              + [(i, nv) for i in range(nu, 0, -1)] + [(0, j) for j in range(nv, 0, -1)])
    for idx in range(len(border)):
        a, b = border[idx], border[(idx + 1) % len(border)]
        bm.faces.new((front[a], back[a], back[b], front[b]))
    return bm


def half_ellipsoid(rx, ry, rz, cx, cy, z0, u_segs=14, v_segs=5, nose=0.0):
    """Dome for the mouse: flat bottom at z0, `nose` pushes the peak backward (+y)."""
    bm = bmesh.new()
    rings = []
    for j in range(v_segs):
        phi = (math.pi / 2) * j / v_segs
        ring = []
        for i in range(u_segs):
            th = 2 * math.pi * i / u_segs
            x = rx * math.cos(phi) * math.cos(th)
            y = ry * math.cos(phi) * math.sin(th)
            z = rz * math.sin(phi)
            ring.append(bm.verts.new((cx + x, cy + y + nose * math.sin(phi), z0 + z)))
        rings.append(ring)
    top = bm.verts.new((cx, cy + nose, z0 + rz))
    for j in range(v_segs - 1):
        for i in range(u_segs):
            k = (i + 1) % u_segs
            bm.faces.new((rings[j][i], rings[j][k], rings[j + 1][k], rings[j + 1][i]))
    for i in range(u_segs):
        k = (i + 1) % u_segs
        bm.faces.new((rings[-1][i], rings[-1][k], top))
    bm.faces.new(rings[0][::-1])
    return bm


def join_bucket(objs, name):
    """Apply modifiers, join into one object named `name`, bake transforms."""
    view_layer = bpy.context.view_layer
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    view_layer.objects.active = objs[0]
    bpy.ops.object.convert(target="MESH")
    if len(objs) > 1:
        bpy.ops.object.join()
    ob = view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    ob.name = name
    ob.data.name = name
    ob.select_set(False)
    return ob


def tri_count(ob):
    me = ob.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)
