"""Presentation renders of the hacker character in a dark studio.

  blender -b --factory-startup -P blender/hacker/tools/showcase.py -- OUT_DIR
      [--no-mask] [--only turnaround,neutral,seated,head] [--suffix _x] [--scale 1.0]

Black backdrop, a soft white key, red rim lights and a thin red line on the
floor. Writes into OUT_DIR:
  turnaround.png  Idle frame 0: front, 3/4, side and back (the character turns,
                  the lights stay, so every view keeps the red rim)
  turnaround_neutral.png  the same views in plain grey studio light, to judge
                  the shapes of the near-black outfit
  seated.png      SitType at the reference workstation (workstation.glb, its
                  screens showing scrolling code), from behind-side and front
  head_mask.png / head_nomask.png  head close-ups (--no-mask for the second)
"""

import importlib
import math
import os
import random
import sys

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)
ROOT = os.path.abspath(os.path.join(SRC, "..", ".."))
sys.path.insert(0, SRC)
sys.path.insert(0, os.path.join(SRC, "anims"))

import body  # noqa: E402
import outfit  # noqa: E402
import pose  # noqa: E402
import rig  # noqa: E402

WORKSTATION = os.path.join(ROOT, "public", "office-assets", "models", "hq", "workstation.glb")


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    opts = {"out": argv[0] if argv and not argv[0].startswith("--") else os.path.join(SRC, "..", "_preview", "showcase"),
            "mask": True, "only": {"turnaround", "neutral", "seated", "head"}, "suffix": "", "scale": 1.0,
            "workstation": WORKSTATION}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-mask":
            opts["mask"] = False
        elif a == "--only":
            opts["only"] = set(argv[i + 1].split(",")); i += 1
        elif a == "--suffix":
            opts["suffix"] = argv[i + 1]; i += 1
        elif a == "--scale":
            opts["scale"] = float(argv[i + 1]); i += 1
        elif a == "--workstation":
            opts["workstation"] = argv[i + 1]; i += 1
        i += 1
    return opts


# --- scene ------------------------------------------------------------------------
def build_character(clips):
    arm = rig.build_armature()
    body.build_body(arm)
    anim = pose.Animator(arm)
    for name in clips:
        mod = importlib.import_module(name)
        anim.begin(mod.NAME, mod.FRAMES, cyclic=getattr(mod, "CYCLIC", True))
        mod.build(anim)
        anim.finish()
    return arm


def _mat(name, color, rough, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Specular IOR Level"].default_value = 0.2
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1)
        p.inputs["Emission Strength"].default_value = strength
    return m


def _plane(name, loc, size, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = (size[0], size[1], 1)
    o.data.materials.append(mat)
    return o


def studio(scene, w, h, floor_line=True, neutral=False):
    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = w
    scene.render.resolution_y = h
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    ee = scene.eevee
    # Finer, jittered shadows: the default shadow maps leak the rim light
    # through the thin hood as red speckle on the lining around the face.
    for attr, val in (("use_shadows", True), ("taa_render_samples", 64), ("use_raytracing", True),
                      ("shadow_ray_count", 4), ("shadow_step_count", 16), ("shadow_pool_size", "1024")):
        if hasattr(ee, attr):
            setattr(ee, attr, val)
    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.0025, 0.0025, 0.003, 1)
    scene.world = world
    if neutral:
        world.node_tree.nodes["Background"].inputs[0].default_value = (0.2, 0.2, 0.21, 1)
        _plane("floor", (0, 0, 0), (30, 30), _mat("floor", (0.25, 0.25, 0.26), 0.8))
        return

    # Matte black floor and a backdrop wall; a thin red line runs across the floor.
    _plane("floor", (0, 0, 0), (30, 30), _mat("floor", (0.008, 0.008, 0.009), 0.62))
    wall = _plane("wall", (0, 6.0, 4), (30, 10), _mat("wall", (0.03, 0.03, 0.033), 0.95), rot=(math.radians(90), 0, 0))
    global BACKDROP
    BACKDROP = bpy.data.collections.new("Backdrop")
    scene.collection.children.link(BACKDROP)
    BACKDROP.objects.link(wall)
    if floor_line:
        line = _plane("redline", (0.4, 0.75, 0.0015), (9, 0.012),
                      _mat("redline", (0.2, 0, 0), 0.5, emit=(1.0, 0.03, 0.02), strength=14.0),
                      rot=(0, 0, math.radians(-7)))
        line.visible_shadow = False
        line.visible_diffuse = False  # a line on the floor, not a light: no red cast on the boots


# Lights that should only touch the character (red rims) are light-linked to
# this collection, so their beams do not paint the floor behind or under it.
CHARACTER = None
BACKDROP = None  # the backdrop wall (studio()), for the glow behind the figure


