"""Build the HQ prop library and export public/office-assets/models/hq/props.glb.

Run headless:
  blender -b --factory-startup -P blender/hq/props.py -- [options]

Options:
  --out PATH        GLB to write (default public/office-assets/models/hq/props.glb)
  --preview DIR     also render preview sheets into DIR
                    (e.g. blender/_preview/props)
  --only a,b        preview only these kinds (the GLB always has every kind)
  --showroom        also render all props placed together
  --no-export       skip the GLB export

GLB layout (one scene, everything at the origin, Y up):
  <kind>                      empty, named exactly as the HqPropKind
    <kind>__<material>        one mesh per material, identity transform
Front of every prop faces +Z in three.js (-Y in Blender); the origin is the
centre of the footprint on the floor. exec_desk and exec_chair follow the
workstation seat contract instead (origin = chair centre = seated root).
Materials are shared across props: black_matte, black_gloss, leather,
fabric_dark, metal_dark, glass_dark, plant_leaf (COLOR_0), soil,
emissive_red (LED quads: uv.x = blink phase, uv.y = 1 blink / 0 steady),
emissive_warm, screen (UV 0..1 over each display surface).
"""

import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True  # keep blender/hq free of __pycache__
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

import props_furniture as furniture  # noqa: E402
import props_tech as tech  # noqa: E402
from props_lib import Prop, make_materials  # noqa: E402

# Same order as HqPropKind in src/features/hq/core/types.ts.
KINDS = [
    ("planter_tall", furniture.planter_tall),
    ("planter_low", furniture.planter_low),
    ("server_rack", tech.server_rack),
    ("sofa", furniture.sofa),
    ("lounge_chair", furniture.lounge_chair),
    ("coffee_table", furniture.coffee_table),
    ("coffee_bar", tech.coffee_bar),
    ("meeting_table", furniture.meeting_table),
    ("meeting_chair", furniture.meeting_chair),
    ("exec_desk", tech.exec_desk),
    ("exec_chair", furniture.exec_chair),
    ("exec_shelf", tech.exec_shelf),
    ("wall_screen", tech.wall_screen),
    ("floor_lamp", tech.floor_lamp),
]
TRI_BUDGET = 4200


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    opts = {"out": os.path.join(ROOT, "public", "office-assets", "models", "hq", "props.glb"),
            "preview": None, "only": None, "showroom": False, "export": True}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out":
            opts["out"] = argv[i + 1]; i += 1
        elif a == "--preview":
            opts["preview"] = argv[i + 1]; i += 1
        elif a == "--only":
            opts["only"] = argv[i + 1].split(","); i += 1
        elif a == "--showroom":
            opts["showroom"] = True
        elif a == "--no-export":
            opts["export"] = False
        i += 1
    return opts


def build_all():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    mats = make_materials()
    coll = bpy.data.collections.new("hq_props")
    scene.collection.children.link(coll)
    roots = []
    over = []
    for seed, (kind, fn) in enumerate(KINDS, start=1):
        t0 = time.time()
        prop = Prop(kind, seed=seed * 7919)
        fn(prop)
        root, tris = prop.build(mats, coll)
        roots.append(root)
        flag = "  OVER BUDGET" if tris > TRI_BUDGET else ""
        print(f"[prop] {kind:14s} {tris:5d} tris  {len(root.children)} meshes  {time.time() - t0:.2f}s{flag}")
        if tris > TRI_BUDGET:
            over.append(kind)
    total = sum(sum(len(p.vertices) - 2 for p in ob.data.polygons) for r in roots for ob in r.children)
    print(f"[prop] total {total} tris")
    return scene, roots, over


def export_glb(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_vertex_color="ACTIVE",
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_animations=False,
        export_draco_mesh_compression_enable=False,
        export_meshopt_compression_enable=False,
        export_image_format="NONE",
    )
    print(f"[export] {path} {os.path.getsize(path) / 1024:.1f} KiB")


def main():
    opts = parse_args()
    scene, roots, over = build_all()
    if over:
        print("[prop] over budget:", ", ".join(over))
    if opts["export"]:
        export_glb(opts["out"])
    if opts["preview"]:
        import props_preview as preview

        out_dir = os.path.abspath(opts["preview"])
        os.makedirs(out_dir, exist_ok=True)
        cam, lights = preview.setup_scene(scene)
        preview.render_sheet(scene, cam, lights, roots, out_dir, only=opts["only"])
        if opts["showroom"]:
            preview.render_showroom(scene, cam, lights, roots, out_dir)


main()
