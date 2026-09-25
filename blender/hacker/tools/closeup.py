"""Close-up renders of the head for look development.

  blender -b --factory-startup -P blender/hacker/tools/closeup.py -- OUT_DIR
Renders the character in its Idle pose (frame 0) from the front, 3/4 front,
the side and from above (the office camera angle) into OUT_DIR/head.png.
"""

import importlib
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "anims"))

import body  # noqa: E402
import pose  # noqa: E402
import rig  # noqa: E402


def main():
    out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else os.path.join(ROOT, "..", "_preview", "head")
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    arm = rig.build_armature()
    body.build_body(arm)
    idle = importlib.import_module("idle")
    anim = pose.Animator(arm)
    anim.begin(idle.NAME, idle.FRAMES)
    idle.build(anim)
    anim.finish()
    scene.frame_set(0)

    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.012, 0.012, 0.014, 1)
    scene.world = world

    def light(kind, loc, energy, color, size, target=(0, 0, 1.62)):
        ld = bpy.data.lights.new("L", kind)
        ld.energy = energy
        ld.color = color
        ld.size = size
        lo = bpy.data.objects.new("L", ld)
        lo.location = loc
        scene.collection.objects.link(lo)
        lo.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()

    light("AREA", (-0.9, -1.4, 2.1), 70, (1, 0.97, 0.94), 0.8)  # white key
    light("AREA", (1.2, -0.8, 1.7), 14, (0.8, 0.85, 1.0), 1.0)  # fill
    light("AREA", (0.6, 1.0, 1.9), 160, (1.0, 0.06, 0.03), 0.6)  # red rim
    light("AREA", (-0.8, 0.9, 1.6), 90, (1.0, 0.06, 0.03), 0.6)  # red rim

    cam_data = bpy.data.cameras.new("C")
    cam_data.lens = 85
    cam = bpy.data.objects.new("C", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    import numpy as np

    tiles = []
    tmp = os.path.join(out, "_t.png")
    for yaw, pitch, dist in ((0, 4, 1.25), (35, 4, 1.25), (90, 2, 1.25), (30, 38, 1.5)):
        a, e = math.radians(yaw), math.radians(pitch)
        target = Vector((0, -0.02, 1.62))
        cam.location = target + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
        cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
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
    res.filepath_raw = os.path.join(out, "head.png")
    res.file_format = "PNG"
    res.save()
    os.remove(tmp)
    print("[closeup]", os.path.join(out, "head.png"))


main()
