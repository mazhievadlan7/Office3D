"""Mesh for the hacker character: a black humanoid robot in a hooded top.

Everything goes into ONE skinned mesh with ONE material so each character is a
single draw call. The material reads a small texture atlas: every part's UVs
sit in the middle of its own flat-colour block, so base colour, roughness,
metalness and emission can differ per part without extra materials.

Skin weights are authored directly (per ring for lofted cloth, rigid for the
robot parts) instead of using bone-heat weighting, which fails on
intersecting parts and gives different results between Blender versions.
"""

import math

import bmesh
import bpy
from mathutils import Matrix, Vector

from rig import BONE, FOREARM, HAND, UPPER_ARM, _arm_dir, _palm_normal, head_of, tail_of

# --- material atlas ---------------------------------------------------------
ATLAS = 64
BLOCK = 16  # 4 x 4 blocks
# name: (base rgb (linear), roughness, metallic, emission rgb (linear))
REGIONS = {
    "hoodie": ((0.007, 0.007, 0.008), 0.88, 0.0, (0, 0, 0)),
    "pants": ((0.01, 0.01, 0.011), 0.82, 0.0, (0, 0, 0)),
    "metal": ((0.018, 0.018, 0.02), 0.2, 0.92, (0, 0, 0)),
    "eyes": ((1.0, 0.05, 0.03), 0.3, 0.0, (1.0, 0.04, 0.02)),
    "accent": ((0.6, 0.02, 0.015), 0.4, 0.0, (0.55, 0.012, 0.008)),
    "boots": ((0.02, 0.02, 0.022), 0.55, 0.1, (0, 0, 0)),
    "sole": ((0.05, 0.05, 0.055), 0.7, 0.0, (0, 0, 0)),
    "joint": ((0.05, 0.05, 0.055), 0.35, 0.85, (0, 0, 0)),
    "visor": ((0.004, 0.004, 0.005), 0.08, 0.6, (0, 0, 0)),
    "eyecore": ((1.0, 0.45, 0.35), 0.3, 0.0, (1.0, 0.32, 0.22)),
}
REGION_INDEX = {name: i for i, name in enumerate(REGIONS)}


def region_uv(name):
    i = REGION_INDEX[name]
    col, row = i % 4, i // 4
    return ((col * BLOCK + BLOCK / 2) / ATLAS, 1.0 - (row * BLOCK + BLOCK / 2) / ATLAS)


