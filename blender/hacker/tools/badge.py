"""The agent's chat badge: a square portrait of the HQ android hacker.

  blender -b --factory-startup -P blender/hacker/tools/badge.py -- [OUT_DIR]

Builds the same character as build.py (head, hood, fabric mask, techwear),
poses it at Idle frame 0 and renders the head and shoulders from a 3/4 front
view on a near-black background with a soft red rim. Writes:

  OUT_DIR/hacker-badge.png       512 x 512
  OUT_DIR/hacker-badge-128.webp  128 x 128 (what the chat and lists load)

OUT_DIR defaults to public/office-assets/avatars. Every agent shares this one
image; the app varies the accent ring and puts the callsign's initials over it
(src/lib/avatars/badge.ts), so no per-agent render is needed.
"""

import importlib
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "anims"))

import body  # noqa: E402
import outfit  # noqa: E402
import pose  # noqa: E402
import rig  # noqa: E402

SIZE = 512
SMALL = 128
# Where the camera looks: between the eyes and the mask, slightly below eye level
# so the hood's crown and the collar both fit.
TARGET = Vector((0.0, -0.1, 1.615))
YAW, PITCH, DIST, LENS = 30.0, 5.0, 1.02, 85
# The halo card: how far behind the head, how wide, how bright at its centre.
HALO_DEPTH, HALO_RADIUS, HALO_STRENGTH = 1.4, 0.8, 0.035
EXPOSURE = 0.9


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


def setup_render(scene):
    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = SIZE
    scene.render.resolution_y = SIZE
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.view_transform = "AgX"
    # The badge is shown at 22-64 px on a near-black panel: lift the whole
    # frame so the graphite face, the hood's edge and the mask still read.
    scene.view_settings.exposure = EXPOSURE
    world = bpy.data.worlds.new("W")
    if world.node_tree is None:
        world.use_nodes = True
    # Near black with a trace of red: the HQ's matte black, not the old blue.
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.004, 0.003, 0.003, 1)
    scene.world = world


def add_backdrop(scene, cam):
    """A faint red halo behind the head, fading to black at the corners.

    An emission-only card square to the camera, so nothing reflects off it and
    the halo is the same on every render.
    """
    view = (TARGET - cam.location).normalized()
    centre = TARGET + view * HALO_DEPTH
    bpy.ops.mesh.primitive_plane_add(size=6, location=centre)
    plane = bpy.context.active_object
    plane.rotation_euler = (-view).to_track_quat("Z", "Y").to_euler()
    plane.visible_shadow = False
    mat = bpy.data.materials.new("Backdrop")
    nt = mat.node_tree if mat.node_tree else None
    if nt is None:
        mat.use_nodes = True
        nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    length = nt.nodes.new("ShaderNodeVectorMath")
    length.operation = "LENGTH"
    ramp = nt.nodes.new("ShaderNodeMapRange")
    ramp.inputs["From Min"].default_value = 0.0
    ramp.inputs["From Max"].default_value = HALO_RADIUS
    ramp.inputs["To Min"].default_value = HALO_STRENGTH
    ramp.inputs["To Max"].default_value = 0.0
    ramp.interpolation_type = "SMOOTHERSTEP"
    emit.inputs["Color"].default_value = (1.0, 0.045, 0.03, 1)
    nt.links.new(coord.outputs["Object"], length.inputs[0])
    nt.links.new(length.outputs["Value"], ramp.inputs["Value"])
    nt.links.new(ramp.outputs["Result"], emit.inputs["Strength"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    plane.data.materials.append(mat)


def add_lights(scene):
    def light(kind, loc, energy, color, size, target=(0, 0, 1.6)):
        ld = bpy.data.lights.new("L", kind)
        ld.energy = energy
        ld.color = color
        ld.size = size
        lo = bpy.data.objects.new("L", ld)
        lo.location = loc
        scene.collection.objects.link(lo)
        lo.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()

    # Even, soft key: the face reads as graphite metal, no glare.
    light("AREA", (-0.9, -1.5, 2.0), 80, (1.0, 0.97, 0.95), 1.2)
    light("AREA", (1.3, -0.9, 1.6), 10, (0.85, 0.87, 0.95), 1.2)  # fill
    # Subtle red rims from behind on both sides.
    light("AREA", (0.7, 0.9, 1.9), 120, (1.0, 0.05, 0.03), 0.7)
    light("AREA", (-0.8, 0.8, 1.7), 70, (1.0, 0.05, 0.03), 0.7)


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


def main():
    out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv[:-1] else os.path.join(REPO, "public", "office-assets", "avatars")
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    build_character(scene)
    setup_render(scene)
    add_lights(scene)
    cam = add_camera(scene)
    add_backdrop(scene, cam)

    png = os.path.join(out, "hacker-badge.png")
    scene.render.filepath = png
    bpy.ops.render.render(write_still=True)
    print("[badge]", png)

    img = bpy.data.images.load(png, check_existing=False)
    img.scale(SMALL, SMALL)
    webp = os.path.join(out, "hacker-badge-128.webp")
    img.filepath_raw = webp
    img.file_format = "WEBP"
    try:
        img.save(quality=90)
    except TypeError:  # older API without the quality argument
        img.save()
    bpy.data.images.remove(img)
    print("[badge]", webp)


main()
