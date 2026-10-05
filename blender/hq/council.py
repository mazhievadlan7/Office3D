"""Build AM7's Floor 27 council cabinet and export
public/office-assets/models/hq/council.glb.

Run headless:
  blender -b --factory-startup -P blender/hq/council.py -- [options]

Options:
  --out PATH        GLB to write (default public/office-assets/models/hq/council.glb)
  --preview DIR     also render preview sheets into DIR (e.g. blender/_preview/council)
  --no-export       skip the GLB export

GLB layout (one scene, everything at the origin, Y up), the same contract as
props.glb (blender/hq/props.py):
  <kind>                      empty, named exactly as the council kind
    <kind>__<material>        one mesh per material, identity transform
Front of every piece faces +Z in three.js (-Y in Blender). Seats follow the
workstation seat contract: origin = chair centre on the floor = the seated
character root, the sitter faces -Y, seat top 0.47, desk top 0.74.

Kinds (the app places them from src/features/hq/render/floor27):
  council_table      one long boardroom table, origin = table centre on floor,
                     long axis = X, top at 0.74; a piano-black top with a red
                     light seam, a brushed waist with red underglow, a reeded
                     matte base. 26 seats fit around it, AM7 at the head.
  council_chair      one mid-back council chair facing -Y (the app instances it
                     26 times around the table).
  council_head_chair AM7's taller throne at the head of the table.
  council_screen     the big screen wall behind AM7, origin = base centre on the
                     floor, facing -Y; a framed panel whose display is the
                     "screen" material with 0..1 UVs (the app paints it per
                     speaker). 6.0 m wide, lifted 0.75 m off the floor.
Materials are shared with props.glb (props_lib.MATERIALS); the app lifts every
emissive material to the bloom floor and swaps "screen" for its live canvas.
"""

import math
import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True  # keep blender/hq free of __pycache__
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

import props_exec as ex  # noqa: E402
import props_furniture as furn  # noqa: E402
import props_tech as tech  # noqa: E402
from props_exec import (  # noqa: E402
    flat_ring,
    rbox_bm,
    ribbon_closed,
    rrect2d,
    sweep_closed,
    to_xz,
)
from props_lib import Prop, make_materials  # noqa: E402

PI = math.pi
TOP = 0.74            # table top height
SEAT = 0.47           # seat pan top
# The table that 26 chiefs sit around: a long rounded rectangle, origin at its
# centre on the floor, long axis X. 13 chiefs a side (z = +-ROW), AM7 at the
# -X head. These numbers are mirrored in src/features/hq/render/floor27/layout.
TABLE_L = 11.8
TABLE_W = 2.3


# --- table ---------------------------------------------------------------------------------
def _rect2d(w, d, r, segs=6):
    """Rounded rectangle outline as props_exec expects (x, y, nx, ny), CCW."""
    return rrect2d(w, d, r, segs=segs)


def council_table(p):
    w, d = TABLE_L, TABLE_W
    ol = _rect2d(w, d, 0.26, segs=6)
    # 70 mm piano-black top with a soft bullnose and a red seam round the rim.
    p.merge("black_gloss", sweep_closed(ol, [(0.03, TOP - 0.078), (0.013, TOP - 0.074),
                                             (0.004, TOP - 0.063), (0.0, TOP - 0.047),
                                             (0.0, TOP - 0.014), (0.004, TOP - 0.004),
                                             (0.012, TOP + 0.006), (0.026, TOP + 0.01)]))
    p.merge("emissive_red", ribbon_closed(ol, TOP - 0.0385, TOP - 0.0355))
    # brushed waist band; its soft red underglow washes the reeded base below.
    p.merge("metal_brushed", sweep_closed(ol, [(0.05, TOP - 0.16), (0.05, TOP - 0.076)]))
    p.merge("emissive_red_soft", flat_ring(ex.inset(ol, 0.055), TOP - 0.162, 0.012))
    # reeded matte modesty base, inset, standing on a slim plinth.
    base = _rect2d(w - 0.9, d - 0.9, 0.2, segs=5)
    p.merge("black_satin", sweep_closed(base, [(0.02, 0.05), (0.006, 0.09), (0.0, 0.16),
                                              (0.0, TOP - 0.16)]))
    p.merge("black_matte", sweep_closed(base, [(0.05, 0.0), (0.05, 0.05)]))
    p.merge("emissive_red_soft", ribbon_closed(ex.inset(base, 0.03), 0.03, 0.035))
    # an inlaid matte centre panel on the top, so the long top does not read flat
    inlay = _rect2d(w - 1.1, d - 1.0, 0.18, segs=5)
    p.merge("black_matte", flat_ring(inlay, TOP + 0.0092, 0.0))
    p.merge("emissive_red_soft", ribbon_closed(inlay, TOP + 0.009, TOP + 0.0105))
    # a thin red centreline the length of the table
    p.box("emissive_red_soft", (w - 1.4, 0.03, 0.0012), (0, 0, TOP + 0.0105), bevel=0.0)