class MeshBuilder:
    def __init__(self):
        self.verts = []  # Vector
        self.weights = []  # {bone: w}
        self.faces = []  # (indices, region, smooth)

    def v(self, co, weights):
        self.verts.append(Vector(co))
        total = sum(weights.values()) or 1.0
        self.weights.append({b: w / total for b, w in weights.items() if w > 1e-4})
        return len(self.verts) - 1

    def f(self, idx, region, smooth=True):
        self.faces.append((tuple(idx), region, smooth))

    # A tube through a list of rings. Each ring: (center, frame(Matrix3 cols
    # = u, v, axis), rx, ry, weights, exponent).
    def loft(self, rings, region, segs=20, cap_start=False, cap_end=False, smooth=True):
        loops = []
        for center, frame, rx, ry, weights, expo in rings:
            u, w = frame.col[0], frame.col[1]
            loop = []
            for k in range(segs):
                a = 2 * math.pi * k / segs
                c, s = math.cos(a), math.sin(a)
                # Superellipse: exponent 2 is an ellipse, higher is boxier.
                cx = math.copysign(abs(c) ** (2 / expo), c)
                sy = math.copysign(abs(s) ** (2 / expo), s)
                p = center + u * (rx * cx) + w * (ry * sy)
                loop.append(self.v(p, weights))
            loops.append(loop)
        for a, b in zip(loops, loops[1:]):
            for k in range(segs):
                k2 = (k + 1) % segs
                self.f((a[k], a[k2], b[k2], b[k]), region, smooth)
        if cap_start:
            self._cap(loops[0], rings[0], region, reverse=True, smooth=smooth)
        if cap_end:
            self._cap(loops[-1], rings[-1], region, reverse=False, smooth=smooth)
        return loops

    def _cap(self, loop, ring, region, reverse, smooth):
        center, frame, rx, ry, weights, _ = ring
        c = self.v(center + frame.col[2] * (0.25 * min(rx, ry) * (-1 if reverse else 1)), weights)
        n = len(loop)
        for k in range(n):
            a, b = loop[k], loop[(k + 1) % n]
            self.f((a, b, c) if not reverse else (b, a, c), region, smooth)

    def ellipsoid(self, center, radii, weights, region, segs=20, rings=14, shape=None, keep=None, rot=None):
        """UV sphere; `shape(dir) -> Vector offset scale`, `keep(dir) -> bool` per face."""
        center = Vector(center)
        grid = []
        for i in range(rings + 1):
            th = math.pi * i / rings
            row = []
            for j in range(segs):
                ph = 2 * math.pi * j / segs
                d = Vector((math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)))
                p = Vector((d.x * radii[0], d.y * radii[1], d.z * radii[2]))
                if shape:
                    p = shape(d, p)
                if rot:
                    p = rot @ p
                wts = weights(d) if callable(weights) else weights
                row.append((self.v(center + p, wts), d))
            grid.append(row)
        for i in range(rings):
            for j in range(segs):
                j2 = (j + 1) % segs
                quad = (grid[i][j], grid[i + 1][j], grid[i + 1][j2], grid[i][j2])
                if keep:
                    dmid = sum((q[1] for q in quad), Vector()) / 4
                    if not keep(dmid):
                        continue
                self.f(tuple(q[0] for q in quad), region)

    def box(self, center, size, frame, weights, region, bevel=0.0):
        """Rounded box as a boxy superellipse loft along frame axis."""
        center = Vector(center)
        axis = frame.col[2]
        length = size[2]
        rings = []
        steps = [-0.5, -0.5 + bevel, 0.5 - bevel, 0.5] if bevel > 0 else [-0.5, 0.5]
        for t in steps:
            shrink = 1.0 if -0.5 + bevel <= t <= 0.5 - bevel else 0.82
            rings.append((center + axis * (t * length), frame, size[0] / 2 * shrink, size[1] / 2 * shrink, weights, 5.0))
        self.loft(rings, region, segs=16, cap_start=True, cap_end=True)

    def build(self, name, arm_obj):
        me = bpy.data.meshes.new(name)
        bm = bmesh.new()
        bverts = [bm.verts.new(co) for co in self.verts]
        bm.verts.ensure_lookup_table()
        uv_layer = bm.loops.layers.uv.new("UVMap")
        for idx, region, smooth in self.faces:
            if len(set(idx)) < 3:
                continue
            try:
                face = bm.faces.new([bverts[i] for i in idx])
            except ValueError:
                continue
            face.smooth = smooth
            uv = region_uv(region)
            for loop in face.loops:
                loop[uv_layer].uv = uv
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.normal_update()
        bm.to_mesh(me)
        bm.free()
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        groups = {}
        for vi, wts in enumerate(self.weights):
            for bone, w in wts.items():
                if bone not in groups:
                    groups[bone] = obj.vertex_groups.new(name=bone)
                groups[bone].add([vi], w, "REPLACE")
        obj.parent = arm_obj
        mod = obj.modifiers.new("Armature", "ARMATURE")
        mod.object = arm_obj
        return obj


def frame_from_axis(axis, up_hint=Vector((0, -1, 0))):
    """Columns: u (side), v (front/up), axis. Deterministic for a given axis."""
    axis = Vector(axis).normalized()
    if abs(axis.dot(up_hint)) > 0.95:
        up_hint = Vector((1, 0, 0))
    u = up_hint.cross(axis).normalized()
    v = axis.cross(u).normalized()
    return Matrix((u, v, axis)).transposed()


def lerp_w(a, b, t):
    out = {}
    for k, w in a.items():
        out[k] = out.get(k, 0) + w * (1 - t)
    for k, w in b.items():
        out[k] = out.get(k, 0) + w * t
    return out


