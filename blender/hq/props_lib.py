"""Materials and a small mesh toolkit shared by the HQ prop builders.

Every prop is assembled from primitives into one bmesh per material. When the
prop is finished each bmesh becomes one child mesh named "<kind>__<material>"
under an empty named exactly "<kind>", so the app can build one InstancedMesh
per child (one geometry + one shared material each).

Shading policy: hard-surface boxes are flat shaded with a one-segment chamfer
(the chamfer catches a thin highlight line, which is what makes black
furniture read in a dark room); round parts are smooth with sharp edges above
an angle; upholstery is a rounded, slightly bulged box with smooth normals.
"""

import contextlib
import math
import random

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector


# --- colours ------------------------------------------------------------------
def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_lin(h):
    h = h.lstrip("#")
    return tuple(srgb_to_linear(int(h[i : i + 2], 16) / 255.0) for i in (0, 2, 4))


# Mirrors HQ_THEME in src/features/hq/core/config.ts (sRGB hex).
THEME = {
    "deskTop": "#0d0d0f",
    "metal": "#1a1b1e",
    "glass": "#1b2126",
    "glassEdge": "#2a2d31",
    "accent": "#ff1a1a",
    "accentDeep": "#6e0000",
    "ledWarm": "#ffb070",
    "screenBackground": "#070203",
}


# LED channel of "emissive_red": three.js reads uv = (phase, 1) on a blinking
# LED and uv = (0, 0) on steady light. glTF stores V flipped relative to
# Blender (v_gltf = 1 - v_blender), so the Blender-side values are flipped here.
def led_uv(phase, blink):
    return (phase, 0.0) if blink else (0.0, 1.0)


STEADY_UV = led_uv(0.0, False)


def _scaled(rgb, k):
    return tuple(min(1.0, c * k) for c in rgb)


# GLOW.emissiveFloor in src/features/hq/render/environment/palette.ts: the app raises the
# emissive intensity of every prop material to at least this (the preview does too).
EMISSIVE_FLOOR = 5.0


# name: principled settings. Base colours are linear. The blacks are lifted a
# little above the theme swatches so shapes still read under a dim key light;
# the look comes from roughness contrast (matte body, gloss tops, satin leather).
# No clearcoat/specular extensions: every material loads as a plain
# MeshStandardMaterial, so the whole library shares one shader family.
MATERIALS = {
    "black_matte": dict(base=(0.013, 0.013, 0.014), rough=0.58, metal=0.0),
    "black_gloss": dict(base=(0.007, 0.007, 0.008), rough=0.1, metal=0.0),
    "leather": dict(base=(0.014, 0.012, 0.012), rough=0.36, metal=0.0),
    "fabric_dark": dict(base=(0.02, 0.02, 0.022), rough=0.92, metal=0.0),
    "metal_dark": dict(base=_scaled(hex_lin(THEME["metal"]), 3.2), rough=0.3, metal=1.0),
    "glass_dark": dict(base=hex_lin(THEME["glass"]), rough=0.04, metal=0.0, alpha=0.32),
    "plant_leaf": dict(base=(1.0, 1.0, 1.0), rough=0.55, metal=0.0, vcol=True, double=True),
    # AM7's black foliage: near-black red in the vertex colours, a satin sheen.
    "plant_leaf_dark": dict(base=(1.0, 1.0, 1.0), rough=0.32, metal=0.0, vcol=True, double=True),
    "soil": dict(base=(0.018, 0.013, 0.01), rough=0.97, metal=0.0),
    "emissive_red": dict(base=_scaled(hex_lin(THEME["accent"]), 0.5), rough=0.4, metal=0.0,
                         emit=hex_lin(THEME["accent"]), strength=6.0),
    # Faint red inlays. The app lifts every prop emissive to at least
    # EMISSIVE_FLOOR and the exporter bakes a strength <= 1 into the colour, so
    # the dimming lives in the emission colour: 0.08 x 5 = 0.4, below bloom.
    "emissive_red_dim": dict(base=_scaled(hex_lin(THEME["accent"]), 0.1), rough=0.4, metal=0.0,
                             emit=_scaled(hex_lin(THEME["accent"]), 0.08), strength=1.0),
    # Soft red washes (keyboard underglow, the light under AM7's desk): 0.3 x 5 = 1.5.
    "emissive_red_soft": dict(base=_scaled(hex_lin(THEME["accent"]), 0.15), rough=0.4, metal=0.0,
                              emit=_scaled(hex_lin(THEME["accent"]), 0.3), strength=1.0),
    # AM7's desk and chair (props_exec.py).
    "black_satin": dict(base=(0.012, 0.012, 0.013), rough=0.3, metal=0.0),
    "chrome_dark": dict(base=(0.16, 0.16, 0.17), rough=0.08, metal=1.0),
    "metal_brushed": dict(base=(0.14, 0.14, 0.15), rough=0.26, metal=1.0),
    # Red piping thread: a faint glow of its own, not lifted to bloom by the app.
    "stitch": dict(base=(0.3, 0.01, 0.008), rough=0.55, metal=0.0,
                   emit=_scaled(hex_lin(THEME["accent"]), 0.18), strength=1.0),
    "emissive_warm": dict(base=_scaled(hex_lin(THEME["ledWarm"]), 0.6), rough=0.8, metal=0.0,
                          emit=hex_lin(THEME["ledWarm"]), strength=3.0),
    "screen": dict(base=hex_lin(THEME["screenBackground"]), rough=0.18, metal=0.0,
                   emit=hex_lin(THEME["accentDeep"]), strength=1.0),
    # AM7's curved monitor: its own display content in the app.
    "screen_exec": dict(base=hex_lin(THEME["screenBackground"]), rough=0.18, metal=0.0,
                        emit=hex_lin(THEME["accentDeep"]), strength=1.0),
}


