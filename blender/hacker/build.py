"""Build the hacker character, author its animations and export a GLB.

Run headless:
  blender -b --factory-startup -P blender/hacker/build.py -- [options]

Options:
  --out PATH            GLB to write (default public/office-assets/models/characters/hacker.glb)
  --preview DIR         also render preview sheets into DIR
  --clips a,b,c         only build these clips (default: all in anims/)
  --sheet CLIP:f1,f2..  frames of CLIP to render in the preview sheet (repeatable)
  --no-export           skip the GLB export
  --props               add the reference workstation (chair, desk, keyboard,
                        mouse, monitors) to the preview scene
  --report CLIP         print per-frame world positions of feet, hands and head

Workstation contract (character root = chair centre on the floor, facing -Y):
  seat top z=0.47 (seat centre y=+0.02), backrest from y=+0.24
  desk top z=0.75, front edge y=-0.36; keyboard centre (0,-0.50,0.765)
  mouse (-0.30,-0.50,0.765) i.e. on the character's right; monitors at y=-0.95
"""

import importlib
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

import body  # noqa: E402
import pose  # noqa: E402
import rig  # noqa: E402

CLIP_ORDER = ["idle", "walk", "sit_type", "sit_idle", "talk", "stand_type"]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    opts = {"out": os.path.join(ROOT, "public", "office-assets", "models", "characters", "hacker.glb"),
            "preview": None, "clips": None, "sheet": [], "export": True}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out":
            opts["out"] = argv[i + 1]; i += 1
        elif a == "--preview":
            opts["preview"] = argv[i + 1]; i += 1
        elif a == "--clips":
            opts["clips"] = argv[i + 1].split(","); i += 1
        elif a == "--sheet":
            clip, frames = argv[i + 1].split(":")
            opts["sheet"].append((clip, [int(f) for f in frames.split(",")])); i += 1
        elif a == "--no-export":
            opts["export"] = False
        elif a == "--props":
            opts["props"] = True
        elif a == "--report":
            opts["report"] = argv[i + 1]; i += 1
        i += 1
    return opts


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 30
    return scene


def available_clips():
    names = []
    adir = os.path.join(HERE, "anims")
    for fn in sorted(os.listdir(adir)):
        if fn.endswith(".py") and not fn.startswith("_"):
            names.append(fn[:-3])
    ordered = [n for n in CLIP_ORDER if n in names] + [n for n in names if n not in CLIP_ORDER]
    return ordered


def build_clips(arm, only=None):
    sys.path.insert(0, os.path.join(HERE, "anims"))
    animator = pose.Animator(arm)
    built = []
    for name in available_clips():
        if only and name not in only:
            continue
        mod = importlib.import_module(name)
        importlib.reload(mod)
        act = animator.begin(mod.NAME, mod.FRAMES, cyclic=getattr(mod, "CYCLIC", True))
        mod.build(animator)
        animator.finish()
        built.append(act)
        print(f"[clip] {mod.NAME}: {mod.FRAMES} frames")
    # Leave the armature in rest pose with no active action, so the export
    # does not bake one clip into the rest pose.
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    return built


def export_glb(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_skins=True,
        export_all_influences=False,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_frame_step=1,
        export_optimize_animation_size=True,
        export_anim_single_armature=True,
        export_reset_pose_bones=True,
        export_def_bones=False,
    )
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError as e:  # option renamed in this Blender version
        print("[export] retry without unknown option:", e)
        for k in ("export_optimize_animation_size", "export_anim_single_armature", "export_reset_pose_bones", "export_def_bones"):
            kwargs.pop(k, None)
        bpy.ops.export_scene.gltf(**kwargs)
    print(f"[export] {path} {os.path.getsize(path) / 1024:.1f} KiB")


