"""Archive service props: the archive cart an agent pushes out of the hall, its
docking bay with a 4-segment fill gauge, the load it carries and the intake
cabinet ("шлюз утилизации") on the apron that swallows the load. Registered in
props.py after every earlier kind.

Blender frame: metres, Z up, front faces -Y (+Z in three.js), origin at the
centre of the footprint on the floor. One empty per kind, one mesh per
material (props_lib.Prop).

  archive_cart              moulded graphite cart, deck 1.00 x 0.60 m (top 0.20 m):
                            chamfered deck with a brushed waist band, side skirts,
                            nose bumper, rear spine, one U-yoke handle, swivel casters
                            with thin red rims, a handlebar hub with an unlit light
                            channel and a small tablet angled up at the pusher.
                            FRONT (-Y) = direction of travel; the handle is at +Y.
                            Origin = deck centre on the floor. Grip bar centre
                            (0, +0.62, 0.97), grips at x = +-0.20: with the pusher's
                            root 1.02 m behind the origin the bar is 0.40 m ahead of
                            the root (blender/hacker/anims/push.py, HQ_PUSH_GRIP).
                            The tablet surface is a "screen" quad, UV 0..1 (u to the
                            pusher's right, v up), so the app can draw on it.
  archive_cart_lit          the handle light strip, lit (shown while loaded / moving).
  archive_cart_display_full / archive_cart_display_empty
                            tablet read-outs as geometry (header, size, 4-cell bar);
                            the app may draw its own canvas on the "screen" quad instead.
  archive_load_1..4         ADDITIVE tiers (show tier k when k <= level): matte black
                            hard cases and banded paper stacks, resting on the deck
                            (z >= 0.20) in the cart's frame.
  archive_bay               docking station 0.95 x 1.40 m: plinth, guide rails, wheel
                            stops, bumper wall at +Y and a gauge tower (four unlit
                            windows with faint red ticks), a label plate. The mouth
                            (-Y) faces the hall; the cart noses in toward +Y, i.e. a
                            parked cart has the bay's heading + pi.
  archive_bay_led_1..4      the lit gauge segments, bottom to top (LED 4 carries the
                            blink flag in its UV).
  archive_chute             intake cabinet 0.70 x 0.60 m, 0.94 m high: roller feed lip
                            and slot at the front (-Y), slot floor at z 0.62.
  archive_chute_shutter     slatted shutter closing the slot (roll it up about the slot
                            top, z 0.84, while a case feeds).
  archive_chute_slot        the glow inside the slot, "emissive_red_dim".
  archive_case              one loose hard case (origin on its bottom face), for a case
                            travelling from the deck into the slot.

Materials: the shared ones (black_matte, black_satin, metal_brushed, metal_dark,
emissive_red, emissive_red_dim, screen) plus "paper" (added by install_materials):
vertex-colour tinted, rough, low albedo so stacks and labels never glare.
"""

import math
import os

import bmesh
import bpy
from mathutils import Vector

from props_lib import MATERIALS, _autosharp, _box_uvs, _new_bm, led_uv, xform

PI = math.pi

NEW_MATERIALS = {
    # printed paper / light-grey print: vertex-colour tinted, rough, low albedo, no glare
    "paper": dict(base=(1.0, 1.0, 1.0), rough=0.82, metal=0.0, vcol=True),
}


def install_materials():
    """Add the archive's own materials to props_lib.MATERIALS (before make_materials)."""
    for k, v in NEW_MATERIALS.items():
        MATERIALS.setdefault(k, v)


# off-white but low albedo (linear); reads as paper under the warm hall light, never as a tile
PAPER = [(0.078, 0.076, 0.07), (0.07, 0.069, 0.064), (0.085, 0.083, 0.077), (0.065, 0.064, 0.06)]
LABEL = (0.05, 0.05, 0.048)  # dark printed case label
PRINT = (0.30, 0.30, 0.29)  # light-grey print on graphite plates


# --- helpers -------------------------------------------------------------------------------
def vbox(p, mat, size, loc, color, rot=None, bevel=0.002):
    """Chamfered box with a flat vertex colour (vertex-colour materials)."""
    bm = _new_bm()
    bmesh.ops.create_cube(bm, size=1.0, calc_uvs=True)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    if bevel > 0:
        b = min(bevel, min(size) * 0.45)
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=b, segments=1, affect="EDGES", clamp_overlap=True)
    _box_uvs(bm)
    _autosharp(bm, smooth=False)
    p.merge(mat, bm, xform(loc, rot), color=color)