# --- chairs --------------------------------------------------------------------------------
WRAP = 0.26


def _wrap(bm, k=WRAP):
    for v in bm.verts:
        v.co.y -= k * v.co.x ** 2
    return bm


def _star_base(p, reach=0.3):
    """Five-star black-chrome base with a gloss gas column, faces -Y."""
    hub_z = 0.1
    p.lathe("chrome_dark", [(0.0, hub_z - 0.03), (0.052, hub_z - 0.03), (0.058, hub_z - 0.01),
                            (0.052, hub_z + 0.022), (0.0, hub_z + 0.028)], segs=28, true_poles=True)
    for i in range(5):
        a = PI / 2 + 2 * PI * i / 5
        d = (math.cos(a), math.sin(a))
        tip = (d[0] * reach, d[1] * reach)
        p.box("black_gloss", (0.05, 0.03, 0.036), (tip[0], tip[1], 0.058), rot=(0, 0, a), bevel=0.01)
        p.cyl("chrome_dark", 0.026, 0.013, (tip[0], tip[1], 0.028), rot=(PI / 2, 0, 0), segs=14)
        p.box("metal_dark", (0.05, reach * 0.9, 0.03), (d[0] * reach * 0.5, d[1] * reach * 0.5, 0.07),
              rot=(0, 0, a + PI / 2), bevel=0.006)
    p.lathe("black_gloss", [(0.0, 0.11), (0.04, 0.11), (0.036, 0.2), (0.03, 0.27), (0.0, 0.27)],
            segs=24, true_poles=True)
    p.cyl("chrome_dark", 0.02, 0.1, (0, 0, 0.31), segs=18)
    p.box("metal_dark", (0.2, 0.24, 0.038), (0, 0.03, 0.36), bevel=0.01)


def _seat_pan(p):
    p.slab("black_gloss", 0.56, 0.54, 0.034, (0, 0.01, 0.4), corner=0.09, csegs=7, bevel=0.009)
    p.merge("emissive_red", ribbon_closed(rrect2d(0.56, 0.54, 0.09, 7, 0, 0.01), 0.3925, 0.3955))
    for x in (-0.15, -0.05, 0.05, 0.15):
        p.rbox("leather", (0.098, 0.48, 0.055), (x, 0.0, 0.432), r=0.024, steps=2, splits=(1, 4, 0),
               bulge=(0.0, 0.0, 0.007))
    for sx in (-1, 1):
        p.rbox("leather", (0.064, 0.5, 0.078), (sx * 0.236, 0.005, 0.443), r=0.028, steps=2,
               splits=(0, 4, 1), bulge=(0.004, 0.0, 0.006))