def light(scene, kind, loc, energy, color, size, target, spread=None, character_only=False, receivers=None):
    ld = bpy.data.lights.new("L", kind)
    ld.energy = energy
    ld.color = color
    for attr, val in (("use_shadow_jitter", True), ("shadow_maximum_resolution", 0.0003)):
        if hasattr(ld, attr):
            setattr(ld, attr, val)
    if kind == "AREA":
        ld.size = size
        if spread is not None:
            ld.spread = math.radians(spread)  # a tight rim that stays off the floor
    elif kind == "SPOT":
        ld.spot_size = size
        ld.spot_blend = 0.6
    lo = bpy.data.objects.new("L", ld)
    lo.location = loc
    scene.collection.objects.link(lo)
    lo.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    if character_only and CHARACTER is not None:
        lo.light_linking.receiver_collection = CHARACTER
    elif receivers is not None:
        lo.light_linking.receiver_collection = receivers
    return lo


def body_lights(scene, k=1.0):
    # Key and fill are strong enough that near-black cloth separates from the
    # backdrop by its shading, not only by the red rims.
    light(scene, "AREA", (-1.6, -2.6, 2.4), 420 * k, (1, 0.97, 0.95), 2.0, (0, 0, 1.0), spread=70)  # soft key
    light(scene, "AREA", (2.2, -2.2, 1.2), 110 * k, (0.85, 0.88, 0.95), 2.5, (0, 0, 0.8), spread=80)  # fill
    light(scene, "AREA", (0, -3.0, 0.3), 60 * k, (0.9, 0.9, 0.95), 2.0, (0, 0, 0.4), spread=70)  # low fill: legs, boots
    # Red rims in two tiers of spot lights with hard cones aimed level: the
    # upper pair edges the torso and hood, the lower pair the legs. The cones
    # stop above the boots; a wide rim from shoulder height also lit the toe
    # caps from above (a red wash on the boots).
    red = (1.0, 0.05, 0.03)
    for loc, energy, target, cone in (((1.4, 1.5, 1.45), 1300, (0, 0, 1.3), 34), ((-1.4, 1.4, 1.35), 800, (0, 0, 1.2), 34),
                                      ((1.4, 1.5, 0.8), 600, (0, 0, 0.62), 22), ((-1.4, 1.4, 0.8), 380, (0, 0, 0.62), 22)):
        lo = light(scene, "SPOT", loc, energy * k, red, math.radians(cone), target, character_only=True)
        lo.data.shadow_soft_size = 0.2
    # A soft grey glow on the backdrop behind the figure: the silhouette reads
    # against it (a gradient, dark at the edges).
    light(scene, "AREA", (0, 4.2, 1.1), 110 * k, (1, 1, 1), 1.5, (0, 6.0, 1.2), spread=60, receivers=BACKDROP)


def desk_lights(scene):
    """Seated shots: the screens light the front, a soft white top light and a
    key on the character. Red rims are per shot (returned as two sets): each
    view gets rims from beyond the character, so they draw the silhouette
    instead of washing the side that faces the camera."""
    # Kept low: the cloth is near black and should stay black, not go grey.
    # Neutral to slightly cool white; the red stays in the narrow rims.
    light(scene, "AREA", (-0.6, 0.6, 3.0), 55, (0.95, 0.97, 1.0), 1.5, (0, -0.2, 0.9), spread=70, character_only=True)  # top
    light(scene, "AREA", (1.3, -1.7, 2.2), 50, (0.95, 0.97, 1.0), 1.2, (0, 0.0, 1.1), character_only=True)  # front key
    light(scene, "AREA", (2.2, 1.6, 1.6), 50, (0.85, 0.9, 1.0), 2.0, (0, -0.2, 1.0), spread=70, character_only=True)  # back fill
    # Room light: large and weak, so chair and desk read without a hotspot.
    light(scene, "AREA", (0.3, 0.0, 3.4), 220, (0.9, 0.92, 1.0), 6.0, (0.0, -0.3, 0.0))
    red = (1.0, 0.05, 0.03)
    # Narrow cones on the shoulders and hood, so the lap and legs get no red wash.
    behind = [light(scene, "AREA", (-1.3, -1.1, 1.5), 110, red, 0.4, (0, 0.0, 1.15), spread=45, character_only=True),
              light(scene, "AREA", (0.9, -1.4, 1.7), 50, red, 0.4, (0, 0.0, 1.15), spread=45, character_only=True)]
    front = [light(scene, "AREA", (-1.3, 1.3, 1.6), 150, red, 0.4, (0, 0.0, 1.2), spread=45, character_only=True),
             light(scene, "AREA", (0.4, 1.5, 1.9), 60, red, 0.4, (0, 0.0, 1.25), spread=45, character_only=True)]
    return behind, front