def smooth01(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


# --- parts --------------------------------------------------------------------
def add_hoodie(mb):
    Z = Matrix(((1, 0, 0), (0, 1, 0), (0, 0, 1)))

    def w_torso(z):
        # Blend weights up the spine chain.
        chain = [(0.96, "Hips"), (1.12, "Spine"), (1.24, "Spine1"), (1.38, "Spine2"), (1.52, "Neck")]
        if z <= chain[0][0]:
            return {"Hips": 1.0}
        for (z0, b0), (z1, b1) in zip(chain, chain[1:]):
            if z <= z1:
                t = smooth01((z - z0) / (z1 - z0))
                return {b0: 1 - t, b1: t}
        return {"Neck": 1.0}

    profile = [
        # z, half-width, half-depth, y-shift (neg = forward), exponent
        (0.785, 0.176, 0.128, 0.006, 2.6),
        (0.805, 0.181, 0.132, 0.006, 2.6),  # hem band
        (0.83, 0.177, 0.128, 0.005, 2.6),
        (0.885, 0.174, 0.125, 0.004, 2.6),
        (0.95, 0.171, 0.121, 0.002, 2.5),
        (1.04, 0.163, 0.116, 0.0, 2.4),
        (1.12, 0.161, 0.117, -0.002, 2.4),
        (1.20, 0.168, 0.122, -0.006, 2.4),
        (1.28, 0.177, 0.128, -0.009, 2.4),
        (1.35, 0.181, 0.13, -0.008, 2.3),
        (1.395, 0.176, 0.125, -0.004, 2.2),
        (1.435, 0.152, 0.112, 0.0, 2.1),
        (1.47, 0.118, 0.096, 0.006, 2.0),
        (1.50, 0.088, 0.082, 0.01, 2.0),
        (1.525, 0.072, 0.07, 0.012, 2.0),
    ]
    rings = []
    for z, rx, ry, dy, ex in profile:
        rings.append((Vector((0, dy, z)), Z, rx, ry, w_torso(z), ex))
    mb.loft(rings, "hoodie", segs=24, cap_start=True)

    # Sleeves
    for side, pre in ((1, "Left"), (-1, "Right")):
        d = _arm_dir(side)
        start = tail_of(f"{pre}Shoulder")
        fr = frame_from_axis(d, Vector((0, -1, 0)))
        L = UPPER_ARM + FOREARM
        sleeve = [
            # t along arm, radius-u, radius-v
            (-0.03, 0.06, 0.058),
            (-0.012, 0.07, 0.068),
            (0.0, 0.078, 0.076),
            (0.05, 0.071, 0.07),
            (0.12, 0.064, 0.063),
            (0.2, 0.059, 0.058),
            (0.255, 0.057, 0.056),
            (0.285, 0.056, 0.055),
            (0.32, 0.054, 0.053),
            (0.40, 0.05, 0.049),
            (0.46, 0.047, 0.046),
            (0.49, 0.049, 0.048),  # cuff
            (0.515, 0.047, 0.046),
            (0.53, 0.043, 0.042),
        ]
        rings = []
        for t, ru, rv in sleeve:
            if t < 0.0:
                # The ring inside the torso follows the clavicle, not the chest,
                # or it stays at the A-pose angle and pokes out of the shoulder.
                wt = {f"{pre}Shoulder": 0.75, f"{pre}Arm": 0.25}
            elif t < 0.06:
                wt = lerp_w({f"{pre}Shoulder": 0.5, f"{pre}Arm": 0.5}, {f"{pre}Arm": 1.0}, smooth01(t / 0.06))
            elif t < UPPER_ARM - 0.05:
                wt = {f"{pre}Arm": 1.0}
            elif t < UPPER_ARM + 0.05:
                k = smooth01((t - (UPPER_ARM - 0.05)) / 0.1)
                wt = {f"{pre}Arm": 1 - k, f"{pre}ForeArm": k}
            else:
                wt = {f"{pre}ForeArm": 1.0}
            rings.append((start + d * t, fr, ru, rv, wt, 2.0))
        mb.loft(rings, "hoodie", segs=18, cap_start=True)


def add_pants(mb):
    Z = Matrix(((1, 0, 0), (0, 1, 0), (0, 0, 1)))
    pelvis = [
        (1.0, 0.152, 0.11, 0.0),
        (0.93, 0.155, 0.113, 0.004),
        (0.86, 0.156, 0.114, 0.008),
        (0.815, 0.142, 0.105, 0.01),
        (0.78, 0.1, 0.08, 0.01),
    ]
    rings = [(Vector((0, dy, z)), Z, rx, ry, {"Hips": 1.0}, 2.6) for z, rx, ry, dy in pelvis]
    mb.loft(rings, "pants", segs=24, cap_end=True)

    for side, pre in ((1, "Left"), (-1, "Right")):
        hip = head_of(f"{pre}UpLeg")
        knee = head_of(f"{pre}Leg")
        ankle = head_of(f"{pre}Foot")
        thigh_d = (knee - hip).normalized()
        shin_d = (ankle - knee).normalized()
        fr_t = frame_from_axis(-thigh_d, Vector((0, -1, 0)))
        fr_s = frame_from_axis(-shin_d, Vector((0, -1, 0)))
        rings = []
        thigh_len = (knee - hip).length
        for t, r, wt in (
            (-0.03, 0.084, {"Hips": 0.55, f"{pre}UpLeg": 0.45}),
            (0.03, 0.084, {"Hips": 0.25, f"{pre}UpLeg": 0.75}),
            (0.1, 0.082, {f"{pre}UpLeg": 1.0}),
            (0.2, 0.077, {f"{pre}UpLeg": 1.0}),
            (0.3, 0.071, {f"{pre}UpLeg": 1.0}),
            (thigh_len - 0.04, 0.064, {f"{pre}UpLeg": 0.8, f"{pre}Leg": 0.2}),
        ):
            rings.append((hip + thigh_d * t, fr_t, r, r * 0.98, wt, 2.0))
        shin_len = (ankle - knee).length
        for t, r, wt in (
            (0.0, 0.062, {f"{pre}UpLeg": 0.5, f"{pre}Leg": 0.5}),
            (0.04, 0.061, {f"{pre}UpLeg": 0.2, f"{pre}Leg": 0.8}),
            (0.12, 0.06, {f"{pre}Leg": 1.0}),
            (0.22, 0.057, {f"{pre}Leg": 1.0}),
            (0.3, 0.054, {f"{pre}Leg": 1.0}),
            (shin_len - 0.04, 0.056, {f"{pre}Leg": 1.0}),
            (shin_len + 0.0, 0.058, {f"{pre}Leg": 1.0}),
        ):
            rings.append((knee + shin_d * t, fr_s, r, r, wt, 2.0))
        mb.loft(rings, "pants", segs=18)


def add_boots(mb):
    for side, pre in ((1, "Left"), (-1, "Right")):
        x = 0.095 * side
        Y = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))  # axis = -Y (toward toes)
        prof = [
            # y, half-width, z-bottom, z-top, bone weights
            (0.075, 0.042, 0.0, 0.085, {f"{pre}Foot": 1.0}),
            (0.06, 0.05, 0.0, 0.11, {f"{pre}Foot": 1.0}),
            (0.0, 0.054, 0.0, 0.115, {f"{pre}Foot": 1.0}),
            (-0.06, 0.055, 0.0, 0.085, {f"{pre}Foot": 1.0}),
            (-0.095, 0.054, 0.0, 0.07, {f"{pre}Foot": 0.5, f"{pre}ToeBase": 0.5}),
            (-0.14, 0.05, 0.0, 0.06, {f"{pre}ToeBase": 1.0}),
            (-0.175, 0.038, 0.004, 0.05, {f"{pre}ToeBase": 1.0}),
            (-0.19, 0.022, 0.012, 0.038, {f"{pre}ToeBase": 1.0}),
        ]
        rings = []
        for y, hw, zb, zt, wt in prof:
            c = Vector((x, y, (zb + zt) / 2))
            rings.append((c, Y, hw, (zt - zb) / 2, wt, 3.2))
        mb.loft(rings, "boots", segs=18, cap_start=True, cap_end=True)
        # Sole slab
        rings = []
        for y, hw, zb, zt, wt in prof[:-1]:
            c = Vector((x, y, 0.009))
            rings.append((c, Y, hw * 1.06 + 0.003, 0.011, wt, 6.0))
        mb.loft(rings, "sole", segs=16, cap_start=True, cap_end=True)
        # Shaft around the ankle
        Z = Matrix(((1, 0, 0), (0, 1, 0), (0, 0, 1)))
        shaft = [
            (0.06, 0.056, {f"{pre}Foot": 1.0}),
            (0.12, 0.058, {f"{pre}Foot": 0.8, f"{pre}Leg": 0.2}),
            (0.17, 0.06, {f"{pre}Foot": 0.3, f"{pre}Leg": 0.7}),
            (0.185, 0.061, {f"{pre}Leg": 1.0}),
        ]
        rings = [(Vector((x, 0.018, z)), Z, r, r * 1.05, wt, 2.2) for z, r, wt in shaft]
        mb.loft(rings, "boots", segs=16)
        # Red accent strip at the top of the shaft
        rings = [
            (Vector((x, 0.018, 0.176)), Z, 0.0625, 0.0655, {f"{pre}Leg": 1.0}, 2.2),
            (Vector((x, 0.018, 0.183)), Z, 0.0625, 0.0655, {f"{pre}Leg": 1.0}, 2.2),
        ]
        mb.loft(rings, "accent", segs=16)


