"""Look concept for AM7, the lead agent: the android in a black two-piece suit.

  blender -b --factory-startup -P blender/hacker/tools/lead_concepts.py -- [OUT_DIR] [--shots full,close,office] [--samples N]

Builds the regular skeleton (rig.py) and the lead's skinned mesh from
blender/hacker/lead.py (the production build exports it into hacker.glb):

  * the sculpted android head and robot hands from head.py / body.py,
  * a glossy black military haircut (sides and back short, the top combed over
    to the right from a part on the left), rigid to Head,
  * a tailored jacket (peak satin lapels, collar, two buttons, flap pockets,
    breast pocket), a black turtleneck and creased straight trousers, skinned
    to the spine / arm / leg chain like the hoodie and pants,
  * polished dress shoes, rigid to Foot / ToeBase.

Two variations of the thin red accents are built side by side:
  A "pinline"   red piping on the lapel edge, a red pocket square, a chevron
                lapel pin, red cuff lines and a red line on the shoe welt.
  B "lightning" thin red zigzags on the lapels, cuffs and down the trouser
                side seams, a lightning-bolt lapel pin, the pocket square and
                the welt line.

The character is posed in the Idle clip at frame 0 and rendered in a dark
studio (Eevee, AgX, bloom) into OUT_DIR (default blender/_preview/am7).
Nothing is exported.
"""

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
import lead  # noqa: E402
import pose  # noqa: E402
import rig  # noqa: E402

SIDES = lead.SIDES
extend_atlas = lead.extend_atlas


def build_lead(arm, variant):
    obj = lead.build_lead(arm, body.build_material(), variant)
    obj.name = f"AM7_{variant}"
    return obj


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# --- scene -------------------------------------------------------------------------------
def idle_pose():
    import importlib

    idle = importlib.import_module("idle")
    return idle.pose_at(0, idle._simulate())


def make_character(builder, pose_dict, name, loc=(0, 0, 0), yaw=0.0):
    arm = rig.build_armature(name)
    mesh = builder(arm)
    pose.Animator(arm).apply(pose_dict)
    arm.location = loc
    arm.rotation_euler = (0, 0, math.radians(yaw))
    return arm, mesh