def _use(on, off):
    for lo in on:
        lo.hide_render = False
    for lo in off:
        lo.hide_render = True


def camera(scene, lens):
    cd = bpy.data.cameras.new("C")
    cd.lens = lens
    cam = bpy.data.objects.new("C", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def aim(cam, loc, target):
    cam.location = Vector(loc)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()


def render_tiles(scene, out_path, shots):
    """shots: callables that set up the scene for one tile; tiles side by side."""
    tiles = []
    tmp = out_path + "._tile.png"
    for setup in shots:
        setup()
        scene.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(tmp, check_existing=False)
        w, h = img.size
        tiles.append(np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4))
        bpy.data.images.remove(img)
    sheet = np.concatenate(tiles, axis=1)
    h, w = sheet.shape[:2]
    res = bpy.data.images.new("sheet", w, h, alpha=True)
    res.pixels[:] = sheet.ravel()
    res.filepath_raw = out_path
    res.file_format = "PNG"
    res.save()
    os.remove(tmp)
    print(f"[showcase] {out_path} {w}x{h}")


def set_pose(scene, arm, action, frame):
    arm.animation_data.action = bpy.data.actions[action]
    scene.frame_set(frame)


# --- workstation ------------------------------------------------------------------
def code_texture(w=768, h=480, seed=7):
    """Dark screen with lines of red/grey code and a few bright red tokens."""
    rnd = random.Random(seed)
    px = np.zeros((h, w, 4), dtype=np.float32)
    px[..., :3] = (0.004, 0.002, 0.002)
    px[..., 3] = 1.0
    row_h, glyph = 11, 5
    y = h - 14
    indent = 0
    while y > 8:
        indent = max(0, min(6, indent + rnd.choice((-1, 0, 0, 1))))
        x = 10 + indent * 14
        for _ in range(rnd.randint(1, 6)):
            n = rnd.randint(2, 12)
            kind = rnd.random()
            col = (0.9, 0.05, 0.03) if kind < 0.18 else (0.35, 0.02, 0.015) if kind < 0.6 else (0.28, 0.26, 0.26)
            for g in range(n):
                if x + glyph >= w - 8:
                    break
                gh = rnd.choice((4, 5, 6))
                px[y - gh : y, x : x + glyph - 1, :3] = col
                x += glyph + 1
            x += glyph + 2
        y -= row_h
    img = bpy.data.images.new("code", w, h, alpha=False)
    img.pixels[:] = px.ravel()
    img.pack()
    return img


def add_workstation(path):
    bpy.ops.import_scene.gltf(filepath=path)
    for o in list(bpy.context.scene.objects):
        if o.type == "MESH" and "lod1" in o.name:
            bpy.data.objects.remove(o, do_unlink=True)
        elif o.type == "MESH" and o.name.startswith("ws_led"):
            # The desk-edge LED strip is right in front of the lap: seen by
            # the camera, but it does not light the character (no red lap).
            o.visible_diffuse = False
    img = code_texture()
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or not o.name.startswith("ws_screen"):
            continue
        m = bpy.data.materials.new("screen_code")
        m.use_nodes = True
        nt = m.node_tree
        p = nt.nodes.get("Principled BSDF")
        p.inputs["Base Color"].default_value = (0, 0, 0, 1)
        p.inputs["Roughness"].default_value = 0.35
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        # Each screen faces +Y (toward the chair): map object X/Z onto the image.
        mp.inputs["Scale"].default_value = (1.9, 1.0, 3.2)
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        comb = nt.nodes.new("ShaderNodeCombineXYZ")
        nt.links.new(mp.outputs["Vector"], sep.inputs["Vector"])
        nt.links.new(sep.outputs["X"], comb.inputs["X"])
        nt.links.new(sep.outputs["Z"], comb.inputs["Y"])
        nt.links.new(comb.outputs["Vector"], tex.inputs["Vector"])
        tex.extension = "REPEAT"
        nt.links.new(tex.outputs["Color"], p.inputs["Emission Color"])
        p.inputs["Emission Strength"].default_value = 3.0
        o.data.materials.clear()
        o.data.materials.append(m)