# The head, neck and hood live in head.py (imported after the helpers it uses).
from head import add_head, add_hood  # noqa: E402


def add_hands(mb):
    for side, pre in ((1, "Left"), (-1, "Right")):
        d = _arm_dir(side)
        n = _palm_normal(side)
        wrist = head_of(f"{pre}Hand")
        # Wrist joint
        fr = frame_from_axis(d)
        rings = [
            (wrist - d * 0.03, fr, 0.03, 0.026, {f"{pre}ForeArm": 1.0}, 2.0),
            (wrist, fr, 0.028, 0.024, {f"{pre}ForeArm": 0.5, f"{pre}Hand": 0.5}, 2.0),
            (wrist + d * 0.012, fr, 0.027, 0.023, {f"{pre}Hand": 1.0}, 2.0),
        ]
        mb.loft(rings, "joint", segs=12)
        # Palm: a flat rounded box, width along Y, thickness along n.
        side_axis = Vector((0, 1, 0))
        palm_frame = Matrix((side_axis, n, d)).transposed()
        pc = wrist + d * 0.05
        mb.box(pc, (0.082, 0.03, 0.085), palm_frame, {f"{pre}Hand": 1.0}, "metal", bevel=0.18)
        # Fingers
        for fname, r in (("Index", 0.0092), ("Middle", 0.0097), ("Ring", 0.0092), ("Pinky", 0.0082)):
            for seg in (1, 2):
                b = f"{pre}Hand{fname}{seg}"
                h, t = head_of(b), tail_of(b)
                ax = (t - h).normalized()
                ff = frame_from_axis(ax)
                L = (t - h).length
                rr = r * (1.0 if seg == 1 else 0.9)
                rings = [
                    (h - ax * 0.004, ff, rr, rr * 0.9, {b: 1.0}, 2.2),
                    (h + ax * (L * 0.5), ff, rr * 1.05, rr * 0.95, {b: 1.0}, 2.2),
                    (t - ax * 0.002, ff, rr * 0.92, rr * 0.85, {b: 1.0}, 2.2),
                ]
                mb.loft(rings, "metal" if seg == 1 else "metal", segs=8, cap_start=True, cap_end=True)
                # knuckle joint
                mb.ellipsoid(h, (rr * 1.12, rr * 1.12, rr * 1.12), {b: 1.0}, "joint", segs=8, rings=5)
        for seg in (1, 2):
            b = f"{pre}HandThumb{seg}"
            h, t = head_of(b), tail_of(b)
            ax = (t - h).normalized()
            ff = frame_from_axis(ax)
            rr = 0.0115 if seg == 1 else 0.0102
            rings = [
                (h - ax * 0.004, ff, rr, rr * 0.9, {b: 1.0}, 2.2),
                (t - ax * 0.002, ff, rr * 0.92, rr * 0.85, {b: 1.0}, 2.2),
            ]
            mb.loft(rings, "metal", segs=8, cap_start=True, cap_end=True)
            mb.ellipsoid(h, (rr * 1.1,) * 3, {b: 1.0}, "joint", segs=8, rings=5)