# --- preview ------------------------------------------------------------------
def setup_preview_scene(scene):
    import math

    from mathutils import Vector

    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 360
    scene.render.resolution_y = 520
    scene.render.film_transparent = False
    try:
        scene.view_settings.view_transform = "AgX"
    except TypeError:
        pass
    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.03, 0.03, 0.035, 1)
    bg.inputs[1].default_value = 1.0
    scene.world = world

    # floor
    bpy.ops.mesh.primitive_plane_add(size=6)
    floor = bpy.context.active_object
    fm = bpy.data.materials.new("Floor")
    fm.use_nodes = True
    p = fm.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (0.05, 0.05, 0.055, 1)
    p.inputs["Roughness"].default_value = 0.3
    floor.data.materials.append(fm)

    def light(kind, loc, energy, color, size=1.0):
        ld = bpy.data.lights.new(kind + str(loc), kind)
        ld.energy = energy
        ld.color = color
        if hasattr(ld, "size"):
            ld.size = size
        lo = bpy.data.objects.new(ld.name, ld)
        lo.location = loc
        scene.collection.objects.link(lo)
        direction = Vector((0, 0, 1.2)) - Vector(loc)
        lo.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        return lo

    light("AREA", (-2.0, -2.5, 3.0), 450, (1, 0.96, 0.92), 2.0)  # key
    light("AREA", (2.5, -1.5, 1.5), 120, (0.7, 0.75, 0.85), 2.0)  # fill
    light("AREA", (0.5, 3.0, 2.5), 700, (1.0, 0.08, 0.05), 1.0)  # red rim

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 60
    cam = bpy.data.objects.new("Cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def aim_camera(cam, angle_deg, dist=4.6, height=1.25, target_z=0.95):
    import math

    from mathutils import Vector

    a = math.radians(angle_deg)
    # angle 0 = in front of the character (character faces -Y)
    cam.location = Vector((math.sin(a) * dist, -math.cos(a) * dist, height))
    d = Vector((0, 0, target_z)) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def render_sheet(scene, cam, arm, out_path, shots):
    """shots: list of (action_name or None, frame, camera_angle). One row."""
    import numpy as np

    tiles = []
    tmp = os.path.join(os.path.dirname(out_path), "_tile.png")
    for act_name, frame, ang in shots:
        arm.animation_data.action = bpy.data.actions[act_name] if act_name else None
        if act_name is None:
            for pb in arm.pose.bones:
                pb.rotation_quaternion = (1, 0, 0, 0)
                pb.location = (0, 0, 0)
        scene.frame_set(frame)
        aim_camera(cam, ang)
        scene.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(tmp, check_existing=False)
        w, h = img.size
        px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
        tiles.append(px)
        bpy.data.images.remove(img)
    sheet = np.concatenate(tiles, axis=1)
    h, w = sheet.shape[:2]
    out = bpy.data.images.new("sheet", w, h, alpha=True)
    out.pixels[:] = sheet.ravel()
    out.filepath_raw = out_path
    out.file_format = "PNG"
    out.save()
    os.remove(tmp)
    print(f"[preview] {out_path}")


def add_props(scene):
    def box(name, center, size, color, rough=0.5):
        bpy.ops.mesh.primitive_cube_add(size=1, location=center)
        o = bpy.context.active_object
        o.name = name
        o.scale = size
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        p = m.node_tree.nodes.get("Principled BSDF")
        p.inputs["Base Color"].default_value = (*color, 1)
        p.inputs["Roughness"].default_value = rough
        o.data.materials.append(m)
        return o

    grey = (0.12, 0.12, 0.13)
    box("seat", (0, 0.02, 0.44), (0.48, 0.46, 0.06), grey)
    box("backrest", (0, 0.27, 0.78), (0.44, 0.05, 0.56), grey)
    box("chair_post", (0, 0.02, 0.21), (0.05, 0.05, 0.42), grey)
    box("desk", (0, -0.73, 0.73), (1.6, 0.74, 0.04), (0.08, 0.08, 0.09), 0.3)
    box("keyboard", (0, -0.5, 0.76), (0.44, 0.14, 0.02), (0.2, 0.2, 0.22))
    box("mouse", (-0.3, -0.5, 0.765), (0.06, 0.1, 0.03), (0.2, 0.2, 0.22))
    for x, rz in ((0, 0), (-0.58, -0.45), (0.58, 0.45)):
        m = box(f"monitor{x}", (x, -0.95, 1.08), (0.56, 0.03, 0.34), (0.3, 0.02, 0.02), 0.2)
        m.rotation_euler[2] = rz


def report(scene, arm, clip):
    arm.animation_data.action = bpy.data.actions[clip]
    act = arm.animation_data.action
    names = ["LeftFoot", "RightFoot", "LeftToeBase", "RightToeBase", "LeftHand", "RightHand", "Head", "Hips"]
    print(f"[report] {clip} frames {int(act.frame_start)}..{int(act.frame_end)}  (head positions, metres; y<0 is forward)")
    for f in range(int(act.frame_start), int(act.frame_end) + 1):
        scene.frame_set(f)
        row = []
        for n in names:
            p = arm.matrix_world @ arm.pose.bones[n].head
            row.append(f"{n}=({p.x:+.3f},{p.y:+.3f},{p.z:+.3f})")
        print(f"[report] f{f:03d} " + " ".join(row))


def main():
    opts = parse_args()
    scene = reset_scene()
    arm = rig.build_armature()
    body.build_body(arm)
    build_clips(arm, opts["clips"])
    if opts.get("report"):
        report(scene, arm, opts["report"])
        arm.animation_data.action = None
    if opts["export"]:
        export_glb(opts["out"])
    if opts["preview"]:
        os.makedirs(opts["preview"], exist_ok=True)
        cam = setup_preview_scene(scene)
        if opts.get("props"):
            add_props(scene)
        if arm.animation_data is None:
            arm.animation_data_create()
        render_sheet(scene, cam, arm, os.path.join(opts["preview"], "rest.png"),
                     [(None, 0, 0), (None, 0, 90), (None, 0, 180), (None, 0, 35)])
        # With props the monitors hide the front, so the second view is from behind.
        second = 145 if opts.get("props") else 35
        for clip, frames in opts["sheet"]:
            shots = [(clip, f, 90) for f in frames]
            render_sheet(scene, cam, arm, os.path.join(opts["preview"], f"{clip}_side.png"), shots)
            shots = [(clip, f, second) for f in frames]
            render_sheet(scene, cam, arm, os.path.join(opts["preview"], f"{clip}_34.png"), shots)


main()
