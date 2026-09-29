"""Mesh for the hacker character: a black android in techwear (hoodie, open
jacket, harness, cargo pants, gloves, combat boots; see outfit.py).

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

from rig import BONE, FOREARM, UPPER_ARM, _arm_dir, tail_of

# --- material atlas ---------------------------------------------------------
ATLAS = 64
BLOCK = 16  # 4 x 4 blocks
# name: (base rgb (linear), roughness, metallic, emission rgb (linear))
REGIONS = {
    "hoodie": ((0.0065, 0.0065, 0.007), 0.88, 0.0, (0, 0, 0)),
    "pants": ((0.0078, 0.0078, 0.0082), 0.84, 0.0, (0, 0, 0)),
    # Satin graphite rather than chrome: the face reads as metal without
    # white hotspots or grey smudges that compete with the eyes.
    "metal": ((0.016, 0.016, 0.017), 0.6, 0.85, (0, 0, 0)),
    # Eye globe and pupil: glowing red metal, no dark tones; the brighter part
    # is the iris ring ("eyecore").
    # Pure red with no green/blue, and emission kept low: brighter red washes
    # out to pink under the tone mapping.
    "eyes": ((0.8, 0.003, 0.0015), 0.3, 1.0, (0.16, 0.0008, 0.0004)),
    "accent": ((0.6, 0.02, 0.015), 0.4, 0.0, (0.55, 0.012, 0.008)),
    "boots": ((0.006, 0.006, 0.007), 0.72, 0.0, (0, 0, 0)),
    "sole": ((0.0045, 0.0045, 0.005), 0.85, 0.0, (0, 0, 0)),
    "joint": ((0.05, 0.05, 0.055), 0.35, 0.85, (0, 0, 0)),
    # Panel seams: near black and satin, so seams read as thin lines.
    "visor": ((0.002, 0.002, 0.0025), 0.5, 0.3, (0, 0, 0)),
    # Iris ring: the brightest red, still short of clipping to pink or white.
    "eyecore": ((0.9, 0.003, 0.0015), 0.26, 1.0, (0.3, 0.0015, 0.0007)),
    # Outfit (outfit.py). Everything is near black (sRGB #141414-#1a1a1a);
    # the layers separate by their edges and by the jacket's slight nylon
    # sheen (a higher specular level, see SPECULAR), not by greyness.
    "jacket": ((0.0085, 0.0085, 0.009), 0.8, 0.0, (0, 0, 0)),
    "rib": ((0.006, 0.006, 0.0065), 0.95, 0.0, (0, 0, 0)),
    "mask": ((0.0055, 0.0055, 0.006), 0.93, 0.0, (0, 0, 0)),
    "glove": ((0.0075, 0.0075, 0.008), 0.8, 0.0, (0, 0, 0)),
    # Webbing is as black as the cloth (a touch of sheen via SPECULAR); the
    # buckles are dark gunmetal.
    "strap": ((0.0068, 0.0068, 0.0072), 0.8, 0.0, (0, 0, 0)),
    "buckle": ((0.024, 0.024, 0.026), 0.5, 0.5, (0, 0, 0)),
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
def torso_weights(z):
    """Blend weights up the spine chain (shared by every garment on the torso)."""
    chain = [(0.96, "Hips"), (1.12, "Spine"), (1.24, "Spine1"), (1.38, "Spine2"), (1.52, "Neck")]
    if z <= chain[0][0]:
        return {"Hips": 1.0}
    for (z0, b0), (z1, b1) in zip(chain, chain[1:]):
        if z <= z1:
            t = smooth01((z - z0) / (z1 - z0))
            return {b0: 1 - t, b1: t}
    return {"Neck": 1.0}


# The neckline layers (gaiter, hood base, hoodie funnel, jacket collar) share
# one Neck/Spine2 blend, so head turns cannot pull them through each other.
NECKLINE_W = {"Neck": 0.45, "Spine2": 0.55}


def neckline_weights(z):
    """torso_weights with the Neck share capped at the shared neckline blend."""
    w = torso_weights(z)
    return dict(NECKLINE_W) if w.get("Neck", 0.0) > NECKLINE_W["Neck"] else w


HOODIE_PROFILE = [
    # z, half-width, half-depth, y-shift (neg = forward), exponent
    # The hem sits at the top of the thighs (not the crotch), so the legs
    # read long below the short bomber.
    (0.85, 0.172, 0.126, 0.006, 2.6),
    (0.866, 0.177, 0.13, 0.006, 2.6),  # hem band
    (0.89, 0.174, 0.127, 0.005, 2.6),
    (0.92, 0.172, 0.124, 0.004, 2.6),
    (0.95, 0.171, 0.121, 0.002, 2.5),
    (1.04, 0.163, 0.116, 0.0, 2.4),
    (1.12, 0.161, 0.117, -0.002, 2.4),
    (1.20, 0.168, 0.122, -0.006, 2.4),
    (1.28, 0.177, 0.128, -0.009, 2.4),
    (1.35, 0.181, 0.13, -0.008, 2.3),
    (1.395, 0.176, 0.125, -0.004, 2.2),
    (1.435, 0.152, 0.112, 0.0, 2.1),
    (1.47, 0.118, 0.096, 0.006, 2.0),
    # Funnel neckline: wide enough that the gaiter and the hood base tuck
    # inside it, narrow enough to sit inside the jacket's stand collar.
    (1.50, 0.093, 0.088, 0.01, 2.0),
    (1.527, 0.087, 0.084, 0.01, 2.0),
]


def add_hoodie(mb, sleeves=True):
    """The hoodie torso; its sleeves are left out under the jacket."""
    Z = Matrix(((1, 0, 0), (0, 1, 0), (0, 0, 1)))
    rings = []
    for z, rx, ry, dy, ex in HOODIE_PROFILE:
        rings.append((Vector((0, dy, z)), Z, rx, ry, neckline_weights(z), ex))
    mb.loft(rings, "hoodie", segs=24, cap_start=True)
    if not sleeves:
        return

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


# The head, neck and hood live in head.py (imported after the helpers it uses).
from head import add_head, add_hood  # noqa: E402
import outfit  # noqa: E402


def build_body(arm_obj):
    mb = MeshBuilder()
    add_hoodie(mb, sleeves=False)
    outfit.add_hoodie_pocket(mb)
    outfit.add_jacket(mb)
    outfit.add_harness(mb)
    outfit.add_cargo_pants(mb)
    outfit.add_combat_boots(mb)
    add_head(mb)
    add_hood(mb)
    if outfit.MASK:
        outfit.add_mask(mb)
    outfit.add_gloves(mb)
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
SPECULAR = {"hoodie": 0.03, "pants": 0.04, "boots": 0.06, "sole": 0.03, "jacket": 0.1, "rib": 0.02,
            "mask": 0.02, "glove": 0.04, "strap": 0.08, "buckle": 0.3, "metal": 0.3, "visor": 0.2}


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