def _back(p, height, channels, headrest):
    """Tapered gloss shell wrapping quilted leather channels, with a red light
    line and a brushed rear spine; `height` is the back's reach up the recline."""
    H, TAPER = height, 0.13

    def tw(z):
        return 1.0 - TAPER * z / H

    with p.frame((0, 0.225, 0.43), (-0.16, 0, 0)):
        outline = [(x * tw(y), y, nx, ny) for x, y, nx, ny in rrect2d(0.6, H, 0.14, 7, 0, H / 2)]
        shell = sweep_closed(outline, [(0.013, 0.0), (0.004, 0.003), (0.0, 0.011), (0.0, 0.035),
                                       (0.004, 0.044), (0.013, 0.047)], sharp=50)
        p.merge("black_gloss", _wrap(to_xz(shell, 0.02)))
        p.merge("emissive_red", _wrap(to_xz(ribbon_closed(outline, 0.022, 0.026, out=0.0012), 0.02)))
        ch_h, z_base = 0.108, 0.035
        for i in range(channels):
            zc = z_base + (i + 0.5) * ch_h
            p.merge("leather", _wrap(rbox_bm((0.46 * tw(zc), 0.07, ch_h - 0.002), (0, -0.016, zc),
                                             r=0.028, steps=2, splits=(5, 0, 1), bulge=(0.0, 0.011, 0.0))))
        if headrest:
            p.merge("leather", _wrap(rbox_bm((0.38, 0.09, 0.14), (0, -0.02, z_base + channels * ch_h + 0.1),
                                             r=0.038, steps=2, splits=(4, 0, 1), bulge=(0.0, 0.013, 0.0))))
        # rear leather panel inset in the gloss rim, brushed spine, red light line
        rear = ex.inset(outline, 0.026)
        p.merge("leather", _wrap(to_xz(sweep_closed(rear, [(0.011, 0.0), (0.003, 0.004), (0.0, 0.01),
                                                           (0.0, 0.012)], sharp=60), 0.06)))
        spine_h = H * 0.9
        spine = rrect2d(0.09, spine_h, 0.045, 6, 0, spine_h / 2 + 0.02)
        p.merge("metal_brushed", _wrap(to_xz(sweep_closed(spine, [(0.006, 0.0), (0.0, 0.005),
                                                                  (0.0, 0.015), (0.004, 0.019)]), 0.07)))
        p.box("emissive_red", (0.005, 0.003, spine_h * 0.78), (0, 0.091, spine_h / 2 + 0.02), bevel=0.0)


def _arms(p, z_top=0.6):
    for sx in (-1, 1):
        x = sx * 0.31
        p.tube("chrome_dark", [(sx * 0.1, 0.07, 0.37), (sx * 0.28, 0.07, 0.372), (x, 0.07, 0.41),
                               (x, 0.06, 0.55), (x, 0.04, z_top)], 0.013, segs=9)
        p.rbox("leather", (0.08, 0.28, 0.03), (x, 0.0, z_top + 0.02), r=0.014, steps=2, splits=(0, 3, 0),
               bulge=(0.0, 0.0, 0.004))
        p.box("emissive_red", (0.002, 0.24, 0.003), (x + sx * 0.038, 0.0, z_top + 0.018), bevel=0.0)


def council_chair(p):
    """Mid-back council chair. Seat top 0.47, seat centre y = 0, faces -Y."""
    _star_base(p, reach=0.3)
    _seat_pan(p)
    _back(p, height=0.78, channels=5, headrest=False)
    _arms(p, z_top=0.6)


def council_head_chair(p):
    """AM7's throne at the head of the table — unmistakably grander than the 26
    council chairs: a high winged back with a crowned crest, a headrest, a
    heavier five-star base, a low lit dais round its foot and a strong red light
    signature. The seat pan stays at 0.47 so the seated AM7 still sits true; the
    presence is all in the back, the crest, the wings and the dais."""
    H = 1.34
    _throne_dais(p)
    _star_base(p, reach=0.42)
    _seat_pan(p)
    _back(p, height=H, channels=9, headrest=True)
    _throne_crest(p, H)
    _arms(p, z_top=0.66)
    # a thin red halo on the floor behind the throne
    p.merge("emissive_red_soft", ribbon_closed(ex.circle2d(0.46, 48, 0, 0.1), 0.006, 0.012, out=0.0008))