def prism_x(p, mat, poly_yz, x0, x1, color=None):
    """Extrude a (y, z) polygon along X from x0 to x1 (tapered lips, wedges)."""
    bm = _new_bm()
    a = [bm.verts.new((x0, y, z)) for y, z in poly_yz]
    b = [bm.verts.new((x1, y, z)) for y, z in poly_yz]
    n = len(poly_yz)
    bm.faces.new(a)
    bm.faces.new(b)
    for k in range(n):
        k2 = (k + 1) % n
        bm.faces.new((a[k], a[k2], b[k2], b[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    _box_uvs(bm)
    _autosharp(bm, smooth=False)
    p.merge(mat, bm, None, color=color)


_FONT = []


def _font():
    """Blender's bundled monospace font, found through the install's datafiles."""
    if not _FONT:
        fonts = bpy.utils.system_resource("DATAFILES", path="fonts") or ""
        path = os.path.join(fonts, "DejaVuSansMono.woff2")
        _FONT.append(bpy.data.fonts.load(path, check_existing=True) if os.path.isfile(path) else None)
    return _FONT[0]


def text(p, mat, s, size, loc, rot=None, align="CENTER", res=2, spacing=1.0, color=None):
    """Flat text lying in the local XY plane, facing local +Z (reads along +X)."""
    cu = bpy.data.curves.new("_txt", "FONT")
    font = _font()
    if font is not None:
        cu.font = font
    cu.body = s
    cu.size = size
    cu.align_x = align
    cu.align_y = "CENTER"
    cu.resolution_u = res
    cu.space_character = spacing
    ob = bpy.data.objects.new("_txt", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    bm = _new_bm()
    bm.from_mesh(me)
    ev.to_mesh_clear()
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.curves.remove(cu)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    for f in bm.faces:
        f.smooth = False
    p.merge(mat, bm, xform(loc, rot), color=color)


# =============================================================================================
# CART
# =============================================================================================
DECK_W, DECK_L = 0.60, 1.00
DECK_TOP = 0.20
BODY_Z0, BODY_Z1 = 0.145, 0.195  # moulded deck body
WHEEL_R = 0.0625
WHEEL_X, WHEEL_Y = 0.215, 0.37
GRIP = Vector((0.0, 0.62, 0.97))  # grip bar centre
GRIP_X = 0.20
BAR_R = 0.0175  # rubber grip radius (push.py BAR_R)
LEG_X = 0.285  # yoke legs
SHOULDER_R = 0.038
TAB_TILT = math.radians(35)
TAB_C = Vector((0.0, 0.600, 1.050))
LOAD_Z = 0.202
SPINE_Y0, SPINE_Y1, SPINE_Z1 = 0.432, 0.505, 0.305
SCREEN_W, SCREEN_H = 0.154, 0.09  # tablet display surface
SCREEN_Z = 0.0072  # display surface above the tablet frame's centre plane


def _caster(p, x, y, side):
    """Swivel caster: a dark swivel plate and fork crown under the deck, two fork legs down to
    the axle, a rubber tyre, a dark hub, a thin red ring on the outer sidewall, an axle cap."""
    zc = WHEEL_R
    # swivel plate + crown
    p.cyl("metal_dark", 0.03, 0.01, (x, y, BODY_Z0 - 0.006), segs=12)
    p.box("black_satin", (0.062, 0.05, 0.014), (x, y, BODY_Z0 - 0.018), bevel=0.0)
    # fork legs (outboard + inboard), from the crown to the axle
    for e in (-1, 1):
        p.box("black_satin", (0.006, 0.036, 0.08), (x + e * 0.0265, y, zc + 0.034), bevel=0.0)
    # tyre
    prof = [(0.037, -0.0152), (WHEEL_R, -0.0115), (WHEEL_R, 0.0115), (0.037, 0.0152)]
    p.lathe("black_matte", prof, loc=(x, y, zc), rot=(0, PI / 2, 0), segs=22, sharp=60.0)
    # dark hub
    p.cyl("metal_dark", 0.037, 0.027, (x, y, zc), rot=(0, PI / 2, 0), segs=22, sharp=60.0)
    # thin red ring on the outer sidewall
    xo = x + side * 0.0146
    ring = [(0.0482, 0.0), (0.0455, 0.0)] if side > 0 else [(0.0455, 0.0), (0.0482, 0.0)]  # faces outward
    p.lathe("emissive_red", ring, loc=(xo, y, zc), rot=(0, PI / 2, 0), segs=22, sharp=10.0)
    # axle cap through the fork
    p.cyl("metal_brushed", 0.009, 0.062, (x, y, zc), rot=(0, PI / 2, 0), segs=10)


def _yoke(p):
    """One continuous U-yoke: raked legs from the spine, radiused shoulders into the top bar."""
    base = Vector((LEG_X, 0.462, 0.24))
    top = Vector((LEG_X, 0.612, GRIP.z - SHOULDER_R))
    pts, rad = [], []
    # left half, base -> shoulder -> centre
    legs = [base, base.lerp(top, 0.55), top]
    legr = [0.022, 0.0195, 0.0178]
    arc = []
    n = 5
    for k in range(1, n + 1):
        a = (PI / 2) * k / n
        arc.append(Vector((LEG_X - SHOULDER_R + SHOULDER_R * math.cos(a), top.y + (GRIP.y - top.y) * k / n,
                           GRIP.z - SHOULDER_R + SHOULDER_R * math.sin(a))))
    arcr = [0.0178 - (0.0178 - 0.0135) * k / n for k in range(1, n + 1)]
    half = legs + arc
    halfr = legr + arcr
    for v, r in zip(half, halfr):
        pts.append(Vector((-v.x, v.y, v.z)))
        rad.append(r)
    pts.append(Vector((0.0, GRIP.y, GRIP.z)))
    rad.append(0.0135)
    for v, r in zip(reversed(half), reversed(halfr)):
        pts.append(Vector(v))
        rad.append(r)
    p.tube("black_satin", pts, 0.02, segs=10, caps=True, radii=rad, sharp=70.0)


def _tablet_frame():
    """The tablet's local frame: XY is the display plane, +Z faces the pusher, +Y is up."""
    return tuple(TAB_C), (PI / 2 - TAB_TILT, 0, PI)


def archive_cart(p):
    """Deck 1.00 x 0.60 m, top 0.20 m; grip bar 0.97 m high at y = +0.62."""
    zb = (BODY_Z0 + BODY_Z1) / 2
    # moulded deck body: rounded plan, chamfered top edge
    p.slab("black_matte", DECK_W, DECK_L, BODY_Z1 - BODY_Z0, (0, 0, zb), corner=0.06, csegs=3, bevel=0.011)
    # brushed waist band and a dark parting line just under the chamfer
    p.slab("metal_brushed", DECK_W + 0.005, DECK_L + 0.005, 0.007, (0, 0, BODY_Z0 + 0.009), corner=0.062, csegs=3,
           bevel=0.0)
    p.slab("metal_dark", DECK_W + 0.003, DECK_L + 0.003, 0.0025, (0, 0, BODY_Z1 - 0.0135), corner=0.061, csegs=3,
           bevel=0.0)
    # matte deck mat inset inside the chamfer (satin read as a glare sheet from above)
    p.slab("black_matte", DECK_W - 0.06, DECK_L - 0.06, 0.007, (0, 0, DECK_TOP - 0.0015), corner=0.035, csegs=2,
           bevel=0.0015)
    # low side skirts, outboard of the wheels, their bottoms over the axles
    for s in (-1, 1):
        p.slab("black_matte", 0.068, 0.9, 0.022, (s * (DECK_W / 2 - 0.011), 0.0, 0.086 + 0.034), corner=0.03,
               csegs=3, bevel=0.005, rot=(0, s * PI / 2, 0))
    # nose bumper and an under-body tray
    p.box("black_satin", (0.44, 0.02, 0.036), (0, -DECK_L / 2 - 0.002, BODY_Z0 + 0.02), bevel=0.008)
    p.box("black_satin", (0.4, 0.56, 0.028), (0, 0, BODY_Z0 - 0.012), bevel=0.006)
    # short red running lines on the long sides (the only red on the body)
    for s in (-1, 1):
        p.box("emissive_red", (0.003, 0.22, 0.0035), (s * (DECK_W / 2 + 0.0012), -0.29, BODY_Z0 + 0.024), bevel=0.0)
    # casters
    for sx in (-1, 1):
        for sy in (-1, 1):
            _caster(p, sx * WHEEL_X, sy * WHEEL_Y, sx)

    # ---- rear spine housing + U-yoke ----
    sy = (SPINE_Y0 + SPINE_Y1) / 2
    p.slab("black_satin", 0.618, SPINE_Y1 - SPINE_Y0, SPINE_Z1 - DECK_TOP + 0.004,
           (0, sy, (DECK_TOP - 0.004 + SPINE_Z1) / 2), corner=0.03, csegs=3, bevel=0.012)
    p.slab("metal_brushed", 0.622, SPINE_Y1 - SPINE_Y0 + 0.004, 0.006, (0, sy, DECK_TOP + 0.03), corner=0.032,
           csegs=3, bevel=0.0)
    _yoke(p)
    # rubber grips with brushed collars
    for sx in (-1, 1):
        p.cyl("black_matte", BAR_R, 0.09, (sx * GRIP_X, GRIP.y, GRIP.z), rot=(0, PI / 2, 0), segs=14)
        for e in (-1, 1):
            p.cyl("metal_brushed", BAR_R + 0.002, 0.005, (sx * GRIP_X + e * 0.0475, GRIP.y, GRIP.z),
                  rot=(0, PI / 2, 0), segs=14)
    # handlebar hub with the (unlit) light channel on its back, facing the pusher
    p.box("black_satin", (0.2, 0.036, 0.034), (0, GRIP.y, GRIP.z + 0.004), bevel=0.01)
    p.box("metal_dark", (0.16, 0.003, 0.006), (0, GRIP.y + 0.0185, GRIP.z + 0.008), bevel=0.0)
    # tablet stalk and tablet, angled up at the pusher
    nrm = Vector((0.0, math.cos(TAB_TILT), math.sin(TAB_TILT)))
    back = TAB_C - nrm * 0.004
    a, b = Vector((0, GRIP.y - 0.004, GRIP.z + 0.012)), back
    v = b - a
    p.box("metal_dark", (0.03, 0.016, v.length), tuple((a + b) / 2), rot=(math.atan2(-v.y, v.z), 0, 0), bevel=0.004)
    with p.frame(*_tablet_frame()):
        p.box("black_matte", (0.172, 0.108, 0.012), (0, 0, 0), bevel=0.004)
        # display surface: one quad facing the pusher, UV 0..1 (u right, v up as he reads it)
        p.quad("screen", SCREEN_W, SCREEN_H, (0, 0, SCREEN_Z), rot=(-PI / 2, 0, 0))
        p.box("metal_brushed", (0.176, 0.004, 0.013), (0, 0.054, 0.0), bevel=0.001)


def archive_cart_lit(p):
    p.box("emissive_red", (0.16, 0.004, 0.007), (0, GRIP.y + 0.0195, GRIP.z + 0.008), bevel=0.0)


def _display(p, value, tier):
    """Near-black screen: a small header, the size large, a 4-cell load bar."""
    with p.frame(*_tablet_frame()):
        z = 0.0075
        text(p, "emissive_red_dim", "ARCHIVE", 0.0095, (-0.068, 0.034, z), align="LEFT", res=2)
        text(p, "emissive_red_dim", f"{tier}/4", 0.0095, (0.068, 0.034, z), align="RIGHT", res=2)
        text(p, "emissive_red", value, 0.032, (0, 0.004, z), res=2)
        for k in range(4):
            mat = "emissive_red" if k < tier else "emissive_red_dim"
            p.box(mat, (0.031, 0.007, 0.0015), (-0.0495 + k * 0.033, -0.031, z), bevel=0.0)


def archive_cart_display_full(p):
    _display(p, "120 MB", 4)


def archive_cart_display_empty(p):
    _display(p, "0 MB", 0)


# =============================================================================================
# LOAD: matte black hard cases + banded paper stacks
# =============================================================================================
CW, CL, CH = 0.27, 0.34, 0.19  # case x, y, z


def case(p, loc, yaw=0.0, face=1, rng=None, led=True):
    """Black hard case standing on loc (x, y, z_bottom), long axis along Y. `face` = +1/-1: the
    side (+X / -X) with the latches, the fold-flat handle, the label and the status LED."""
    rng = rng or p.rng
    x, y, z = loc
    with p.frame((x, y, z), (0, 0, yaw)):
        hb = CH * 0.68
        p.box("black_matte", (CW, CL, hb), (0, 0, hb / 2), bevel=0.014)
        lid_h = CH - hb - 0.004
        p.box("black_matte", (CW + 0.003, CL + 0.003, lid_h), (0, 0, hb + 0.004 + lid_h / 2), bevel=0.014)
        # parting seam
        p.box("black_satin", (CW - 0.012, CL - 0.012, 0.006), (0, 0, hb + 0.002), bevel=0.0)
        # ribbed lid: two low ribs across
        for yy in (-0.075, 0.075):
            p.box("black_matte", (CW - 0.07, 0.014, 0.005), (0, yy, CH + 0.0015), bevel=0.002)
        fx = face * (CW / 2 + 0.0035)
        # two latches straddling the seam
        for s in (-1, 1):
            p.box("black_satin", (0.009, 0.036, 0.04), (fx, s * 0.105, hb + 0.002), bevel=0.003)
            p.box("metal_dark", (0.002, 0.02, 0.004), (fx + face * 0.0048, s * 0.105, hb + 0.012), bevel=0.0)
        # fold-flat handle lying in a shallow recess on the working side of the lid
        p.box("metal_dark", (0.004, 0.13, 0.016), (face * (CW / 2 + 0.0005), 0.0, hb + 0.004 + lid_h * 0.55),
              bevel=0.0)
        p.box("black_satin", (0.008, 0.11, 0.009), (face * (CW / 2 + 0.003), 0.0, hb + 0.004 + lid_h * 0.55),
              bevel=0.003)
        # small dark label with barcode lines and one red status LED
        zl = hb * 0.46
        vbox(p, "paper", (0.002, 0.07, 0.03), (face * (CW / 2 + 0.001), 0.0, zl), LABEL, bevel=0.0)
        bars = [0.002, 0.001, 0.003, 0.001, 0.002, 0.001, 0.003, 0.002]
        yy = -0.024
        for w in bars:
            vbox(p, "paper", (0.001, w, 0.014), (face * (CW / 2 + 0.0024), yy, zl - 0.004), PRINT, bevel=0.0)
            yy += w + 0.0035
        vbox(p, "paper", (0.001, 0.05, 0.003), (face * (CW / 2 + 0.0024), 0.0, zl + 0.0085), PRINT, bevel=0.0)
        if led:
            p.box("emissive_red", (0.003, 0.006, 0.006), (face * (CW / 2 + 0.0016), -0.12, zl), bevel=0.0,
                  uv=led_uv(rng.random(), rng.random() < 0.5))


def ream(p, loc, yaw, h=0.05, rng=None, n=6, size=(0.297, 0.21), band=True, clip=False):
    """A banded stack of paper: thin strata with small offsets, a dark band round the middle."""
    rng = rng or p.rng
    x, y, z = loc
    with p.frame((x, y, z), (0, 0, yaw)):
        hh = h / n
        for k in range(n):
            a = rng.uniform(-0.012, 0.012)
            vbox(p, "paper", (size[0] - rng.uniform(0, 0.004), size[1] - rng.uniform(0, 0.004), hh - 0.0008),
                 (rng.uniform(-0.003, 0.003), rng.uniform(-0.003, 0.003), hh * (k + 0.5)), rng.choice(PAPER),
                 rot=(0, 0, a), bevel=0.0006)
        if band:
            p.box("black_satin", (0.024, size[1] + 0.006, h + 0.003), (size[0] * 0.18, 0, h / 2), bevel=0.001)
        if clip:
            p.box("black_satin", (0.045, 0.02, 0.012), (-size[0] * 0.2, -size[1] / 2 + 0.006, h - 0.002), bevel=0.002)
            p.box("metal_brushed", (0.03, 0.002, 0.022), (-size[0] * 0.2, -size[1] / 2 - 0.004, h + 0.004), bevel=0.0)


COL_X = (-0.14, 0.14)
ROW_Y = (-0.305, 0.04)  # front, rear
TOP_Z = LOAD_Z + CH + 0.001
REAR_BAY_Y = 0.325  # paper bay between the rear row and the spine


def archive_load_1(p):
    """Two cases at the nose, a banded paper stack in the rear bay by the spine."""
    rng = p.rng
    for x in COL_X:
        case(p, (x, ROW_Y[0], LOAD_Z), yaw=rng.uniform(-0.015, 0.015), face=(1 if x > 0 else -1), rng=rng)
    ream(p, (0.0, REAR_BAY_Y, LOAD_Z), 0.02, h=0.06, rng=rng, n=7)


def archive_load_2(p):
    """Two more cases: the bottom row is full."""
    rng = p.rng
    for x in COL_X:
        case(p, (x, ROW_Y[1], LOAD_Z), yaw=rng.uniform(-0.015, 0.015), face=(1 if x > 0 else -1), rng=rng)


def archive_load_3(p):
    """Second tier over the nose row, one case a little askew; the rear paper stack grows."""
    rng = p.rng
    case(p, (-0.138, ROW_Y[0] + 0.008, TOP_Z), yaw=0.025, face=-1, rng=rng)
    case(p, (0.144, ROW_Y[0] + 0.014, TOP_Z), yaw=-0.05, face=1, rng=rng)
    ream(p, (0.004, REAR_BAY_Y - 0.002, LOAD_Z + 0.061), -0.035, h=0.05, rng=rng, n=6)


def archive_load_4(p):
    """Full: one case on the rear stack, a clipped paper stack beside it."""
    rng = p.rng
    case(p, (-0.14, ROW_Y[1] - 0.004, TOP_Z), yaw=0.06, face=-1, rng=rng)
    ream(p, (0.13, ROW_Y[1] + 0.005, TOP_Z), -0.09, h=0.055, rng=rng, n=6, size=(0.21, 0.297), clip=True)


def archive_case(p):
    case(p, (0, 0, 0), 0.0, face=1)


# =============================================================================================
# BAY (docking station). The mouth (-Y) faces the hall; the cart noses in toward the bumper.
# =============================================================================================
BAY_W, BAY_D = 0.95, 1.40
WALL_Y0, WALL_Y1, WALL_H = 0.56, 0.70, 0.342
TOWER_W, TOWER_D, TOWER_H = 0.26, 0.13, 1.26
TOWER_Y = WALL_Y0 + TOWER_D / 2
GAUGE = dict(x=0.0, z0=0.66, h=0.085, gap=0.02, w=0.12)
GAUGE_Y = WALL_Y0 - 0.0065  # face of the unlit windows


def gauge_segments():
    return [(GAUGE["x"], GAUGE_Y, GAUGE["z0"] + GAUGE["h"] / 2 + k * (GAUGE["h"] + GAUGE["gap"]), GAUGE["h"])
            for k in range(4)]


def archive_bay(p):
    # plinth
    p.slab("black_matte", BAY_W, BAY_D, 0.022, (0, 0, 0.011), corner=0.05, csegs=3, bevel=0.004)
    # low guide rails with brushed caps
    ry0, ry1 = -BAY_D / 2 + 0.09, WALL_Y0 - 0.1
    for s in (-1, 1):
        x = s * 0.385
        p.box("black_satin", (0.045, ry1 - ry0, 0.042), (x, (ry0 + ry1) / 2, 0.022 + 0.021), bevel=0.008)
        p.box("metal_brushed", (0.047, ry1 - ry0 - 0.01, 0.005), (x, (ry0 + ry1) / 2, 0.0655), bevel=0.0012)
    # wheel stops
    for s in (-1, 1):
        p.box("black_satin", (0.08, 0.045, 0.03), (s * 0.215, 0.51, 0.037), bevel=0.01)
    # bumper wall across the back, a rubber buffer the cart nose touches, brushed top band
    p.slab("black_matte", BAY_W, WALL_Y1 - WALL_Y0, WALL_H - 0.022, (0, (WALL_Y0 + WALL_Y1) / 2, (0.022 + WALL_H) / 2),
           corner=0.03, csegs=3, bevel=0.008)
    p.slab("metal_brushed", BAY_W + 0.005, WALL_Y1 - WALL_Y0 + 0.005, 0.008, (0, (WALL_Y0 + WALL_Y1) / 2, WALL_H - 0.03),
           corner=0.032, csegs=3, bevel=0.0)
    p.box("black_satin", (0.62, 0.018, 0.05), (0, WALL_Y0 - 0.008, 0.17), bevel=0.008)
    # the gauge tower on the wall
    p.slab("black_matte", TOWER_W, TOWER_D, TOWER_H - WALL_H, (0, TOWER_Y, (WALL_H + TOWER_H) / 2), corner=0.03,
           csegs=3, bevel=0.01)
    p.slab("metal_brushed", TOWER_W + 0.005, TOWER_D + 0.005, 0.008, (0, TOWER_Y, WALL_H + 0.012), corner=0.032,
           csegs=3, bevel=0.0)
    # gauge housing: a recessed satin panel, four graphite windows with a faint red tick each
    segs = gauge_segments()
    zlo = GAUGE["z0"] - 0.022
    zhi = segs[-1][2] + GAUGE["h"] / 2 + 0.022
    p.box("black_satin", (GAUGE["w"] + 0.05, 0.008, zhi - zlo), (GAUGE["x"], WALL_Y0 - 0.002, (zlo + zhi) / 2),
          bevel=0.004)
    for gx, gy, gz, h in segs:
        p.box("metal_dark", (GAUGE["w"], 0.002, h), (gx, gy, gz), bevel=0.0)
        p.box("emissive_red_dim", (0.004, 0.002, h * 0.6), (gx - GAUGE["w"] / 2 - 0.009, gy, gz), bevel=0.0)
    for k in range(5):
        z = GAUGE["z0"] - GAUGE["gap"] / 2 + k * (GAUGE["h"] + GAUGE["gap"])
        p.box("metal_brushed", (0.012, 0.002, 0.0025), (GAUGE["x"] + GAUGE["w"] / 2 + 0.013, GAUGE_Y, z), bevel=0.0)
    # label plate: light-grey print, one thin red rule
    zl = zhi + 0.075
    p.box("black_satin", (0.22, 0.008, 0.11), (0, WALL_Y0 - 0.002, zl), bevel=0.003)
    text(p, "paper", "ARCHIVE", 0.024, (0, WALL_Y0 - 0.0065, zl + 0.03), rot=(PI / 2, 0, 0), res=2, color=PRINT)
    text(p, "paper", "BAY 01", 0.042, (0, WALL_Y0 - 0.0065, zl - 0.006), rot=(PI / 2, 0, 0), res=2, color=PRINT)
    p.box("emissive_red", (0.17, 0.002, 0.0025), (0, WALL_Y0 - 0.0065, zl - 0.04), bevel=0.0)


def _bay_led(p, n, blink_top=False):
    gx, gy, gz, h = gauge_segments()[n - 1]
    uv = led_uv(0.37, True) if blink_top else None
    p.box("emissive_red", (GAUGE["w"], 0.002, h), (gx, gy - 0.0022, gz), bevel=0.0, uv=uv)


def archive_bay_led_1(p):
    _bay_led(p, 1)


def archive_bay_led_2(p):
    _bay_led(p, 2)


def archive_bay_led_3(p):
    _bay_led(p, 3)


def archive_bay_led_4(p):
    _bay_led(p, 4, blink_top=True)


# =============================================================================================
# CHUTE ("шлюз утилизации"): footprint 0.70 x 0.60 incl. the feed lip; the slot faces -Y.
# =============================================================================================
CHUTE_W, CHUTE_D, CHUTE_H = 0.70, 0.60, 0.94
BODY_D = 0.46
BODY_Y0 = -CHUTE_D / 2 + (CHUTE_D - BODY_D)  # body front face (-0.16)
BODY_YC = BODY_Y0 + BODY_D / 2
SLOT = dict(w=0.46, z0=0.62, z1=0.84, depth=0.30)
ROLL_Z = SLOT["z0"]


def archive_chute(p):
    W, H = CHUTE_W, CHUTE_H
    y0 = BODY_Y0
    # plinth on a shadow gap
    p.slab("black_matte", W - 0.05, BODY_D - 0.05, 0.05, (0, BODY_YC, 0.025), corner=0.03, csegs=2, bevel=0.0)
    zb = 0.05
    p.slab("black_matte", W, BODY_D, SLOT["z0"] - zb, (0, BODY_YC, zb + (SLOT["z0"] - zb) / 2), corner=0.035, csegs=3,
           bevel=0.006)
    cw = (W - SLOT["w"]) / 2
    for s in (-1, 1):
        p.box("black_matte", (cw, BODY_D, SLOT["z1"] - SLOT["z0"]), (s * (SLOT["w"] / 2 + cw / 2), BODY_YC,
                                                                     (SLOT["z0"] + SLOT["z1"]) / 2), bevel=0.004)
    bd = BODY_D - SLOT["depth"]
    p.box("black_matte", (SLOT["w"] + 0.004, bd, SLOT["z1"] - SLOT["z0"]),
          (0, y0 + BODY_D - bd / 2, (SLOT["z0"] + SLOT["z1"]) / 2), bevel=0.0)
    p.slab("black_matte", W, BODY_D, H - 0.03 - SLOT["z1"], (0, BODY_YC, SLOT["z1"] + (H - 0.03 - SLOT["z1"]) / 2),
           corner=0.035, csegs=3, bevel=0.004)
    p.slab("black_satin", W + 0.012, BODY_D + 0.012, 0.03, (0, BODY_YC, H - 0.015), corner=0.04, csegs=3, bevel=0.006)
    p.slab("metal_brushed", W + 0.006, BODY_D + 0.006, 0.022, (0, BODY_YC, 0.3), corner=0.038, csegs=3, bevel=0.0)
    # slot mouth bezel (graphite) and the shutter guide channels
    t = 0.012
    p.box("black_satin", (SLOT["w"] + 2 * t, 0.012, t), (0, y0 - 0.004, SLOT["z1"] + t / 2), bevel=0.003)
    for s in (-1, 1):
        p.box("black_satin", (t, 0.012, SLOT["z1"] - SLOT["z0"] + t), (s * (SLOT["w"] / 2 + t / 2), y0 - 0.004,
                                                                       (SLOT["z0"] + SLOT["z1"] + t) / 2), bevel=0.003)
        p.box("metal_dark", (0.008, 0.016, SLOT["z1"] - SLOT["z0"]), (s * (SLOT["w"] / 2 - 0.004), y0 + 0.022,
                                                                     (SLOT["z0"] + SLOT["z1"]) / 2), bevel=0.0)
    # rollers inside the slot, their tops flush with the slot floor
    for k in range(4):
        p.cyl("metal_dark", 0.013, SLOT["w"] - 0.02, (0, y0 + 0.05 + k * 0.06, ROLL_Z - 0.013),
              rot=(0, PI / 2, 0), segs=10)
    # tapered feed lip: a wedge tray under three rollers, rising side guides
    yl = -CHUTE_D / 2
    prism_x(p, "black_satin", [(yl, ROLL_Z - 0.045), (y0, ROLL_Z - 0.12), (y0, ROLL_Z - 0.02), (yl, ROLL_Z - 0.02)],
            -SLOT["w"] / 2, SLOT["w"] / 2)
    for s in (-1, 1):
        x0, x1 = s * (SLOT["w"] / 2), s * (SLOT["w"] / 2 + 0.016)
        prism_x(p, "black_satin", [(yl, ROLL_Z - 0.045), (y0, ROLL_Z - 0.12), (y0, ROLL_Z + 0.05),
                                   (yl, ROLL_Z + 0.012)], min(x0, x1), max(x0, x1))
    for k in range(3):
        p.cyl("metal_dark", 0.013, SLOT["w"] - 0.02, (0, yl + 0.025 + k * 0.045, ROLL_Z - 0.013),
              rot=(0, PI / 2, 0), segs=10)
    # the one red line: the lip's front edge
    p.box("emissive_red", (SLOT["w"] - 0.06, 0.003, 0.004), (0, yl - 0.0015, ROLL_Z - 0.034), bevel=0.0)
    # INTAKE in light-grey print on the head
    zl = (SLOT["z1"] + H - 0.03) / 2
    text(p, "paper", "INTAKE", 0.028, (-0.19, y0 - 0.0015, zl), rot=(PI / 2, 0, 0), res=2, color=PRINT)


def archive_chute_shutter(p):
    """Closed slatted shutter just inside the mouth; the app rolls it up about the slot top."""
    y = BODY_Y0 + 0.022
    n = 5
    h = (SLOT["z1"] - SLOT["z0"]) / n
    for k in range(n):
        p.box("black_satin", (SLOT["w"] - 0.012, 0.01, h - 0.004), (0, y, SLOT["z0"] + h * (k + 0.5)), bevel=0.002)
    p.box("metal_brushed", (SLOT["w"] - 0.012, 0.014, 0.008), (0, y, SLOT["z0"] + 0.004), bevel=0.001)


def archive_chute_slot(p):
    """The glow inside the slot: the back wall and a strip along each inner cheek."""
    y0 = BODY_Y0
    w, z0, z1 = SLOT["w"], SLOT["z0"], SLOT["z1"]
    p.quad("emissive_red_dim", w - 0.01, z1 - z0 - 0.01, (0, y0 + SLOT["depth"] - 0.002, (z0 + z1) / 2))
    d = SLOT["depth"] - 0.06
    for s in (-1, 1):
        p.box("emissive_red_dim", (0.002, d, 0.012), (s * (w / 2 - 0.002), y0 + 0.04 + d / 2, z1 - 0.012), bevel=0.0)


# (kind, builder), in the order props.py appends them after every earlier kind.
KINDS = [
    ("archive_cart", archive_cart),
    ("archive_cart_lit", archive_cart_lit),
    ("archive_cart_display_full", archive_cart_display_full),
    ("archive_cart_display_empty", archive_cart_display_empty),
    ("archive_load_1", archive_load_1),
    ("archive_load_2", archive_load_2),
    ("archive_load_3", archive_load_3),
    ("archive_load_4", archive_load_4),
    ("archive_bay", archive_bay),
    ("archive_bay_led_1", archive_bay_led_1),
    ("archive_bay_led_2", archive_bay_led_2),
    ("archive_bay_led_3", archive_bay_led_3),
    ("archive_bay_led_4", archive_bay_led_4),
    ("archive_chute", archive_chute),
    ("archive_chute_shutter", archive_chute_shutter),
    ("archive_chute_slot", archive_chute_slot),
    ("archive_case", archive_case),
]

# Random seeds of the approved preview renders, so the jitter of the load (case yaw, paper
# strata, LED phases) is exactly what the owner signed off.
SEEDS = {kind: (101 + i) * 7919 for i, (kind, _) in enumerate(KINDS)}

# Every archive kind fits the regular prop budget; the cart is the largest (~3.2k).
TRI_BUDGET = {"archive_cart": 4200, "archive_load_1": 1600, "archive_load_2": 1600, "archive_load_3": 1600,
              "archive_load_4": 1600}
