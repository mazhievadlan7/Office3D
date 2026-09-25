"""Preview renders for blender/hq/workstation.py (Eevee, dark studio, red rim).

Sheets written to the preview directory:
  ws_hero.png     one large 3/4 shot from the sitter's side
  ws_sheet.png    3/4 front | 3/4 back / side (ortho, contract guides) | top (ortho)
  ws_context.png  hacker.glb at the origin | seated character | a pod of four | LOD1
The screens get a UV-driven preview shader (title bar at the top, brightness
rising left to right across the three screens) so the UV contract is visible.
"""

import importlib
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

V = Vector
TILE = (560, 440)
LOD0 = ("ws_desk", "ws_metal", "ws_chair", "ws_screen", "ws_led", "ws_glass")
LOD1 = ("ws_lod1_desk", "ws_lod1_metal", "ws_lod1_chair", "ws_lod1_screen", "ws_lod1_led")


def srgb(hexstr):
    h = hexstr.lstrip("#")
    out = []
    for k in range(3):
        c = int(h[2 * k:2 * k + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, 1.0)


# --- scene ------------------------------------------------------------------------
def setup(scene):
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = TILE
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    ee = scene.eevee
    ee.taa_render_samples = 64
    try:
        ee.use_raytracing = True
    except AttributeError:
        pass

    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.0035, 0.0035, 0.0042, 1)
    scene.world = world

    bpy.ops.mesh.primitive_plane_add(size=30)
    floor = bpy.context.active_object
    floor.name = "preview_floor"
    fm = bpy.data.materials.new("preview_floor")
    fm.use_nodes = True
    p = fm.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = srgb("#0c0c0e")
    p.inputs["Roughness"].default_value = 0.32
    floor.data.materials.append(fm)

    def light(name, loc, energy, color, size, target=(0, -0.5, 0.8)):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy = energy
        ld.color = color
        ld.size = size
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        lo.rotation_euler = (V(target) - V(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(lo)

    light("key", (2.4, 2.0, 3.4), 210, (0.88, 0.92, 1.0), 2.5)
    light("top", (-1.6, 0.9, 3.4), 90, (1.0, 1.0, 1.0), 3.0)
    light("rim_red", (-1.4, -3.2, 2.1), 380, (1.0, 0.05, 0.03), 1.6, (0, -0.6, 1.0))
    light("rim_red2", (-2.6, 1.9, 1.6), 160, (1.0, 0.06, 0.04), 1.2, (0, 0.1, 0.8))

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    enable_bloom(scene)
    return cam


def enable_bloom(scene):
    try:
        tree = bpy.data.node_groups.new("preview_comp", "CompositorNodeTree")
        tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        scene.compositing_node_group = tree
        rl = tree.nodes.new("CompositorNodeRLayers")
        glare = tree.nodes.new("CompositorNodeGlare")
        out = tree.nodes.new("NodeGroupOutput")
        if hasattr(glare, "glare_type"):
            glare.glare_type = "BLOOM"
        elif "Type" in glare.inputs:
            glare.inputs["Type"].default_value = "Bloom"
        for key, val in (("Threshold", 0.9), ("Strength", 0.55), ("Size", 0.45), ("Quality", "High")):
            if key in glare.inputs:
                try:
                    glare.inputs[key].default_value = val
                except (TypeError, ValueError):
                    pass
        tree.links.new(rl.outputs["Image"], glare.inputs["Image"])
        tree.links.new(glare.outputs["Image"], out.inputs[0])
        scene.render.use_compositing = True
    except Exception as e:  # compositor API differs between versions; bloom is cosmetic
        print("[preview] bloom disabled:", e)


def screen_preview_material():
    """Red terminal look driven by the exported UVs (Blender v is flipped: 0 = top)."""
    m = bpy.data.materials.new("preview_screen")
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = srgb("#070203")
    p.inputs["Roughness"].default_value = 0.1
    p.inputs["Emission Color"].default_value = srgb("#ff3b30")
    uvn = nt.nodes.new("ShaderNodeUVMap")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(uvn.outputs["UV"], sep.inputs[0])
    u, vb = sep.outputs[0], sep.outputs[1]

    def op(kind, a, b=None):
        n = nt.nodes.new("ShaderNodeMath")
        n.operation = kind
        for idx, x in enumerate((a, b)):
            if x is None:
                continue
            if isinstance(x, (int, float)):
                n.inputs[idx].default_value = x
            else:
                nt.links.new(x, n.inputs[idx])
        return n.outputs[0]

    title = op("LESS_THAN", vb, 0.075)
    rows = op("MULTIPLY", vb, 26.0)
    row = op("FLOOR", rows)
    line = op("LESS_THAN", op("FRACT", rows), 0.45)
    rnd = op("FRACT", op("MULTIPLY", op("SINE", op("MULTIPLY", row, 12.9898)), 43758.5))
    ul = op("FRACT", op("MULTIPLY", u, 3.0))
    length = op("ADD", op("MULTIPLY", rnd, 0.7), 0.12)
    text = op("MULTIPLY", op("MULTIPLY", line, op("LESS_THAN", ul, length)), op("GREATER_THAN", ul, 0.05))
    body = op("MULTIPLY", text, op("SUBTRACT", 1.0, title))
    level = op("ADD", op("ADD", 0.12, op("MULTIPLY", title, 3.0)), op("MULTIPLY", body, 1.3))
    ramp = op("ADD", 0.45, op("MULTIPLY", u, 1.1))  # dim at the sitter's left, bright at the right
    nt.links.new(op("MULTIPLY", level, ramp), p.inputs["Emission Strength"])
    return m


def add_guides(scene):
    """Contract heights for the ortho side view, drawn behind the model."""
    mat = bpy.data.materials.new("preview_guide")
    mat.use_nodes = True
    p = mat.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (0, 0, 0, 1)
    p.inputs["Emission Color"].default_value = (0.2, 0.75, 1.0, 1)
    p.inputs["Emission Strength"].default_value = 1.5
    objs = []

    def bar(y0, y1, z0, z1):
        bpy.ops.mesh.primitive_cube_add(size=1)
        ob = bpy.context.active_object
        ob.scale = (0.002, y1 - y0, z1 - z0)
        ob.location = (-1.0, (y0 + y1) / 2, (z0 + z1) / 2)
        ob.data.materials.append(mat)
        objs.append(ob)

    def label(text, y, z):
        cu = bpy.data.curves.new("lbl", "FONT")
        cu.body = text
        cu.size = 0.045
        ob = bpy.data.objects.new("lbl", cu)
        scene.collection.objects.link(ob)
        ob.matrix_world = Matrix(((0, 0, 1, -0.99), (1, 0, 0, y), (0, 1, 0, z), (0, 0, 0, 1)))
        cu.materials.append(mat)
        objs.append(ob)

    for z, text in ((0.47, "seat 0.47"), (0.75, "desk 0.75"), (1.08, "monitor 1.08"), (1.10, "")):
        if text:
            bar(-1.45, 0.75, z - 0.0015, z + 0.0015)
            label(text, 0.42, z + 0.012)
    for y, text in ((0.24, "back 0.24"), (0.02, "seat 0.02"), (-0.36, "0.36"), (-0.95, "0.95"), (-1.10, "1.10")):
        bar(y - 0.0015, y + 0.0015, 0.0, 1.45)
        label(text, y + 0.01, 1.40 if y > -0.5 else 1.30)
    return objs


# --- characters -------------------------------------------------------------------
def import_character(path):
    if not os.path.exists(path):
        print("[preview] no character at", path)
        return [], None
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next((o for o in new if o.type == "ARMATURE"), None)
    return new, arm


def pick_action(arm, names):
    for name in names:
        act = bpy.data.actions.get(name)
        if act is None:
            continue
        if arm.animation_data is None:
            arm.animation_data_create()
        arm.animation_data.action = act
        try:
            if getattr(act, "slots", None) and len(act.slots):
                arm.animation_data.action_slot = act.slots[0]
        except (AttributeError, TypeError):
            pass
        return act
    return None


def build_seated_from_scripts(root):
    """Fallback when hacker.glb has no seated clip yet: rebuild the character
    from blender/hacker and pose it with its seated clip."""
    hdir = os.path.join(root, "blender", "hacker")
    for p in (hdir, os.path.join(hdir, "anims")):
        if p not in sys.path:
            sys.path.insert(0, p)
    before = set(bpy.data.objects)
    rig = importlib.import_module("rig")
    body = importlib.import_module("body")
    pose = importlib.import_module("pose")
    arm = rig.build_armature()
    body.build_body(arm)
    act = None
    for modname in ("sit_type", "sit_idle"):
        if not os.path.exists(os.path.join(hdir, "anims", modname + ".py")):
            continue
        mod = importlib.import_module(modname)
        animator = pose.Animator(arm)
        act = animator.begin(mod.NAME, mod.FRAMES, cyclic=getattr(mod, "CYCLIC", True))
        mod.build(animator)
        animator.finish()
        break
    new = [o for o in bpy.data.objects if o not in before]
    if act is not None:
        arm.animation_data.action = act
    return new, act


# --- rendering --------------------------------------------------------------------
def aim(cam, loc, target, lens=40.0, ortho=None, roll_z=None):
    cam.location = V(loc)
    if roll_z is not None:
        cam.rotation_euler = (0.0, 0.0, roll_z)
    else:
        cam.rotation_euler = (V(target) - V(loc)).to_track_quat("-Z", "Y").to_euler()
    if ortho:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = ortho
    else:
        cam.data.type = "PERSP"
        cam.data.lens = lens
    cam.data.clip_end = 100


def render_px(scene, tmp):
    scene.render.filepath = tmp
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(tmp, check_existing=False)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    return px


def save_png(px, path):
    h, w = px.shape[:2]
    out = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    out.pixels[:] = px.ravel()
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)
    print(f"[preview] {path}")


def sheet(tiles):
    """2x2 grid from [top-left, top-right, bottom-left, bottom-right]
    (numpy rows run bottom-up, like Blender pixels)."""
    top = np.concatenate(tiles[0:2], axis=1)
    bottom = np.concatenate(tiles[2:4], axis=1)
    return np.concatenate([bottom, top], axis=0)


def render_all(scene, final, mats, out_dir, root, hero_only=False):
    out_dir = os.path.abspath(out_dir)  # Blender resolves relative render paths against the .blend
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, "_tile.png")
    cam = setup(scene)
    for name in ("ws_screen", "ws_lod1_screen"):
        final[name].data.materials[0] = screen_preview_material()

    lod0 = [final[n] for n in LOD0]
    lod1 = [final[n] for n in LOD1]
    groups = {"lod0": lod0, "lod1": lod1}

    def show(*keys):
        for key, objs in groups.items():
            for o in objs:
                o.hide_render = key not in keys

    show("lod0")
    scene.render.resolution_x, scene.render.resolution_y = 1280, 800
    aim(cam, (1.75, 1.35, 1.62), (0.0, -0.62, 0.86), lens=42)
    save_png(render_px(scene, tmp), os.path.join(out_dir, "ws_hero.png"))
    scene.render.resolution_x, scene.render.resolution_y = TILE
    if hero_only:
        os.remove(tmp)
        return

    # The hero keeps the LEDs lighting the room for mood; the review shots do not,
    # like three.js, where emissive surfaces only reach the image through bloom.
    for name in ("ws_led", "ws_screen", "ws_lod1_led", "ws_lod1_screen"):
        final[name].visible_diffuse = False
    try:
        scene.eevee.fast_gi_method = "AMBIENT_OCCLUSION_ONLY"
    except (AttributeError, TypeError):
        pass

    groups["guides"] = add_guides(scene)
    show("lod0")
    tiles = []
    aim(cam, (2.1, 1.75, 2.0), (0.0, -0.45, 0.8), lens=36)
    tiles.append(render_px(scene, tmp))
    aim(cam, (-2.0, -3.3, 1.9), (0.0, -0.55, 0.85), lens=38)
    tiles.append(render_px(scene, tmp))
    show("lod0", "guides")
    cam.location = V((4.0, -0.35, 0.72))
    cam.rotation_euler = (math.pi / 2, 0.0, math.pi / 2)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 2.3
    tiles.append(render_px(scene, tmp))
    show("lod0")
    aim(cam, (0.0, -0.40, 6.0), None, ortho=2.2, roll_z=math.pi)
    tiles.append(render_px(scene, tmp))
    save_png(sheet(tiles), os.path.join(out_dir, "ws_sheet.png"))

    # Context: character scale, seated check, pod of four, LOD1.
    tiles = []
    char_path = os.path.join(root, "public", "office-assets", "models", "characters", "hacker.glb")
    glb_objs, arm = import_character(char_path)
    groups["glb"] = glb_objs
    seated_act = pick_action(arm, ("SitType", "SitIdle")) if arm else None
    if arm and seated_act is None:
        pick_action(arm, ("Idle",))
    scene.frame_set(12)
    show("lod0", "glb")
    aim(cam, (2.7, 0.7, 1.3), (0.0, -0.3, 0.8), lens=36)
    tiles.append(render_px(scene, tmp))

    if seated_act is None:
        try:
            groups["seated"], act = build_seated_from_scripts(root)
            scene.frame_set(int(act.frame_range[0]) + 20 if act else 0)
            show("lod0", "seated")
        except Exception as e:
            print("[preview] seated check skipped:", e)
            show("lod0")
    else:
        show("lod0", "glb")
    cam.location = V((3.2, -0.25, 0.85))
    cam.rotation_euler = (math.pi / 2, 0.0, math.pi / 2)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 2.3
    tiles.append(render_px(scene, tmp))

    pod = []
    # Two pods (POD in config.ts: 1.6 m pitch, 2.2 m between facing rows, 2.6 m aisle).
    slots = [(0.0, 0.0, 0.0), (1.6, 0.0, 0.0), (0.0, -2.2, math.pi), (1.6, -2.2, math.pi)]
    slots += [(x + 5.8, y, r) for x, y, r in slots]
    for tx, ty, rz in slots[1:]:
        m = Matrix.Translation((tx, ty, 0.0)) @ Matrix.Rotation(rz, 4, "Z")
        for o in lod0:
            d = o.copy()
            d.matrix_world = m
            scene.collection.objects.link(d)
            pod.append(d)
    fill = bpy.data.objects.new("pod_fill", bpy.data.lights.new("pod_fill", "AREA"))
    fill.data.energy, fill.data.size = 1400, 9.0
    fill.location = (3.7, -1.1, 6.0)
    scene.collection.objects.link(fill)
    groups["pod"] = pod + [fill]
    show("lod0", "pod")
    # Roughly the app camera: from three.js (+x, +z) = Blender (+x, -y), high.
    aim(cam, (12.0, -11.0, 9.0), (3.7, -1.1, 0.5), lens=34)
    tiles.append(render_px(scene, tmp))
    scene.render.resolution_x, scene.render.resolution_y = 1280, 800
    aim(cam, (10.2, -8.8, 5.8), (3.6, -1.2, 0.6), lens=30)
    save_png(render_px(scene, tmp), os.path.join(out_dir, "ws_pods.png"))
    scene.render.resolution_x, scene.render.resolution_y = TILE

    show("lod1")
    aim(cam, (2.1, 1.75, 2.0), (0.0, -0.45, 0.8), lens=36)
    tiles.append(render_px(scene, tmp))
    save_png(sheet(tiles), os.path.join(out_dir, "ws_context.png"))
    os.remove(tmp)