def build_body(arm_obj):
    mb = MeshBuilder()
    add_hoodie(mb)
    add_pants(mb)
    add_boots(mb)
    add_head(mb)
    add_hood(mb)
    add_hands(mb)
    obj = mb.build("HackerBody", arm_obj)
    obj.data.materials.append(build_material())
    print(f"[body] verts={len(mb.verts)} faces={len(mb.faces)}")
    return obj


# --- material -----------------------------------------------------------------
def _atlas_image(name, fn, colorspace):
    img = bpy.data.images.new(name, ATLAS, ATLAS, alpha=False)
    img.colorspace_settings.name = colorspace
    px = [0.0] * (ATLAS * ATLAS * 4)
    for rname, spec in REGIONS.items():
        i = REGION_INDEX[rname]
        col, row = i % 4, i // 4
        rgb = fn(spec)
        for y in range(BLOCK):
            for x in range(BLOCK):
                gx = col * BLOCK + x
                gy = ATLAS - 1 - (row * BLOCK + y)
                o = (gy * ATLAS + gx) * 4
                px[o : o + 4] = [rgb[0], rgb[1], rgb[2], 1.0]
    img.pixels[:] = px
    img.pack()
    return img


# Specular IOR level per region (0.5 = default dielectric F0 of 4%).
SPECULAR = {"hoodie": 0.03, "pants": 0.04, "boots": 0.25, "sole": 0.15}