def setup_scene(samples):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = samples
    scene.eevee.use_raytracing = True
    scene.eevee.ray_tracing_method = "SCREEN"
    scene.eevee.use_shadows = True
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.004, 0.004, 0.005, 1)
    scene.world = world

    fm = bpy.data.materials.new("Floor")
    fm.use_nodes = True
    p = fm.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (0.006, 0.006, 0.007, 1)
    p.inputs["Roughness"].default_value = 0.24
    p.inputs["Specular IOR Level"].default_value = 0.35
    bpy.ops.mesh.primitive_plane_add(size=60)
    bpy.context.active_object.data.materials.append(fm)

    def light(loc, energy, color, size, target=(0, 0, 1.2), spread=180):
        ld = bpy.data.lights.new("L", "AREA")
        ld.energy = energy
        ld.color = color
        ld.size = size
        ld.spread = math.radians(spread)
        lo = bpy.data.objects.new("L", ld)
        lo.location = loc
        scene.collection.objects.link(lo)
        lo.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        return lo

    light((-1.9, -2.6, 3.0), 520, (1, 0.97, 0.94), 1.6, (0, 0, 1.25))  # soft white key
    light((2.4, -1.8, 1.7), 150, (0.72, 0.8, 1.0), 2.2)  # cool fill
    rims = [light((1.3, 2.0, 2.5), 800, (1.0, 0.06, 0.03), 1.0, (0, 0, 1.3), 70),  # red rim
            light((-1.5, 1.8, 1.9), 520, (1.0, 0.06, 0.03), 1.0, (0, 0, 1.1), 70)]  # red rim
    scene["am7_rims"] = [r.name for r in rims]
    light((0.0, 0.4, 3.4), 90, (1, 1, 1), 1.4, (0, 0, 1.5))  # soft top light

    ng = bpy.data.node_groups.new("AM7Comp", "CompositorNodeTree")
    rl = ng.nodes.new("CompositorNodeRLayers")
    gl = ng.nodes.new("CompositorNodeGlare")
    gl.inputs["Type"].default_value = "Bloom"
    gl.inputs["Quality"].default_value = "High"
    gl.inputs["Threshold"].default_value = 1.0
    gl.inputs["Strength"].default_value = 0.35
    gl.inputs["Size"].default_value = 0.55
    out = ng.nodes.new("NodeGroupOutput")
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    ng.links.new(rl.outputs["Image"], gl.inputs["Image"])
    ng.links.new(gl.outputs["Image"], out.inputs[0])
    scene.compositing_node_group = ng
    scene.render.use_compositing = True

    cam = bpy.data.objects.new("C", bpy.data.cameras.new("C"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    return scene, cam


def show_only(chars, keep):
    for name, (arm, mesh) in chars.items():
        hide = name not in keep
        arm.hide_render = hide
        mesh.hide_render = hide


def shoot(scene, cam, path, res, target, yaw, pitch, dist, lens, centre=Vector((0, 0, 0))):
    scene.render.resolution_x, scene.render.resolution_y = res
    cam.data.lens = lens
    a, e = math.radians(yaw), math.radians(pitch)
    tgt = centre + Vector(target)
    cam.location = tgt + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
    cam.rotation_euler = (tgt - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def sheet(paths, out):
    import numpy as np

    tiles = []
    for p in paths:
        img = bpy.data.images.load(p, check_existing=False)
        w, h = img.size
        tiles.append(np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4))
        bpy.data.images.remove(img)
        os.remove(p)
    arr = np.concatenate(tiles, axis=1)
    h, w = arr.shape[:2]
    res = bpy.data.images.new("sheet", w, h, alpha=True)
    res.pixels[:] = arr.ravel()
    res.filepath_raw = out
    res.file_format = "PNG"
    res.save()
    print("[am7]", out)


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"out": os.path.normpath(os.path.join(ROOT, "..", "_preview", "am7")), "shots": {"full", "close"},
            "samples": 48}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--shots":
            opts["shots"] = set(argv[i + 1].split(","))
            i += 1
        elif a == "--samples":
            opts["samples"] = int(argv[i + 1])
            i += 1
        else:
            opts["out"] = a
        i += 1
    return opts


def main():
    opts = parse()
    out = opts["out"]
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    extend_atlas()
    scene, cam = setup_scene(opts["samples"])
    idle = idle_pose()
    chars = {}
    for v in ("A", "B"):
        chars[v] = make_character(lambda arm, v=v: build_lead(arm, v), idle, f"AM7Rig_{v}")
        print(f"[am7] variant {v}: {tri_count(chars[v][1])} triangles, {len(chars[v][1].data.vertices)} verts")
    if "office" in opts["shots"]:
        for i, (x, y, yaw) in enumerate(((-1.6, 0.9, 20), (1.7, 1.2, -25), (-2.6, -1.2, 60), (2.6, -0.6, -70))):
            chars[f"R{i}"] = make_character(lambda arm: body.build_body(arm), idle, f"TeamRig_{i}", (x, y, 0), yaw)
        print(f"[am7] regular hoodie android: {tri_count(chars['R0'][1])} triangles")

    # The red rims light the characters only, not the glossy floor.
    coll = bpy.data.collections.new("Characters")
    scene.collection.children.link(coll)
    for arm, mesh in chars.values():
        coll.objects.link(mesh)
    for name in scene["am7_rims"]:
        bpy.data.objects[name].light_linking.receiver_collection = coll

    tmp = os.path.join(out, "_tile_{}.png")
    if "full" in opts["shots"]:
        paths = []
        for v in ("A", "B"):
            show_only(chars, {v})
            for yaw in (32, 90):
                p = tmp.format(len(paths))
                shoot(scene, cam, p, (400, 1000), (0, 0, 0.93), yaw, 5, 4.3, 60)
                paths.append(p)
        sheet(paths, os.path.join(out, "am7_suit_full.png"))
    if "close" in opts["shots"]:
        paths = []
        for v in ("A", "B"):
            show_only(chars, {v})
            p = tmp.format(len(paths))
            shoot(scene, cam, p, (800, 1000), (0, -0.01, 1.5), 28, 6, 1.6, 85)
            paths.append(p)
        sheet(paths, os.path.join(out, "am7_suit_closeup.png"))
    if "hair" in opts["shots"]:
        paths = []
        show_only(chars, {"A"})
        for yaw, pitch in ((0, 8), (90, 8), (150, 12), (-35, 40)):
            p = tmp.format(len(paths))
            shoot(scene, cam, p, (400, 500), (0, 0.0, 1.66), yaw, pitch, 0.9, 85)
            paths.append(p)
        sheet(paths, os.path.join(out, "am7_hair.png"))
    if "debug" in opts["shots"]:
        paths = []
        show_only(chars, {"A"})
        for yaw in (0, 90, 180, 28):
            p = tmp.format(len(paths))
            shoot(scene, cam, p, (400, 500), (0, 0.0, 1.38), yaw, 4, 1.7, 85)
            paths.append(p)
        sheet(paths, os.path.join(out, "am7_debug.png"))
    if "office" in opts["shots"]:
        show_only(chars, {"A", "R0", "R1", "R2", "R3"})
        p = os.path.join(out, "am7_office_view.png")
        shoot(scene, cam, p, (1600, 1000), (0, 0, 0.9), 45, 38, 11.0, 50)
        print("[am7]", p)


if __name__ == "__main__":
    main()
