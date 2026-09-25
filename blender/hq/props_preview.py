"""Preview renders for the HQ props: one tile per prop (dark studio, soft key,
red rim, glossy dark floor, bloom) assembled into a sheet, plus a showroom
shot with everything placed together from the in-app camera direction.
Preview-only changes (a UV test pattern on "screen") happen after export.
"""

import math
import os

import bpy
from mathutils import Vector


def setup_scene(scene):
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.film_transparent = False
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    ee = scene.eevee
    ee.taa_render_samples = 48
    try:
        ee.use_raytracing = True
        ee.ray_tracing_options.resolution_scale = "1"
    except (AttributeError, TypeError):
        pass
    world = bpy.data.worlds.new("Studio")
    scene.world = world
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.004, 0.004, 0.005, 1)
    bg.inputs[1].default_value = 1.0

    bpy.ops.mesh.primitive_plane_add(size=60)
    floor = bpy.context.active_object
    floor.name = "_floor"
    fm = bpy.data.materials.new("_floor")
    p = fm.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (0.012, 0.012, 0.013, 1)
    p.inputs["Roughness"].default_value = 0.26
    floor.data.materials.append(fm)

    lights = {}
    for name, color in (("key", (1.0, 0.95, 0.9)), ("fill", (0.75, 0.8, 0.9)),
                        ("rim", (1.0, 0.07, 0.04)), ("rim2", (1.0, 0.1, 0.06))):
        ld = bpy.data.lights.new("_" + name, "AREA")
        ld.color = color
        lo = bpy.data.objects.new("_" + name, ld)
        scene.collection.objects.link(lo)
        lights[name] = lo
    cam_data = bpy.data.cameras.new("_cam")
    cam = bpy.data.objects.new("_cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    _setup_bloom(scene)
    _screen_test_pattern()
    return cam, lights


def _setup_bloom(scene):
    try:
        ng = bpy.data.node_groups.new("_bloom", "CompositorNodeTree")
        ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        rl = ng.nodes.new("CompositorNodeRLayers")
        gl = ng.nodes.new("CompositorNodeGlare")
        out = ng.nodes.new("NodeGroupOutput")
        for key, val in (("Type", "Bloom"), ("Quality", "High"), ("Threshold", 0.9), ("Strength", 0.5),
                         ("Size", 0.6), ("Smoothness", 0.4)):
            try:
                gl.inputs[key].default_value = val
            except (KeyError, TypeError, ValueError) as e:
                print("[preview] glare", key, e)
        ng.links.new(rl.outputs["Image"], gl.inputs["Image"])
        ng.links.new(gl.outputs["Image"], out.inputs[0])
        scene.compositing_node_group = ng
        scene.render.use_compositing = True
    except Exception as e:  # compositor API differs between versions
        print("[preview] no bloom:", e)


def _screen_test_pattern():
    """UV orientation check: grid, bright block at the top-left, gradient bar
    along the bottom. Upright and unmirrored when UVs follow the contract."""
    import numpy as np

    w, h = 320, 180
    img = bpy.data.images.new("_screen_test", w, h)
    px = np.zeros((h, w, 4), dtype=np.float32)
    px[..., 0] = 0.03
    px[..., 3] = 1.0
    px[::20, :, 0] = 0.25
    px[:, ::20, 0] = 0.25
    px[int(h * 0.78):, : int(w * 0.18), :3] = (1.0, 0.1, 0.05)  # row 0 is the bottom (v = 0)
    ramp = np.linspace(0.0, 1.0, w, dtype=np.float32)
    px[: int(h * 0.1), :, 0] = ramp
    px[: int(h * 0.1), :, 1] = ramp * 0.3
    img.pixels[:] = px.ravel()
    m = bpy.data.materials.get("screen")
    if m is None:
        return
    nt = m.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    p = nt.nodes.get("Principled BSDF")
    nt.links.new(tex.outputs["Color"], p.inputs["Emission Color"])
    p.inputs["Emission Strength"].default_value = 1.6


def _bounds(root):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for ob in root.children:
        for c in ob.bound_box:
            w = ob.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


def _aim(ob, target):
    ob.rotation_euler = (Vector(target) - ob.location).to_track_quat("-Z", "Y").to_euler()


def _place_lights(lights, c, R):
    d = max(R, 0.5)
    spec = {
        "key": (Vector((-1.3, -1.7, 2.4)), 16.0, 2.0),
        "fill": (Vector((2.2, -1.0, 0.8)), 2.5, 2.0),
        "rim": (Vector((1.4, 2.4, 2.4)), 26.0, 0.8),
        "rim2": (Vector((-2.3, 1.6, 2.6)), 12.0, 0.8),
    }
    for name, (off, k, size) in spec.items():
        lo = lights[name]
        lo.location = c + off * d
        lo.data.size = size * d
        lo.data.energy = k * (off * d).length_squared
        _aim(lo, c)


def _frame_camera(cam, lo, hi, az=38.0, el=26.0, lens=60.0, fill=0.92):
    c = (lo + hi) / 2
    R = (hi - lo).length / 2
    cam.data.lens = lens
    fov = 2 * math.atan(18.0 / lens)
    dist = R / math.sin(fov / 2) * fill
    a, e = math.radians(az), math.radians(el)
    cam.location = c + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
    _aim(cam, c)
    cam.data.clip_start = 0.01
    cam.data.clip_end = 200
    return c, R


def _render_to_pixels(scene, path):
    import numpy as np

    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    os.remove(path)
    return px


def _save(px, path):
    h, w = px.shape[:2]
    out = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    out.pixels[:] = px.ravel()
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)
    print(f"[preview] {path}")