def make_materials():
    mats = {}
    for name, spec in MATERIALS.items():
        m = bpy.data.materials.new(name)
        nt = m.node_tree
        p = nt.nodes.get("Principled BSDF")
        p.inputs["Base Color"].default_value = (*spec["base"], 1.0)
        p.inputs["Roughness"].default_value = spec["rough"]
        p.inputs["Metallic"].default_value = spec["metal"]
        if spec.get("coat"):
            p.inputs["Coat Weight"].default_value = spec["coat"]
            p.inputs["Coat Roughness"].default_value = 0.08
        if spec.get("emit"):
            p.inputs["Emission Color"].default_value = (*spec["emit"], 1.0)
            p.inputs["Emission Strength"].default_value = spec["strength"]
        if spec.get("alpha") is not None:
            p.inputs["Alpha"].default_value = spec["alpha"]
            m.surface_render_method = "BLENDED"
        if spec.get("vcol"):
            attr = nt.nodes.new("ShaderNodeVertexColor")
            attr.layer_name = "Color"
            attr.location = (-300, 200)
            nt.links.new(attr.outputs["Color"], p.inputs["Base Color"])
        m.use_backface_culling = not spec.get("double", False)
        m.diffuse_color = (*spec["base"], 1.0)
        mats[name] = m
    return mats


# --- transforms -----------------------------------------------------------------
def xform(loc=(0, 0, 0), rot=None, scale=None):
    m = Matrix.Translation(Vector(loc))
    if rot is not None:
        m = m @ Euler(rot, "XYZ").to_matrix().to_4x4()
    if scale is not None:
        m = m @ Matrix.Diagonal((*scale, 1.0))
    return m


def _autosharp(bm, deg=40.0, smooth=True):
    bm.normal_update()
    thr = math.cos(math.radians(deg))
    for f in bm.faces:
        f.smooth = smooth
    if not smooth:
        return
    for e in bm.edges:
        lf = e.link_faces
        if len(lf) == 2 and lf[0].normal.dot(lf[1].normal) < thr:
            e.smooth = False


def _new_bm():
    bm = bmesh.new()
    bm.loops.layers.uv.new("UVMap")
    return bm


