"""Build the HQ workstation (desk, monitors, chair, divider) and export a GLB.

Run headless:
  blender -b --factory-startup -P blender/hq/workstation.py -- [options]

Options:
  --out PATH      GLB to write (default public/office-assets/models/hq/workstation.glb)
  --preview DIR   also render preview sheets into DIR
  --no-export     skip the GLB export
  --hero-only     with --preview: render only the hero shot (fast iteration)

Contract (src/features/hq/core/config.ts WORKSTATION). Blender frame: the
sitter faces -Y, so three.js +Z = Blender -Y after the +Y-up export:
  origin = chair centre on the floor = seated character root
  desk top z 0.75, x -0.80..0.80, y -0.36..-1.10
  seat top z 0.47 centred at y +0.02, backrest front from y +0.24
  monitor centres (+-0.58 | 0, -0.95, 1.13), side monitors yawed +-0.45 rad
  keyboard (0, -0.50, 0.765), mouse (-0.30, -0.50, 0.765): +X is the sitter's left

Export layout (one material per mesh, all at the same origin, for instancing):
  ws_desk ws_metal ws_chair ws_screen ws_led ws_glass
  ws_lod1_desk ws_lod1_metal ws_lod1_chair ws_lod1_screen ws_lod1_led
ws_screen holds only the three displays: screen i (0 = sitter's left, +X)
covers u in [i/3, (i+1)/3]; in three.js the uv attribute has v = 1 at the top.
"""

import json
import math
import os
import struct
import sys

import bmesh
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

import workstation_geo as geo  # noqa: E402

V = Vector

# --- contract -------------------------------------------------------------------
DESK_X = 0.80
DESK_FRONT = -0.36
DESK_BACK = -1.10
DESK_TOP = 0.75
DESK_THICK = 0.032
SEAT_TOP = 0.47
SEAT_CY = 0.02
BACK_Y = 0.24
# (x, y, z, yaw) in Blender; yaw is rotation about +Z (= three.js rotY). The
# screens are ~20% larger (readable from the rows) and sit a touch higher on the
# stand; the sim's gaze anchor (config.ts monitors[1].y) stays 1.08, well inside.
MONITORS = [(0.58, -0.95, 1.13, 0.45), (0.0, -0.95, 1.13, 0.0), (-0.58, -0.95, 1.13, -0.45)]
KEYBOARD = (0.0, -0.50)
MOUSE = (-0.30, -0.50)
SCREEN_HW, SCREEN_HH = 0.329, 0.197
MONITOR_HW, MONITOR_HH = 0.336, 0.204
ARM_Y = -0.075  # monitor-local offset of the arm uprights behind each screen
CROSSBAR_Z = (0.866, 0.888)

# HQ_THEME (config.ts) colours used by the exported materials.
THEME = {
    "deskTop": "#0d0d0f",
    "metal": "#1a1b1e",
    "glass": "#1b2126",
    "accent": "#ff1a1a",
    "screenText": "#ff3b30",
    "screenBackground": "#070203",
    "wallPanel": "#101013",
}

BUCKET_OUT = {
    "desk": ("ws_desk", "ws_desk"),
    "metal": ("ws_metal", "ws_metal"),
    "chair": ("ws_chair", "ws_chair"),
    "screen": ("ws_screen", "ws_screen"),
    "led": ("ws_led", "ws_led"),
    "glass": ("ws_glass", "ws_glass"),
    "lod1_desk": ("ws_lod1_desk", "ws_desk"),
    "lod1_metal": ("ws_lod1_metal", "ws_metal"),
    "lod1_chair": ("ws_lod1_chair", "ws_chair"),
    "lod1_screen": ("ws_lod1_screen", "ws_screen"),
    "lod1_led": ("ws_lod1_led", "ws_led"),
}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"out": os.path.join(ROOT, "public", "office-assets", "models", "hq", "workstation.glb"),
            "preview": None, "export": True, "hero_only": False, "parts": False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out":
            opts["out"] = argv[i + 1]
            i += 1
        elif a == "--preview":
            opts["preview"] = argv[i + 1]
            i += 1
        elif a == "--no-export":
            opts["export"] = False
        elif a == "--parts":
            opts["parts"] = True
        elif a == "--hero-only":
            opts["hero_only"] = True
        i += 1
    return opts