def _throne_dais(p):
    """A low circular dais the throne stands on: flush enough that AM7's feet
    rest on it, a black plinth with a red light ring round its edge."""
    r = 0.92
    p.lathe("black_satin", [(0.0, 0.0), (r - 0.04, 0.0), (r, 0.03), (r, 0.075),
                            (r - 0.05, 0.08), (0.0, 0.08)], segs=56, true_poles=True)
    p.merge("emissive_red_soft", ribbon_closed(ex.circle2d(r - 0.018, 56, 0, 0.0), 0.079, 0.082, out=0.001))
    p.merge("emissive_red_soft", flat_ring(ex.circle2d(r + 0.005, 56, 0, 0.0), 0.003, 0.0))


def _throne_crest(p, H):
    """Winged upper back and a crowned crest above the headrest, in the back's
    reclined frame (matching _back): two tapered gloss wings and a capping bar
    with a red light edge, so the head of the table reads as a throne."""
    with p.frame((0, 0.225, 0.43), (-0.16, 0, 0)):
        # wings: tapered gloss panels flaring out either side of the upper back
        for sx in (-1, 1):
            p.box("black_gloss", (0.12, 0.055, 0.5), (sx * 0.34, 0.03, H * 0.66),
                  rot=(0, sx * 0.12, sx * 0.14), bevel=0.012)
            p.box("emissive_red", (0.006, 0.004, 0.42), (sx * 0.40, 0.055, H * 0.66),
                  rot=(0, sx * 0.12, sx * 0.14), bevel=0.0)
        # crowned crest: a wide capping bar above the headrest with a red seam
        p.box("black_gloss", (0.68, 0.085, 0.07), (0, 0.03, H + 0.03), bevel=0.016)
        p.box("metal_brushed", (0.6, 0.055, 0.02), (0, 0.07, H + 0.03), bevel=0.004)
        p.box("emissive_red", (0.5, 0.004, 0.004), (0, 0.082, H + 0.03), bevel=0.0)
        # a short red spine rising into the crest from the headrest
        p.box("emissive_red", (0.006, 0.004, 0.12), (0, 0.06, H - 0.04), bevel=0.0)


# The back-wall art — the герб (emblem), MECHTATEL's portrait and the motto —
# is NOT modelled here: the app mounts the reference artwork as high-res textures
# on framed, beveled, emissive wall panels (src/features/hq/render/floor27/
# councilWallArt.ts), which is точь-в-точь to the owner's reference images.


# --- lounge (reuses the shared HQ furniture, in the council's materials) --------------------
def council_sofa(p):
    """A three-seat club sofa for AM7's lounge (shared HQ upholstery)."""
    furn.sofa(p)


def council_lounge_chair(p):
    """A single club chair for the lounge (shared HQ upholstery)."""
    furn.lounge_chair(p)


def council_lounge_table(p):
    """Smoked-glass coffee table for the lounge."""
    furn.coffee_table(p)


def council_plant(p):
    """AM7's near-black strap-leaf plant, for lounge and corner decor."""
    furn.dark_plant(p)


def council_tv(p):
    """A wall-mounted flagship display for the lounge. Its surface is the
    "screen" material, so the app's live council feed mirrors onto it."""
    tech.wall_screen(p)


# --- screen wall ---------------------------------------------------------------------------
SCR_W, SCR_H = 6.0, 2.55     # display size
SCR_BASE = 0.75             # bottom of the display off the floor