# --- prop builder ----------------------------------------------------------------
class Prop:
    """Collects geometry for one prop kind, one bmesh per material."""

    def __init__(self, kind, seed=1):
        self.kind = kind
        self.bms = {}
        self.rng = random.Random(seed)
        self.base = Matrix.Identity(4)

    @contextlib.contextmanager
    def frame(self, loc=(0, 0, 0), rot=None):
        """Nest primitives in a local frame (e.g. a monitor turned toward the sitter)."""
        saved = self.base
        self.base = saved @ xform(loc, rot)
        try:
            yield
        finally:
            self.base = saved

    def _acc(self, mat):
        bm = self.bms.get(mat)
        if bm is None:
            if mat not in MATERIALS:
                raise KeyError(mat)
            bm = _new_bm()
            if MATERIALS[mat].get("vcol"):
                bm.loops.layers.float_color.new("Color")
            self.bms[mat] = bm
        return bm

    def merge(self, mat, src, matrix=None, color=None, uv=None):
        """Append `src` (freed afterwards) into the material's bmesh.

        color: RGB applied to every corner (vertex-colour materials only), else
        the source's own colour layer is kept. uv: (u, v) forced on every corner.
        """
        dst = self._acc(mat)
        if uv is None and mat.startswith("emissive_red"):
            uv = STEADY_UV  # every red light is steady unless it asks to blink
        matrix = self.base @ (matrix if matrix is not None else Matrix.Identity(4))
        if matrix != Matrix.Identity(4):
            src.transform(matrix)
            if matrix.to_3x3().determinant() < 0:
                bmesh.ops.reverse_faces(src, faces=list(src.faces))
        uv_s = src.loops.layers.uv.active
        col_s = src.loops.layers.float_color.active
        uv_d = dst.loops.layers.uv.active
        col_d = dst.loops.layers.float_color.active
        vmap = {v: dst.verts.new(v.co) for v in src.verts}
        rgba = (*color, 1.0) if color is not None else None
        for f in src.faces:
            try:
                nf = dst.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            nf.smooth = f.smooth
            for ln, lo in zip(nf.loops, f.loops):
                if uv is not None:
                    ln[uv_d].uv = uv
                elif uv_s is not None:
                    ln[uv_d].uv = lo[uv_s].uv
                if col_d is not None:
                    if rgba is not None:
                        ln[col_d] = rgba
                    elif col_s is not None:
                        ln[col_d] = lo[col_s]
                    else:
                        ln[col_d] = (1.0, 1.0, 1.0, 1.0)
        for e in src.edges:
            if not e.smooth:
                ne = dst.edges.get((vmap[e.verts[0]], vmap[e.verts[1]]))
                if ne is not None:
                    ne.smooth = False
        src.free()

    # -- primitives (all sizes in metres, loc is the primitive centre) --
    def box(self, mat, size, loc, rot=None, bevel=0.004, uv=None):
        bm = _new_bm()
        bmesh.ops.create_cube(bm, size=1.0, calc_uvs=True)
        bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
        if bevel > 0:
            b = min(bevel, min(size) * 0.45)
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=b, segments=1,
                            affect="EDGES", clamp_overlap=True)
        _box_uvs(bm)
        _autosharp(bm, smooth=False)
        self.merge(mat, bm, xform(loc, rot), uv=uv)

    def cyl(self, mat, r, h, loc, rot=None, segs=24, r2=None, caps=True, sharp=40.0):
        """Cylinder (or cone when r2 is given) along local Z, centred on loc."""
        bm = _new_bm()
        bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segs,
                              radius1=r, radius2=r if r2 is None else r2, depth=h, calc_uvs=True)
        _autosharp(bm, sharp)
        self.merge(mat, bm, xform(loc, rot))

    def lathe(self, mat, profile, loc=(0, 0, 0), rot=None, segs=32, sharp=40.0,
              color=None, scale=None, true_poles=False):
        """Revolve [(radius, z), ...] around Z. A radius of 0 makes a pole.

        Faces point to the right of the profile's direction of travel in the
        (radius, z) plane: outward on a wall climbing up, up on a top that runs
        toward the axis. The fans at a pole are wound the other way round unless
        true_poles is set; it stays off for the props built before the fix so
        their geometry does not change.
        """
        bm = _new_bm()
        rings = []
        for r, z in profile:
            if r <= 1e-6:
                rings.append([bm.verts.new((0.0, 0.0, z))])
            else:
                rings.append([bm.verts.new((r * math.cos(2 * math.pi * k / segs),
                                            r * math.sin(2 * math.pi * k / segs), z))
                              for k in range(segs)])
        for a, b in zip(rings, rings[1:]):
            _bridge(bm, a, b, segs, flip_fans=true_poles)
        _autosharp(bm, sharp)
        self.merge(mat, bm, xform(loc, rot, scale), color=color)

    def rbox(self, mat, size, loc, r=0.04, rot=None, steps=2, splits=(1, 1, 1),
             bulge=(0.0, 0.0, 0.0), taper=None):
        """Rounded box with smooth normals, for upholstery.

        bulge: outward puff of the faces normal to x, y and z (metres).
        taper: optional (sx, sy) scale of the top (+z) relative to the bottom.
        """
        bm = _new_bm()
        uvl = bm.loops.layers.uv.active
        H = [s / 2 for s in size]
        rr = min(r, *(h * 0.49 for h in H))
        inner = [h - rr for h in H]

        def axis(i):
            corner = [rr * math.tan(math.pi / 4 * k / steps) for k in range(steps, -1, -1)]
            lo = [-inner[i] - c for c in corner]  # -H .. -inner
            n = splits[i] + 1
            mid = [-inner[i] + 2 * inner[i] * k / n for k in range(1, n)]
            hi = [-v for v in reversed(lo)]
            return lo + mid + hi

        coords = [axis(0), axis(1), axis(2)]

        def project(p):
            ip = [max(-inner[i], min(inner[i], p[i])) for i in range(3)]
            o = Vector([p[i] - ip[i] for i in range(3)])
            if o.length < 1e-9:
                return Vector(p)
            q = Vector(ip) + o.normalized() * rr
            # puff each face along its normal, fading to zero at the rounded rim
            for i in range(3):
                if bulge[i] and abs(o[i]) > 1e-9:
                    w = abs(o[i]) / o.length
                    f = 1.0
                    for j in range(3):
                        if j != i and inner[j] > 1e-6:
                            t = ip[j] / inner[j]
                            f *= 1.0 - t * t
                    q[i] += math.copysign(bulge[i] * f * w ** 4, o[i])
            if taper is not None:
                k = 0.5 + 0.5 * (q[2] / H[2])
                q[0] *= 1.0 + (taper[0] - 1.0) * k
                q[1] *= 1.0 + (taper[1] - 1.0) * k
            return q

        for ax in range(3):
            u_ax, v_ax = [a for a in range(3) if a != ax]
            for sign in (-1, 1):
                grid = []
                for cu in coords[u_ax]:
                    row = []
                    for cv in coords[v_ax]:
                        p = [0.0, 0.0, 0.0]
                        p[ax] = sign * H[ax]
                        p[u_ax] = cu
                        p[v_ax] = cv
                        row.append(bm.verts.new(project(p)))
                    grid.append(row)
                for i in range(len(grid) - 1):
                    for j in range(len(grid[0]) - 1):
                        quad = [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]
                        # keep outward winding: u x v points along +ax for this order
                        cross_sign = 1 if (u_ax, v_ax) in ((0, 1), (1, 2), (2, 0)) else -1
                        if sign * cross_sign < 0:
                            quad.reverse()
                        f = bm.faces.new(quad)
                        for lp in f.loops:
                            lp[uvl].uv = (lp.vert.co[u_ax], lp.vert.co[v_ax])
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        _autosharp(bm, 60.0)
        self.merge(mat, bm, xform(loc, rot))

    def slab(self, mat, w, d, h, loc, corner=0.04, csegs=5, bevel=0.004, rot=None):
        """Rounded-rectangle slab (table tops): straight sides, round corners in
        plan, a chamfer on the top edge. loc is the centre of the slab."""
        bm = _new_bm()
        uvl = bm.loops.layers.uv.active
        corner = max(corner, bevel * 2 + 1e-4)

        def outline(rad):
            pts = []
            hw, hd = w / 2 - corner, d / 2 - corner
            for cx, cy, a0 in ((hw, hd, 0), (-hw, hd, 90), (-hw, -hd, 180), (hw, -hd, 270)):
                for k in range(csegs + 1):
                    a = math.radians(a0 + 90 * k / csegs)
                    pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
            return pts

        z0, z1 = -h / 2, h / 2
        outer = outline(corner)
        inner = outline(corner - bevel)
        r0 = [bm.verts.new((x, y, z0)) for x, y in outer]
        r1 = [bm.verts.new((x, y, z1 - bevel)) for x, y in outer]
        r2 = [bm.verts.new((x, y, z1)) for x, y in inner]
        n = len(outer)
        bm.faces.new(list(reversed(r0)))
        for a, b in ((r0, r1), (r1, r2)):
            for k in range(n):
                k2 = (k + 1) % n
                bm.faces.new((a[k], a[k2], b[k2], b[k]))
        bm.faces.new(r2)
        for f in bm.faces:
            for lp in f.loops:
                lp[uvl].uv = (lp.vert.co.x, lp.vert.co.y)
        _autosharp(bm, 35.0)
        self.merge(mat, bm, xform(loc, rot))

    def tray(self, mat, size, loc, rim=0.02, depth=0.03, bevel=0.004, rot=None):
        """Box whose top is inset into a rim of width `rim` and dropped by
        `depth` (a trough or planter body); loc is the box centre. With
        rot=(pi/2, 0, 0) the recess faces -Y instead (a door bezel): size is
        then (width, height, depth)."""
        bm = _new_bm()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
        bm.normal_update()
        top = [f for f in bm.faces if f.normal.z > 0.9]
        bmesh.ops.inset_region(bm, faces=top, thickness=rim, depth=-depth)
        if bevel > 0:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, affect="EDGES",
                            clamp_overlap=True)
        _box_uvs(bm)
        _autosharp(bm, smooth=False)
        self.merge(mat, bm, xform(loc, rot))

    def ring(self, mat, r_in, r_out, z0, z1, loc=(0, 0, 0), rot=None, segs=32):
        """Flat washer / short tube wall around Z."""
        self.lathe(mat, [(r_in, z0), (r_out, z0), (r_out, z1), (r_in, z1), (r_in, z0)],
                   loc=loc, rot=rot, segs=segs, sharp=40.0)

    def quad(self, mat, w, h, loc, rot=None, uv_rect=(0.0, 0.0, 1.0, 1.0), uv=None):
        """Single quad in the XZ plane facing -Y. UV (0,0) is the viewer's
        bottom-left when looking at the front, (1,1) the top-right."""
        bm = _new_bm()
        uvl = bm.loops.layers.uv.active
        u0, v0, u1, v1 = uv_rect
        vs = [bm.verts.new((-w / 2, 0, -h / 2)), bm.verts.new((w / 2, 0, -h / 2)),
              bm.verts.new((w / 2, 0, h / 2)), bm.verts.new((-w / 2, 0, h / 2))]
        f = bm.faces.new(vs)
        for lp, t in zip(f.loops, ((u0, v0), (u1, v0), (u1, v1), (u0, v1))):
            lp[uvl].uv = t
        f.smooth = False
        self.merge(mat, bm, xform(loc, rot), uv=uv)

    def tube(self, mat, pts, r, segs=8, caps=True, color=None, radii=None, sharp=50.0):
        """Tube along a polyline with parallel-transport frames."""
        bm = _new_bm()
        pts = [Vector(p) for p in pts]
        rings = []
        t0 = (pts[1] - pts[0]).normalized()
        ref = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
        nrm = t0.cross(ref).normalized()
        prev_t = t0
        for i, p in enumerate(pts):
            if i == 0:
                t = t0
            elif i == len(pts) - 1:
                t = (pts[i] - pts[i - 1]).normalized()
            else:
                t = ((pts[i] - pts[i - 1]).normalized() + (pts[i + 1] - pts[i]).normalized()).normalized()
            # parallel transport the normal
            axis = prev_t.cross(t)
            if axis.length > 1e-8:
                ang = prev_t.angle(t)
                nrm = Matrix.Rotation(ang, 3, axis.normalized()) @ nrm
            prev_t = t
            bin_ = t.cross(nrm).normalized()
            rad = r if radii is None else radii[i]
            ring = []
            for k in range(segs):
                a = 2 * math.pi * k / segs
                ring.append(bm.verts.new(p + (nrm * math.cos(a) + bin_ * math.sin(a)) * rad))
            rings.append(ring)
        for a, b in zip(rings, rings[1:]):
            _bridge(bm, a, b, segs)
        if caps:
            bm.faces.new(list(reversed(rings[0])))
            bm.faces.new(rings[-1])
        _autosharp(bm, sharp)
        self.merge(mat, bm, None, color=color)

    def mesh(self, mat, verts, faces, colors=None, smooth=True, uvs=None, sharp=70.0):
        """Raw geometry. colors: per-vertex RGB (vertex-colour materials);
        uvs: per-vertex (u, v)."""
        bm = _new_bm()
        col = bm.loops.layers.float_color.new("Color") if colors is not None else None
        uvl = bm.loops.layers.uv.active
        vs = [bm.verts.new(v) for v in verts]
        for fi in faces:
            try:
                f = bm.faces.new([vs[i] for i in fi])
            except ValueError:
                continue
            for lp, i in zip(f.loops, fi):
                if col is not None:
                    lp[col] = (*colors[i], 1.0)
                if uvs is not None:
                    lp[uvl].uv = uvs[i]
        _autosharp(bm, sharp, smooth)
        self.merge(mat, bm)

    # -- finish --
    def build(self, mats, collection):
        root = bpy.data.objects.new(self.kind, None)
        root.empty_display_size = 0.3
        collection.objects.link(root)
        tris = 0
        for mat in sorted(self.bms):
            bm = self.bms[mat]
            bm.normal_update()
            name = f"{self.kind}__{mat}"
            me = bpy.data.meshes.new(name)
            bm.to_mesh(me)
            bm.free()
            if MATERIALS[mat].get("vcol") and len(me.color_attributes):
                me.color_attributes.active_color_index = 0
                me.color_attributes.render_color_index = 0
            me.materials.append(mats[mat])
            ob = bpy.data.objects.new(name, me)
            collection.objects.link(ob)
            ob.parent = root
            tris += sum(len(p.vertices) - 2 for p in me.polygons)
        self.bms = {}
        return root, tris


def _bridge(bm, a, b, segs, flip_fans=False):
    if len(a) == 1 and len(b) == 1:
        return
    if len(a) == 1:
        for k in range(segs):
            tri = (a[0], b[k], b[(k + 1) % segs])
            bm.faces.new(tri[::-1] if flip_fans else tri)
    elif len(b) == 1:
        for k in range(segs):
            tri = (a[(k + 1) % segs], a[k], b[0])
            bm.faces.new(tri[::-1] if flip_fans else tri)
    else:
        for k in range(segs):
            k2 = (k + 1) % segs
            bm.faces.new((a[k], a[k2], b[k2], b[k]))


def _box_uvs(bm):
    """Planar UVs in metres along each face's dominant axis (for detail maps)."""
    uvl = bm.loops.layers.uv.active
    bm.normal_update()
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        u_ax, v_ax = [a for a in range(3) if a != ax]
        for lp in f.loops:
            lp[uvl].uv = (lp.vert.co[u_ax], lp.vert.co[v_ax])


def lerp3(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))