def srgb(hexstr, alpha=1.0):
    h = hexstr.lstrip("#")
    out = []
    for k in range(3):
        c = int(h[2 * k:2 * k + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, alpha)


# --- materials ------------------------------------------------------------------
def make_material(name, base, rough, metal=0.0, emission=None, strength=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = base
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    # Keep IOR/specular at glTF defaults so no KHR_materials_ior/specular is
    # written (three.js would switch to the costlier MeshPhysicalMaterial).
    p.inputs["IOR"].default_value = 1.5
    p.inputs["Specular IOR Level"].default_value = 0.5
    if emission is not None:
        p.inputs["Emission Color"].default_value = emission
        p.inputs["Emission Strength"].default_value = strength
    # Every part is a closed or front-facing shell: single-sided in glTF.
    m.use_backface_culling = True
    if alpha < 1.0:
        p.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    return m


def make_materials():
    return {
        "ws_desk": make_material("ws_desk", srgb(THEME["deskTop"]), 0.16),
        "ws_metal": make_material("ws_metal", srgb(THEME["metal"]), 0.34, metal=0.9),
        "ws_chair": make_material("ws_chair", srgb(THEME["wallPanel"]), 0.62),
        "ws_screen": make_material("ws_screen", srgb(THEME["screenBackground"]), 0.12,
                                   emission=srgb(THEME["screenText"]), strength=0.35),
        "ws_led": make_material("ws_led", srgb(THEME["accent"]), 0.4,
                                emission=srgb(THEME["accent"]), strength=6.0),
        "ws_glass": make_material("ws_glass", srgb(THEME["glass"]), 0.04, alpha=0.32),
    }


# --- desk -------------------------------------------------------------------------
def build_desk(P):
    z0 = DESK_TOP - DESK_THICK
    P.add("desk", geo.box(-DESK_X, DESK_X, DESK_BACK, DESK_FRONT, z0, DESK_TOP), "desk_top",
          bevel=0.004, segments=3)

    # Blade sled legs: a closed trapezoid of 20 x 50 mm flat steel under each end.
    for s in (1, -1):
        x = s * 0.72
        pts = [(x, -1.06, 0.025), (x, -0.40, 0.025), (x, -0.465, z0 - 0.025), (x, -1.00, z0 - 0.025)]
        path = geo.round_path(pts, 0.055, 2, closed=True)
        P.add("metal", geo.sweep(path, geo.rect_profile(0.025, 0.010, 0.004), (1, 0, 0), closed=True),
              "sled", sharp_deg=50)
    P.add("metal", geo.box(-0.71, 0.71, -0.965, -0.935, 0.690, z0), "back_beam", bevel=0.002, segments=1)

    # Cable tray hanging under the back edge, with a cable loom inside.
    P.add("metal", geo.box(-0.5, 0.5, -1.045, -0.905, 0.618, 0.622), "tray_bottom", smooth=False)
    P.add("metal", geo.box(-0.5, 0.5, -0.909, -0.905, 0.618, 0.672), "tray_front", smooth=False)
    P.add("metal", geo.box(-0.5, 0.5, -1.045, -1.041, 0.618, 0.672), "tray_back", smooth=False)
    for x in (-0.42, 0.42):
        for y in (-1.043, -0.907):
            P.add("metal", geo.cylinder(0.004, 0.672, z0, 6, x=x, y=y), "tray_rod", sharp_deg=60)
    loom = [(-0.46, -0.985, 0.652), (-0.2, -0.975, 0.636), (0.2, -0.975, 0.636), (0.46, -0.985, 0.652),
            (0.52, -0.99, 0.60), (0.53, -0.96, 0.445)]
    P.add("chair", geo.sweep(geo.round_path(loom, 0.05, 3), geo.circle_profile(0.011, 6), (0, 0, 1)),
          "loom", sharp_deg=70)

    # Glass divider on the back edge. It stays inside the desk footprint so two
    # desks placed back to back never share a coplanar face.
    fy0, fy1 = DESK_BACK + 0.002, DESK_BACK + 0.018
    P.add("desk", geo.ring_xz((-DESK_X, DESK_X, DESK_TOP, 1.10), (-0.788, 0.788, 0.768, 1.088), fy0, fy1),
          "divider_frame", bevel=0.0015, segments=1)
    P.add("glass", geo.box(-0.790, 0.790, -1.093, -1.087, 0.766, 1.090), "glass", smooth=False)

    # LED strips: under the front edge and on the desk along the divider base.
    P.add("led", geo.box(-0.78, 0.78, DESK_FRONT - 0.014, DESK_FRONT - 0.002, z0 - 0.012, z0), "led_front",
          smooth=False)
    P.add("led", geo.box(-0.786, 0.786, fy1, fy1 + 0.005, DESK_TOP, DESK_TOP + 0.005), "led_back",
          smooth=False)


def build_monitors(P):
    for i, (mx, my, mz, yaw) in enumerate(MONITORS):
        mat = geo.trs((mx, my, mz), rz=yaw)
        P.add("metal", geo.ring_xz((-MONITOR_HW, MONITOR_HW, -MONITOR_HH, MONITOR_HH),
                                   (-SCREEN_HW, SCREEN_HW, -SCREEN_HH, SCREEN_HH), -0.009, 0.002),
              "bezel", matrix=mat, bevel=0.0012, segments=1)
        P.add("metal", geo.box(-(MONITOR_HW - 0.004), MONITOR_HW - 0.004, -0.024, -0.008,
                               -(MONITOR_HH - 0.004), MONITOR_HH - 0.004), "panel", matrix=mat,
              bevel=0.004, segments=1)
        P.add("metal", geo.frustum(0, 0, -0.024, -0.044, (0.21, -0.13, 0.10), (0.14, -0.085, 0.055)),
              "shell", matrix=mat, bevel=0.004, segments=2)
        # Thin light line on the back shell: the room camera mostly sees monitor backs.
        P.add("led", geo.box(-0.07, 0.07, -0.0458, -0.0436, -0.067, -0.062), "mon_back_led", matrix=mat,
              smooth=False)
        P.add("metal", geo.box(-0.04, 0.04, -0.050, -0.043, -0.04, 0.04), "vesa", matrix=mat,
              smooth=False)
        P.add("metal", geo.cylinder_axis(0.011, (0, -0.049, 0), (0, ARM_Y, 0), 8), "stub", matrix=mat,
              sharp_deg=50)
        if yaw != 0.0:
            P.add("metal", geo.cylinder(0.012, CROSSBAR_Z[0] - mz, 0.02, 12, y=ARM_Y), "upright",
                  matrix=mat, sharp_deg=50)
            P.add("metal", geo.cylinder(0.016, -0.022, 0.022, 12, y=ARM_Y), "knuckle", matrix=mat,
                  sharp_deg=50)
        P.add("screen", screen_quad(i, SCREEN_HW, SCREEN_HH, 0.0), "screen", matrix=mat, smooth=False,
              recalc=False)

    # Pole on a desk grommet, crossbar under the screens (a straight bar at
    # screen height would pierce the yawed side monitors, whose inner halves
    # reach back past y -1.07).
    py = MONITORS[1][1] + ARM_Y
    P.add("metal", geo.cylinder(0.042, DESK_TOP, DESK_TOP + 0.008, 16, x=0, y=py), "grommet",
          bevel=0.002, segments=1)
    P.add("metal", geo.cylinder(0.017, DESK_TOP, 1.155, 12, x=0, y=py), "pole", sharp_deg=50)
    P.add("metal", geo.cylinder(0.021, 1.108, 1.152, 12, x=0, y=py), "pole_knuckle", bevel=0.002, segments=1)
    P.add("metal", geo.box(-0.628, 0.628, py - 0.011, py + 0.019, CROSSBAR_Z[0], CROSSBAR_Z[1]), "crossbar",
          bevel=0.004, segments=2)


def screen_quad(i, hw, hh, y):
    """One display: a quad at monitor-local y facing +Y. u runs left to right as
    the sitter sees it (their left = +X); v is stored flipped because the glTF
    exporter writes 1 - v, so three.js sees v = 1 at the top edge."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    corners = [((hw, y, -hh), (0.0, 1.0)), ((-hw, y, -hh), (1.0, 1.0)),
               ((-hw, y, hh), (1.0, 0.0)), ((hw, y, hh), (0.0, 0.0))]
    f = bm.faces.new([bm.verts.new(c) for c, _ in corners])
    for loop, (_, (ul, vb)) in zip(f.loops, corners):
        loop[uv].uv = ((i + ul) / 3.0, vb)
    return bm


def build_peripherals(P):
    kx, ky = KEYBOARD
    # Low-profile keyboard: wedge base, 83 keys in a 16u grid (Esc at the sitter's left, +X).
    hx, hy = 0.160, 0.065
    zb, zf = 0.7635, 0.7595  # base top at the back / front edge
    base = geo.hexa([
        (kx - hx, ky - hy, 0.751), (kx + hx, ky - hy, 0.751), (kx + hx, ky + hy, 0.751), (kx - hx, ky + hy, 0.751),
        (kx - hx, ky - hy, zb), (kx + hx, ky - hy, zb), (kx + hx, ky + hy, zf), (kx - hx, ky + hy, zf),
    ])
    P.add("desk", base, "kb_base", bevel=0.002, segments=2)
    u = 0.0185
    rows = [
        (0.75, [1] * 16),
        (1, [1] * 13 + [2, 1]),
        (1, [1.5] + [1] * 12 + [1.5, 1]),
        (1, [1.75] + [1] * 11 + [2.25, 1]),
        (1, [2.25] + [1] * 10 + [1.75, 1, 1]),
        (1, [1.25] * 3 + [6.25] + [1] * 6),
    ]
    keys = bmesh.new()
    y = ky - hy + 0.010
    for depth_u, widths in rows:
        d = depth_u * u
        yc = y + d / 2
        zbase = zb + (zf - zb) * (yc - (ky - hy)) / (2 * hy) - 0.001
        x = kx + 8 * u
        for w in widths:
            kw = w * u
            xc = x - kw / 2
            ax, ay = kw / 2 - 0.0017, d / 2 - 0.0017
            tx, ty = ax - 0.0014, ay - 0.0014
            zt = zbase + 0.0065
            geo.hexa([
                (xc - ax, yc - ay, zbase), (xc + ax, yc - ay, zbase), (xc + ax, yc + ay, zbase), (xc - ax, yc + ay, zbase),
                (xc - tx, yc - ty, zt), (xc + tx, yc - ty, zt), (xc + tx, yc + ty, zt), (xc - tx, yc + ty, zt),
            ], open_bottom=True, bm=keys)
            x -= kw
        y += d + (0.004 if depth_u < 1 else 0.0)
    P.add("desk", keys, "keys", sharp_deg=30)

    mx, my = MOUSE
    P.add("chair", geo.prism(geo.rrect_outline(0.11, 0.095, 0.014, 3, mx, my), DESK_TOP, DESK_TOP + 0.0035),
          "mousepad", sharp_deg=60)
    P.add("desk", geo.half_ellipsoid(0.031, 0.058, 0.034, mx, my, DESK_TOP + 0.0035, 16, 6, nose=0.012),
          "mouse", sharp_deg=70)

    # Compact PC tower under the desk on the sitter's left, light line facing them.
    tx0, tx1, ty0, ty1 = 0.435, 0.625, -0.99, -0.59
    P.add("desk", geo.box(tx0, tx1, ty0, ty1, 0.018, 0.44), "tower", bevel=0.006, segments=3)
    for x in (tx0 + 0.025, tx1 - 0.025):
        for y in (ty0 + 0.03, ty1 - 0.03):
            P.add("metal", geo.cylinder(0.012, 0.0, 0.019, 6, x=x, y=y), "tower_foot", sharp_deg=50)
    P.add("metal", geo.cylinder(0.008, 0.438, 0.443, 16, x=0.53, y=ty1 - 0.03), "power_button",
          sharp_deg=50)
    P.add("led", geo.box(tx0 + 0.02, tx0 + 0.026, ty1 - 0.001, ty1 + 0.003, 0.06, 0.40), "tower_led",
          smooth=False)


# --- chair ------------------------------------------------------------------------
def back_surface(u01, v01):
    """Mesh backrest: front surface, lumbar peak at z 0.62 exactly on y BACK_Y,
    reclining above it and wrapping slightly around the sitter."""
    u = 2 * u01 - 1
    z = 0.52 + 0.56 * v01
    hw = 0.195 + 0.032 * math.sin(math.pi * v01) - 0.012 * v01
    dz = z - 0.62
    yc = BACK_Y + (0.16 * dz + 0.08 * dz * dz if dz > 0 else 0.25 * dz * dz)
    return V((u * hw, yc - 0.015 * u * u, z))


def seat_cage(u, v, w):
    x = (u - 0.5) * 0.53
    y = -0.235 + 0.50 * v
    # Chunkier cushion: the base drops (thicker slab) while the top stays at
    # SEAT_TOP (w = 1 gives SEAT_TOP + 0.004 regardless, then snap_top pins 0.47).
    z = 0.386 + (SEAT_TOP + 0.004 - 0.386) * w
    if w > 0.5:
        if u in (0.0, 1.0):
            z += 0.010  # side bolsters
        if v == 0.0:
            z -= 0.028  # waterfall front edge
            y += 0.012
        elif v == 1.0:
            z -= 0.006
    elif v == 0.0:
        z += 0.012
    return (x, y, z)


def build_chair(P):
    cy = 0.04  # gas lift axis, slightly behind the seat centre like a real tilt mechanism
    seat = P.add("chair", geo.cage(4, 4, 1, seat_cage), "seat", subsurf=1, sharp_deg=None)
    snap_top(seat, SEAT_TOP, (-0.12, 0.12, -0.08, 0.12))
    P.add("metal", geo.box(-0.225, 0.225, -0.19, 0.225, 0.392, 0.406), "seat_pan", bevel=0.005, segments=2)
    P.add("metal", geo.box(-0.10, 0.10, -0.07, 0.16, 0.352, 0.394), "mechanism", bevel=0.005, segments=2)
    P.add("metal", geo.cylinder_axis(0.006, (-0.10, -0.02, 0.37), (-0.20, -0.06, 0.365), 8), "lever",
          sharp_deg=60)
    P.add("metal", geo.cylinder(0.030, 0.10, 0.25, 16, x=0, y=cy), "gas_shroud", bevel=0.002, segments=1)
    P.add("metal", geo.cylinder(0.019, 0.24, 0.355, 16, x=0, y=cy), "gas_piston", sharp_deg=50)
    P.add("metal", geo.cylinder(0.046, 0.074, 0.122, 20, r2=0.038, x=0, y=cy), "hub", bevel=0.004, segments=1)

    for k in range(5):
        mat = geo.trs((0, cy, 0), rz=math.radians(90 + 72 * k))
        leg = geo.hexa([
            (0.03, -0.024, 0.078), (0.30, -0.016, 0.062), (0.30, 0.016, 0.062), (0.03, 0.024, 0.078),
            (0.03, -0.024, 0.118), (0.30, -0.016, 0.088), (0.30, 0.016, 0.088), (0.03, 0.024, 0.118),
        ])
        P.add("metal", leg, "leg", matrix=mat, bevel=0.004, segments=1)
        P.add("metal", geo.box(0.274, 0.306, -0.009, 0.009, 0.036, 0.064), "caster_fork", matrix=mat,
              smooth=False)
        for y0, y1 in ((-0.024, -0.010), (0.010, 0.024)):
            P.add("metal", geo.cylinder_axis(0.026, (0.29, y0, 0.026), (0.29, y1, 0.026), 10), "wheel",
                  matrix=mat, sharp_deg=50)

    # Backrest: mesh panel in a steel ring, lumbar band and spine behind it.
    P.add("chair", geo.surface_slab(back_surface, 6, 8, 0.011, (0, 1, 0.2)), "back_mesh", sharp_deg=None)
    outline = ([back_surface(i / 2, 0) for i in range(3)] + [back_surface(1, j / 4) for j in range(1, 5)]
               + [back_surface(1 - i / 2, 1) for i in range(1, 3)] + [back_surface(0, 1 - j / 4) for j in range(1, 4)])
    ring = geo.round_path(outline, 0.07, 2, closed=True)
    P.add("metal", geo.sweep(ring, geo.rect_profile(0.012, 0.011, 0.003), (0, 1, -0.25), closed=True),
          "back_frame", sharp_deg=50)
    band = lambda u, v: back_surface(0.1 + 0.8 * u, 0.13 + 0.10 * v) + V((0, 0.011, 0))  # noqa: E731
    P.add("metal", geo.surface_slab(band, 6, 1, 0.006, (0, 1, 0)), "lumbar", sharp_deg=None)
    spine = [(0, 0.10, 0.383), (0, 0.285, 0.383), (0, 0.300, 0.52), (0, 0.272, 0.66)]
    P.add("metal", geo.sweep(geo.round_path(spine, 0.06, 3), geo.rect_profile(0.009, 0.03, 0.003), (1, 0, 0)),
          "spine", sharp_deg=50)

    top = back_surface(0.5, 1.0)
    P.add("metal", geo.sweep(geo.round_path([(0, top.y + 0.004, top.z - 0.02), (0, top.y + 0.04, top.z + 0.03),
                                            (0, top.y + 0.058, top.z + 0.08)], 0.03, 3),
                             geo.rect_profile(0.007, 0.024, 0.002), (1, 0, 0)), "head_stem", sharp_deg=50)

    def head_cage(u, v, w):
        x = (u - 0.5) * 0.30
        y = top.y + 0.022 + 0.05 * v - 0.028 * (2 * u - 1) ** 2
        z = top.z + 0.045 + 0.135 * w
        return (x, y, z)

    P.add("chair", geo.cage(3, 1, 2, head_cage), "headrest", subsurf=1, sharp_deg=None)

    # Armrests: steel L from under the seat, leather pad on top.
    for s in (1, -1):
        path = [(s * 0.10, 0.10, 0.378), (s * 0.275, 0.10, 0.378), (s * 0.275, 0.075, 0.642)]
        P.add("metal", geo.sweep(geo.round_path(path, 0.06, 3), geo.rect_profile(0.012, 0.018, 0.003),
                                 (0, 1, 0)), "arm_support", sharp_deg=50)

        def pad_cage(u, v, w, s=s):
            return (s * 0.275 + (u - 0.5) * 0.08, -0.09 + 0.27 * v, 0.636 + 0.034 * w)

        P.add("chair", geo.cage(1, 3, 1, pad_cage), "arm_pad", subsurf=1, sharp_deg=None)


def snap_top(ob, target_z, region):
    """Move a subdivided part so its top inside region (x0, x1, y0, y1) is target_z."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    x0, x1, y0, y1 = region
    zs = [v.co.z for v in me.vertices if x0 < v.co.x < x1 and y0 < v.co.y < y1]
    ev.to_mesh_clear()
    if zs:
        ob.location.z += target_z - max(zs)


# --- LOD1 ---------------------------------------------------------------------------
def build_lod1(P):
    z0 = DESK_TOP - DESK_THICK
    P.add("lod1_desk", geo.box(-DESK_X, DESK_X, DESK_BACK, DESK_FRONT, z0, DESK_TOP), "l_top",
          bevel=0.005, segments=1)
    P.add("lod1_desk", geo.ring_xz((-DESK_X, DESK_X, DESK_TOP, 1.10), (-0.788, 0.788, 0.768, 1.088),
                                   DESK_BACK + 0.002, DESK_BACK + 0.018), "l_frame", smooth=False)
    P.add("lod1_desk", geo.box(-0.16, 0.16, -0.565, -0.435, 0.751, 0.768), "l_kb", smooth=False)
    P.add("lod1_desk", geo.box(-0.331, -0.269, -0.558, -0.442, DESK_TOP, 0.785), "l_mouse", smooth=False)
    P.add("lod1_desk", geo.box(0.435, 0.625, -0.99, -0.59, 0.0, 0.44), "l_tower", bevel=0.006, segments=1)

    for s in (1, -1):
        x = s * 0.72
        pts = [(x, -1.06, 0.025), (x, -0.40, 0.025), (x, -0.465, z0 - 0.025), (x, -1.00, z0 - 0.025)]
        P.add("lod1_metal", geo.sweep(geo.round_path(pts, 0.05, 1, closed=True), geo.rect_profile(0.025, 0.010),
                                              (1, 0, 0), closed=True), "l_sled", smooth=False)
    P.add("lod1_metal", geo.box(-0.71, 0.71, -0.965, -0.935, 0.690, z0), "l_beam", smooth=False)
    for i, (mx, my, mz, yaw) in enumerate(MONITORS):
        mat = geo.trs((mx, my, mz), rz=yaw)
        P.add("lod1_metal", geo.box(-MONITOR_HW, MONITOR_HW, -0.022, -0.006, -MONITOR_HH, MONITOR_HH), "l_mon",
              matrix=mat, bevel=0.003, segments=1)
        P.add("lod1_metal", geo.box(-0.16, 0.16, -0.042, -0.022, -0.10, 0.07), "l_shell", matrix=mat,
              smooth=False)
        if yaw != 0.0:
            P.add("lod1_metal", geo.box(-0.011, 0.011, ARM_Y - 0.011, ARM_Y + 0.011, CROSSBAR_Z[0] - mz, 0.02),
                  "l_upright", matrix=mat, smooth=False)
        P.add("lod1_screen", screen_quad(i, MONITOR_HW - 0.006, MONITOR_HH - 0.006, 0.0), "l_screen", matrix=mat,
              smooth=False, recalc=False)
    py = MONITORS[1][1] + ARM_Y
    P.add("lod1_metal", geo.cylinder(0.018, DESK_TOP, 1.15, 8, x=0, y=py), "l_pole", sharp_deg=50)
    P.add("lod1_metal", geo.box(-0.628, 0.628, py - 0.011, py + 0.019, CROSSBAR_Z[0], CROSSBAR_Z[1]),
          "l_crossbar", smooth=False)

    cy = 0.04
    P.add("lod1_metal", geo.cylinder(0.03, 0.07, 0.40, 6, x=0, y=cy), "l_gas", sharp_deg=50)
    P.add("lod1_metal", geo.box(-0.10, 0.10, -0.07, 0.16, 0.352, 0.405), "l_mech", smooth=False)
    for k in range(5):
        mat = geo.trs((0, cy, 0), rz=math.radians(90 + 72 * k))
        P.add("lod1_metal", geo.hexa([
            (0.02, -0.024, 0.078), (0.31, -0.016, 0.04), (0.31, 0.016, 0.04), (0.02, 0.024, 0.078),
            (0.02, -0.024, 0.118), (0.31, -0.016, 0.088), (0.31, 0.016, 0.088), (0.02, 0.024, 0.118),
        ]), "l_leg", matrix=mat, smooth=False)
        P.add("lod1_metal", geo.box(0.27, 0.31, -0.022, 0.022, 0.0, 0.05), "l_caster", matrix=mat, smooth=False)
    for s in (1, -1):
        P.add("lod1_metal", geo.box(s * 0.275 - 0.012, s * 0.275 + 0.012, 0.06, 0.10, 0.38, 0.64), "l_arm",
              smooth=False)
        P.add("lod1_chair", geo.box(s * 0.275 - 0.04, s * 0.275 + 0.04, -0.09, 0.18, 0.64, 0.67), "l_pad",
              smooth=False)
    P.add("lod1_chair", geo.box(-0.25, 0.25, -0.22, 0.26, 0.386, SEAT_TOP), "l_seat", bevel=0.012, segments=1)
    P.add("lod1_chair", geo.surface_slab(back_surface, 4, 4, 0.02, (0, 1, 0.2)), "l_back", sharp_deg=45)
    top = back_surface(0.5, 1.0)
    P.add("lod1_chair", geo.box(-0.15, 0.15, top.y + 0.02, top.y + 0.07, top.z + 0.045, top.z + 0.18),
          "l_head", bevel=0.012, segments=1)
    P.add("lod1_chair", geo.box(-0.41, -0.19, -0.595, -0.405, DESK_TOP, DESK_TOP + 0.0035), "l_pad",
          smooth=False)

    P.add("lod1_led", geo.box(-0.78, 0.78, DESK_FRONT - 0.014, DESK_FRONT - 0.002, z0 - 0.012, z0), "l_led_f",
          smooth=False)
    P.add("lod1_led", geo.box(-0.786, 0.786, DESK_BACK + 0.018, DESK_BACK + 0.023, DESK_TOP, DESK_TOP + 0.005),
          "l_led_b", smooth=False)
    P.add("lod1_led", geo.box(0.455, 0.461, -0.591, -0.587, 0.06, 0.40), "l_led_pc", smooth=False)


# --- assembly -----------------------------------------------------------------------
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def build_all(scene, parts_report=False):
    coll = bpy.data.collections.new("workstation")
    scene.collection.children.link(coll)
    P = geo.Parts(coll)
    build_desk(P)
    build_monitors(P)
    build_peripherals(P)
    build_chair(P)
    build_lod1(P)
    if parts_report:
        dg = bpy.context.evaluated_depsgraph_get()
        per = {}
        for bucket, objs in P.buckets.items():
            for o in objs:
                me = o.evaluated_get(dg).to_mesh()
                me.calc_loop_triangles()
                key = f"{bucket}/{o.name.split('.')[0]}"
                per[key] = per.get(key, 0) + len(me.loop_triangles)
                o.evaluated_get(dg).to_mesh_clear()
        for key, n in sorted(per.items(), key=lambda kv: -kv[1]):
            print(f"[parts] {key:28s}{n:6d}")
    mats = make_materials()
    final = {}
    for bucket, objs in P.buckets.items():
        name, mat_name = BUCKET_OUT[bucket]
        ob = geo.join_bucket(objs, name)
        me = ob.data
        me.materials.clear()
        me.materials.append(mats[mat_name])
        if "screen" not in bucket:
            while me.uv_layers:
                me.uv_layers.remove(me.uv_layers[0])
        final[name] = ob
    return final, mats


def report(final):
    print("[tris] mesh              triangles")
    lod0 = lod1 = 0
    for name in sorted(final):
        n = geo.tri_count(final[name])
        if "lod1" in name:
            lod1 += n
        else:
            lod0 += n
        print(f"[tris] {name:18s}{n:6d}")
    print(f"[tris] LOD0 total {lod0}, LOD1 total {lod1}")
    for name in ("ws_desk", "ws_chair", "ws_metal"):
        ob = final[name]
        xs = [v.co for v in ob.data.vertices]
        lo = V((min(c.x for c in xs), min(c.y for c in xs), min(c.z for c in xs)))
        hi = V((max(c.x for c in xs), max(c.y for c in xs), max(c.z for c in xs)))
        print(f"[bounds] {name}: {tuple(round(c, 3) for c in lo)} .. {tuple(round(c, 3) for c in hi)}")


def export_glb(path, final):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for ob in final.values():
        ob.select_set(True)
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=False,
        export_cameras=False,
        export_lights=False,
        export_draco_mesh_compression_enable=False,
        export_vertex_color="NONE",
    )
    while True:
        try:
            bpy.ops.export_scene.gltf(**kwargs)
            break
        except TypeError as e:  # option renamed in this Blender version
            bad = [k for k in kwargs if k in str(e) and k != "filepath"]
            if not bad:
                raise
            print("[export] dropping unknown option", bad[0])
            kwargs.pop(bad[0])
    bpy.ops.object.select_all(action="DESELECT")
    print(f"[export] {path} {os.path.getsize(path) / 1024:.1f} KiB")


def verify_glb(path):
    """Read the GLB back: node layout, materials, triangle counts and the
    screen UV orientation as three.js will see it."""
    data = open(path, "rb").read()
    jlen = struct.unpack_from("<I", data, 12)[0]
    j = json.loads(data[20:20 + jlen])
    bin0 = 20 + jlen + 8

    def read(acc_i):
        acc = j["accessors"][acc_i]
        bv = j["bufferViews"][acc["bufferView"]]
        n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
        fmt = {5126: "f", 5123: "H", 5125: "I", 5121: "B"}[acc["componentType"]]
        size = struct.calcsize(fmt)
        stride = bv.get("byteStride", size * n)
        off = bin0 + bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        return [struct.unpack_from("<" + fmt * n, data, off + k * stride) for k in range(acc["count"])]

    print("[glb] extensionsUsed:", j.get("extensionsUsed", []))
    print("[glb] scene roots:", [j["nodes"][i]["name"] for i in j["scenes"][0]["nodes"]])
    for node in j["nodes"]:
        extra = [k for k in ("children", "translation", "rotation", "scale", "matrix") if k in node]
        mesh = j["meshes"][node["mesh"]]
        prims = mesh["primitives"]
        tris = sum(j["accessors"][p["indices"]]["count"] // 3 for p in prims)
        mats = [j["materials"][p["material"]]["name"] for p in prims]
        print(f"[glb] node {node['name']:16s} prims={len(prims)} tris={tris:5d} mat={mats} "
              f"attrs={sorted(prims[0]['attributes'])} {'EXTRA ' + str(extra) if extra else ''}")
    for m in j["materials"]:
        print("[glb] material", m["name"], {k: v for k, v in m.items() if k != "name"})
    for node in j["nodes"]:
        if node["name"] not in ("ws_screen", "ws_lod1_screen"):
            continue
        prim = j["meshes"][node["mesh"]]["primitives"][0]
        pos = read(prim["attributes"]["POSITION"])
        uv = read(prim["attributes"]["TEXCOORD_0"])
        ok = True
        for i in range(3):
            lo_u, hi_u = i / 3, (i + 1) / 3
            # Group by the nearest monitor (x = +0.58, 0, -0.58 in both frames).
            pts = [(p, t) for p, t in zip(pos, uv)
                   if min(range(3), key=lambda k: abs(p[0] - MONITORS[k][0])) == i]
            ymax = max(p[1] for p, _ in pts)
            top_v = sorted({round(t[1], 4) for p, t in pts if abs(p[1] - ymax) < 1e-4})
            # three.js: the sitter looks toward +Z, so their left is +X: the
            # u = i/3 edge must have the larger x.
            x_lo = sum(p[0] for p, t in pts if abs(t[0] - lo_u) < 1e-4) / 2
            x_hi = sum(p[0] for p, t in pts if abs(t[0] - hi_u) < 1e-4) / 2
            ctr = [round(sum(p[k] for p, _ in pts) / len(pts), 3) for k in range(3)]
            good = (top_v == [1.0] and x_lo > x_hi and len(pts) == 4
                    and all(lo_u - 1e-4 <= t[0] <= hi_u + 1e-4 for _, t in pts))
            ok &= good
            print(f"[glb] {node['name']} screen {i}: centre {ctr} top-edge v={top_v} "
                  f"x(u={lo_u:.2f})={x_lo:+.3f} x(u={hi_u:.2f})={x_hi:+.3f} {'ok' if good else 'BAD'}")
        print(f"[glb] {node['name']} uv check:", "OK" if ok else "FAILED")


def main():
    opts = parse_args()
    scene = reset_scene()
    final, mats = build_all(scene, opts["parts"])
    report(final)
    if opts["export"]:
        export_glb(opts["out"], final)
        verify_glb(opts["out"])
    if opts["preview"]:
        import workstation_preview as preview
        preview.render_all(scene, final, mats, opts["preview"], ROOT, hero_only=opts["hero_only"])


main()