# --- sheets -----------------------------------------------------------------------
def turnaround(scene, arm, out, s):
    studio(scene, int(760 * s), int(1240 * s))
    body_lights(scene)
    cam = camera(scene, 72)
    set_pose(scene, arm, "Idle", 0)
    shots = []
    for yaw in (0, 35, 90, 180):
        def setup(yaw=yaw):
            arm.rotation_euler = (0, 0, math.radians(yaw))
            aim(cam, (0, -4.6, 1.02), (0, 0, 0.93))
        shots.append(setup)
    render_tiles(scene, os.path.join(out, "turnaround.png"), shots)
    arm.rotation_euler = (0, 0, 0)


def turnaround_neutral(scene, arm, out, s):
    """Plain grey studio: a big soft key, fill and top light, no rims."""
    studio(scene, int(760 * s), int(1240 * s), neutral=True)
    light(scene, "AREA", (-2.0, -2.6, 3.0), 700, (1, 1, 1), 3.0, (0, 0, 1.0))
    light(scene, "AREA", (2.5, -1.8, 1.6), 300, (1, 1, 1), 3.0, (0, 0, 0.9))
    light(scene, "AREA", (0.6, 3.0, 2.6), 400, (1, 1, 1), 3.0, (0, 0, 1.1))
    cam = camera(scene, 72)
    set_pose(scene, arm, "Idle", 0)
    shots = []
    for yaw in (0, 35, 90, 180):
        def setup(yaw=yaw):
            arm.rotation_euler = (0, 0, math.radians(yaw))
            aim(cam, (0, -4.6, 1.02), (0, 0, 0.93))
        shots.append(setup)
    render_tiles(scene, os.path.join(out, "turnaround_neutral.png"), shots)
    arm.rotation_euler = (0, 0, 0)


def seated(scene, arm, out, s, ws_path):
    studio(scene, int(1100 * s), int(900 * s), floor_line=False)
    scene.view_settings.exposure = 1.0  # a dim room lit by its screens
    rims_behind, rims_front = desk_lights(scene)
    add_workstation(ws_path)
    cam = camera(scene, 45)
    set_pose(scene, arm, "SitType", 24)

    def behind():
        _use(rims_behind, rims_front)
        aim(cam, (1.75, 1.55, 1.55), (0.0, -0.25, 0.92))

    def front():
        # From the front-right, past the angled side monitor.
        _use(rims_front, rims_behind)
        aim(cam, (1.6, -1.3, 1.75), (0.0, -0.12, 1.0))

    render_tiles(scene, os.path.join(out, "seated.png"), [behind, front])


def head(scene, arm, out, s, name):
    studio(scene, int(760 * s), int(760 * s), floor_line=False)
    light(scene, "AREA", (-0.9, -1.4, 2.1), 55, (1, 0.97, 0.94), 0.8, (0, 0, 1.62))  # white key
    light(scene, "AREA", (1.2, -0.8, 1.7), 8, (0.8, 0.85, 1.0), 1.0, (0, 0, 1.62))  # fill
    light(scene, "AREA", (0.8, 0.9, 1.7), 70, (1.0, 0.05, 0.03), 0.4, (0, 0, 1.64), spread=35)  # red rim
    light(scene, "AREA", (-0.9, 0.8, 1.6), 45, (1.0, 0.05, 0.03), 0.4, (0, 0, 1.62), spread=35)  # red rim
    cam = camera(scene, 85)
    set_pose(scene, arm, "Idle", 0)
    shots = []
    for yaw, pitch, dist in ((0, 3, 1.2), (32, 4, 1.2), (70, 2, 1.2)):
        def setup(yaw=yaw, pitch=pitch, dist=dist):
            a, e = math.radians(yaw), math.radians(pitch)
            target = Vector((0, -0.02, 1.61))
            aim(cam, target + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist, target)
        shots.append(setup)
    render_tiles(scene, os.path.join(out, name), shots)


def clear_scene_but(keep):
    for o in list(bpy.context.scene.objects):
        if o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)


def main():
    opts = parse_args()
    outfit.MASK = opts["mask"]
    out = opts["out"]
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 30
    arm = build_character(["idle", "sit_type"])
    keep = {arm} | {c for c in arm.children}
    global CHARACTER
    CHARACTER = bpy.data.collections.new("Character")
    scene.collection.children.link(CHARACTER)
    for c in arm.children:
        CHARACTER.objects.link(c)
    s = opts["scale"]
    if "turnaround" in opts["only"]:
        turnaround(scene, arm, out, s)
        clear_scene_but(keep)
    if "neutral" in opts["only"]:
        turnaround_neutral(scene, arm, out, s)
        clear_scene_but(keep)
    if "seated" in opts["only"]:
        seated(scene, arm, out, s, opts["workstation"])
        clear_scene_but(keep)
    if "head" in opts["only"]:
        head(scene, arm, out, s, ("head_mask" if opts["mask"] else "head_nomask") + opts["suffix"] + ".png")


main()