def _specular_image():
    img = bpy.data.images.new("hacker_specular", ATLAS, ATLAS, alpha=True)
    img.colorspace_settings.name = "Non-Color"
    px = [1.0] * (ATLAS * ATLAS * 4)
    for rname in REGIONS:
        i = REGION_INDEX[rname]
        col, row = i % 4, i // 4
        level = SPECULAR.get(rname, 0.5)
        for y in range(BLOCK):
            for x in range(BLOCK):
                gx = col * BLOCK + x
                gy = ATLAS - 1 - (row * BLOCK + y)
                px[(gy * ATLAS + gx) * 4 + 3] = level
    img.pixels[:] = px
    img.pack()
    return img


def _to_srgb(c):
    return tuple((12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055) for v in c)


def build_material():
    mat = bpy.data.materials.new("HackerMaterial")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    base = _atlas_image("hacker_base", lambda s: _to_srgb(s[0]), "sRGB")
    orm = _atlas_image("hacker_orm", lambda s: (1.0, s[1], s[2]), "Non-Color")
    emis = _atlas_image("hacker_emissive", lambda s: _to_srgb(s[3]), "sRGB")

    def tex(img):
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        node.interpolation = "Closest"
        return node

    tb, to, te = tex(base), tex(orm), tex(emis)
    nt.links.new(tb.outputs["Color"], bsdf.inputs["Base Color"])
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(to.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nt.links.new(te.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 4.0
    # Fabric reads grey under bright light because of its dielectric specular,
    # not its albedo: a per-region specular level (exported as
    # KHR_materials_specular) keeps cloth deep black while metal stays glossy.
    ts = tex(_specular_image())
    nt.links.new(ts.outputs["Alpha"], bsdf.inputs["Specular IOR Level"])
    mat.use_backface_culling = False
    return mat