def council_screen(p):
    """A framed screen wall, origin = base centre on the floor, facing -Y. The
    display quad is the "screen" material (0..1 UVs, v=0 at the bottom)."""
    z0, z1 = SCR_BASE, SCR_BASE + SCR_H
    hw = SCR_W / 2
    # brushed outer frame, slim bezel
    fr = 0.09
    p.box("metal_brushed", (SCR_W + 2 * fr, 0.14, fr), (0, 0.0, z0 - fr / 2), bevel=0.01)
    p.box("metal_brushed", (SCR_W + 2 * fr, 0.14, fr), (0, 0.0, z1 + fr / 2), bevel=0.01)
    for sx in (-1, 1):
        p.box("metal_brushed", (fr, 0.14, SCR_H + 2 * fr), (sx * (hw + fr / 2), 0.0, (z0 + z1) / 2), bevel=0.01)
    # black gloss backing panel behind the glass
    p.box("black_gloss", (SCR_W + 0.04, 0.06, SCR_H + 0.04), (0, 0.03, (z0 + z1) / 2), bevel=0.004)
    # the display quad, facing -Y; UV (0,0) bottom-left of the viewer, (1,1) top-right
    p.quad("screen", SCR_W, SCR_H, (0, -0.012, (z0 + z1) / 2), uv_rect=(0.0, 0.0, 1.0, 1.0))
    # a red light line tracing the frame
    p.box("emissive_red", (SCR_W + 2 * fr, 0.004, 0.006), (0, -0.07, z0 - fr), bevel=0.0)
    p.box("emissive_red", (SCR_W + 2 * fr, 0.004, 0.006), (0, -0.07, z1 + fr), bevel=0.0)
    # a slim lit plinth under the screen
    p.box("black_matte", (SCR_W + 0.5, 0.5, SCR_BASE - 0.02), (0, 0.1, (SCR_BASE - 0.02) / 2), bevel=0.01)
    p.merge("emissive_red_soft", flat_ring(_rect2d(SCR_W + 0.5, 0.5, 0.05, 4), SCR_BASE - 0.02, 0.0))


KINDS = [
    ("council_table", council_table),
    ("council_chair", council_chair),
    ("council_head_chair", council_head_chair),
    ("council_screen", council_screen),
    # Premium interior: the lounge and corner decor. (The back-wall герб, portrait
    # and motto are textured wall panels built in the app, not meshes here.)
    ("council_sofa", council_sofa),
    ("council_lounge_chair", council_lounge_chair),
    ("council_lounge_table", council_lounge_table),
    ("council_tv", council_tv),
    ("council_plant", council_plant),
]
BUDGET = {"council_table": 20000, "council_chair": 16000, "council_head_chair": 28000,
          "council_screen": 4000, "council_sofa": 9000,
          "council_lounge_chair": 6000, "council_lounge_table": 6000, "council_tv": 4000,
          "council_plant": 9000}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"out": os.path.join(ROOT, "public", "office-assets", "models", "hq", "council.glb"),
            "preview": None, "export": True}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out":
            opts["out"] = argv[i + 1]; i += 1
        elif a == "--preview":
            opts["preview"] = argv[i + 1]; i += 1
        elif a == "--no-export":
            opts["export"] = False
        i += 1
    return opts


def build_all():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    mats = make_materials()
    coll = bpy.data.collections.new("council")
    scene.collection.children.link(coll)
    roots = []
    over = []
    for seed, (kind, fn) in enumerate(KINDS, start=1):
        t0 = time.time()
        prop = Prop(kind, seed=seed * 2411)
        fn(prop)
        root, tris = prop.build(mats, coll)
        roots.append(root)
        budget = BUDGET.get(kind, 8000)
        flag = "  OVER BUDGET" if tris > budget else ""
        print(f"[council] {kind:20s} {tris:6d} tris  {len(root.children)} meshes  {time.time() - t0:.2f}s{flag}")
        if tris > budget:
            over.append(kind)
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
        print("[council] over budget:", ", ".join(over))
    if opts["export"]:
        export_glb(opts["out"])
    if opts["preview"]:
        import props_preview as preview

        out_dir = os.path.abspath(opts["preview"])
        os.makedirs(out_dir, exist_ok=True)
        cam, lights = preview.setup_scene(scene)
        preview.render_sheet(scene, cam, lights, roots, out_dir)


main()
