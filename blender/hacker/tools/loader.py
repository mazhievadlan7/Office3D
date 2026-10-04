"""The loading mascot: the HQ android hacker's bust on a transparent background.

  blender -b --factory-startup -P blender/hacker/tools/loader.py -- [OUT_DIR]

Builds the same character as build.py (head, hood, fabric mask, techwear),
poses it at Idle frame 0 and renders head, shoulders and chest from a slight
3/4 front view with soft red rims and no backdrop (the page draws the glow
behind it). Writes:

  OUT_DIR/hacker-loader.webp       512 x 512 with alpha (the overlays)
  OUT_DIR/hacker-loader-160.webp   160 x 160 with alpha (inline spinners, buttons)

and prints where the two eyes land in the frame (fractions from the top
left), which the loader's eye glow (src/features/agents/components/
HqAndroidLoader.tsx, EYES) is placed on. OUT_DIR defaults to
public/office-assets/avatars.
"""

import importlib
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "anims"))

import body  # noqa: E402
import head  # noqa: E402
import outfit  # noqa: E402
import pose  # noqa: E402
import rig  # noqa: E402

SIZE = 512
SMALL = 160
# Bust framing: the hood's crown at the top, the chest rig's straps at the bottom.
TARGET = Vector((0.0, -0.06, 1.55))
YAW, PITCH, DIST, LENS = 18.0, 4.0, 1.6, 85
EXPOSURE = 0.85


def build_character(scene):
    outfit.MASK = True
    arm = rig.build_armature()
    body.build_body(arm)
    idle = importlib.import_module("idle")
    anim = pose.Animator(arm)
    anim.begin(idle.NAME, idle.FRAMES)
    idle.build(anim)
    anim.finish()
    scene.frame_set(0)
    return arm


def setup_render(scene):
    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = SIZE
    scene.render.resolution_y = SIZE
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = EXPOSURE
    world = bpy.data.worlds.new("W")
    if world.node_tree is None:
        world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.004, 0.003, 0.003, 1)
    scene.world = world


def add_lights(scene):
    def light(kind, loc, energy, color, size, target=(0, 0, 1.5)):
        ld = bpy.data.lights.new("L", kind)
        ld.energy = energy
        ld.color = color
        ld.size = size
        lo = bpy.data.objects.new("L", ld)
        lo.location = loc
        scene.collection.objects.link(lo)
        lo.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()

    # Even, soft key from the front left: graphite metal and black fabric, no glare.
    light("AREA", (-1.0, -1.8, 2.1), 150, (1.0, 0.97, 0.95), 1.6)
    light("AREA", (1.5, -1.2, 1.6), 22, (0.85, 0.87, 0.95), 1.6)  # fill
    # Red rims from behind on both sides: the silhouette reads on a black page.
    light("AREA", (0.8, 1.0, 2.0), 260, (1.0, 0.05, 0.03), 0.9)
    light("AREA", (-0.9, 0.9, 1.8), 170, (1.0, 0.05, 0.03), 0.9)


def add_camera(scene):
    cam_data = bpy.data.cameras.new("C")
    cam_data.lens = LENS
    cam = bpy.data.objects.new("C", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    a, e = math.radians(YAW), math.radians(PITCH)
    cam.location = TARGET + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * DIST
    cam.rotation_euler = (TARGET - cam.location).to_track_quat("-Z", "Y").to_euler()
    return cam


def eye_points(arm):
    """World positions of both eyes at the posed frame (head.add_head's eye centres, carried by the Head bone)."""
    pb = arm.pose.bones["Head"]
    bone_rest = arm.data.bones["Head"].matrix_local
    m = arm.matrix_world @ pb.matrix @ bone_rest.inverted()
    out = []
    for side in (1, -1):
        dd = Vector((0.33 * side, 0.0, 0.1))
        dd.y = -math.sqrt(1 - dd.x * dd.x - dd.z * dd.z)
        centre = head.head_point(dd) + Vector((0, -0.006, 0))
        out.append(m @ centre)
    return out


def main():
    out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv[:-1] else os.path.join(REPO, "public", "office-assets", "avatars")
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    arm = build_character(scene)
    setup_render(scene)
    add_lights(scene)
    cam = add_camera(scene)
    bpy.context.view_layer.update()

    for k, p in enumerate(eye_points(arm)):
        v = world_to_camera_view(scene, cam, p)
        print(f"[loader] eye{k} x={v.x:.4f} y={1 - v.y:.4f}")

    # Rendered to a PNG once, then saved as WebP (alpha kept): full size for
    # the overlays, SMALL for inline spinners. The PNG is not kept.
    png = os.path.join(out, "hacker-loader-render.png")
    scene.render.filepath = png
    bpy.ops.render.render(write_still=True)

    for size, name in ((SIZE, "hacker-loader.webp"), (SMALL, f"hacker-loader-{SMALL}.webp")):
        img = bpy.data.images.load(png, check_existing=False)
        img.scale(size, size)  # also loads the pixels (saving needs them)
        webp = os.path.join(out, name)
        img.filepath_raw = webp
        img.file_format = "WEBP"
        try:
            img.save(quality=90)
        except TypeError:  # older API without the quality argument
            img.save()
        bpy.data.images.remove(img)
        print("[loader]", webp)
    os.remove(png)

main()