def _show_only(roots, keep):
    for r in roots:
        vis = r in keep
        for ob in r.children:
            ob.hide_render = not vis


# Extra camera angles (azimuth, elevation) per kind; 180 looks from +Y (behind).
EXTRA_VIEWS = {"exec_desk": [(200.0, 24.0)], "server_rack": [(12.0, 8.0)]}


def render_sheet(scene, cam, lights, roots, out_dir, size=460, cols=5, only=None, views=EXTRA_VIEWS):
    if only and len(only) <= 4:
        size, cols = 760, len(only)
    import numpy as np

    scene.render.resolution_x = size
    scene.render.resolution_y = size
    tiles = []
    tmp = os.path.join(out_dir, "_tile.png")
    for r in roots:
        if only and r.name not in only:
            continue
        for az, el in [(38.0, 26.0)] + (views or {}).get(r.name, []):
            _show_only(roots, [r])
            lo, hi = _bounds(r)
            c, R = _frame_camera(cam, lo, hi, az=az, el=el)
            _place_lights(lights, c, R)
            tiles.append(_render_to_pixels(scene, tmp))
    _show_only(roots, roots)
    while len(tiles) % cols:
        tiles.append(np.zeros_like(tiles[0]))
    rows = [np.concatenate(tiles[i : i + cols], axis=1) for i in range(0, len(tiles), cols)]
    sheet = np.concatenate(list(reversed(rows)), axis=0)  # image row 0 is the bottom
    name = "sheet.png" if not only else "sheet_" + "_".join(only)[:60] + ".png"
    _save(sheet, os.path.join(out_dir, name))


# Showroom layout: (kind, x, y, rot_z). Front of every prop faces -Y.
SHOWROOM = [
    ("server_rack", -4.2, 2.6, 0.0), ("server_rack", -3.55, 2.6, 0.0), ("server_rack", -2.9, 2.6, 0.0),
    ("exec_shelf", -0.6, 3.0, 0.0), ("wall_screen", 2.9, 3.2, 0.0),
    ("exec_desk", -0.6, 1.3, math.pi), ("exec_chair", -0.6, 1.3, math.pi),
    ("planter_tall", 0.9, 2.9, 0.0), ("floor_lamp", -2.0, 0.2, 0.0),
    ("meeting_table", 3.3, 1.2, 0.0),
    ("meeting_chair", 2.3, 0.3, math.pi), ("meeting_chair", 3.3, 0.3, math.pi),
    ("meeting_chair", 4.3, 0.3, math.pi),
    ("meeting_chair", 2.3, 2.1, 0.0), ("meeting_chair", 3.3, 2.1, 0.0), ("meeting_chair", 4.3, 2.1, 0.0),
    ("sofa", -3.4, -0.2, 0.0), ("lounge_chair", -1.6, -1.3, -math.pi / 2 + 0.25),
    ("coffee_table", -3.4, -1.3, 0.0), ("planter_low", -3.4, 0.75, 0.0),
    ("coffee_bar", 0.5, -1.2, 0.0), ("planter_tall", 2.2, -1.2, 0.0),
]


def render_showroom(scene, cam, lights, roots, out_dir, w=1600, h=1000):
    by_name = {r.name: r for r in roots}
    placed = []
    for kind, x, y, rz in SHOWROOM:
        src = by_name[kind]
        if src not in placed:
            obj = src
        else:
            obj = src.copy()
            scene.collection.objects.link(obj)
            for ch in src.children:
                cc = ch.copy()
                scene.collection.objects.link(cc)
                cc.parent = obj
        obj.location = (x, y, 0.0)
        obj.rotation_euler = (0, 0, rz)
        placed.append(obj)
    bpy.context.view_layer.update()
    # wall behind the back row so the rims read like the real room
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0.0, 3.25, 1.6), rotation=(math.pi / 2, 0, 0))
    wall = bpy.context.active_object
    wall.scale = (14, 3.2, 1)
    wm = bpy.data.materials.new("_wall")
    wm.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.006, 0.006, 0.007, 1)
    wall.data.materials.append(wm)
    for r in roots:
        for ob in r.children:
            ob.hide_render = False
    scene.render.resolution_x = w
    scene.render.resolution_y = h
    scene.eevee.taa_render_samples = 64
    c = Vector((-0.2, 0.9, 0.5))
    cam.data.lens = 32
    a, e, dist = math.radians(36), math.radians(34), 11.5
    cam.location = c + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
    _aim(cam, c)
    _place_lights(lights, c, 3.2)
    lights["key"].data.energy *= 0.8
    px = _render_to_pixels(scene, os.path.join(out_dir, "_tile.png"))
    _save(px, os.path.join(out_dir, "showroom.png"))
