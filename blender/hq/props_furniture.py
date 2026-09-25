"""Planters, soft seating and tables. Blender frame: metres, Z up, every prop's
front faces -Y (three.js +Z after the Y-up export), origin at the centre of
its footprint on the floor.
"""

import math

from props_plants import ficus_bush, grass_bed

PI = math.pi


# --- planters -------------------------------------------------------------------
def planter_tall(p):
    # Tapered round planter with a rolled lip on a recessed shadow-gap plinth.
    p.cyl("black_matte", 0.19, 0.016, (0, 0, 0.008), segs=32)
    p.lathe("black_matte", [
        (0.0, 0.016), (0.203, 0.016), (0.211, 0.024), (0.244, 0.468), (0.25, 0.478),
        (0.25, 0.494), (0.245, 0.5), (0.231, 0.5), (0.226, 0.494), (0.222, 0.45), (0.0, 0.45),
    ], segs=30, sharp=35.0)
    p.lathe("soil", [(0.0, 0.462), (0.15, 0.459), (0.224, 0.452)], segs=24)
    ficus_bush(p, p.rng, soil_z=0.458, top_z=1.6)


def planter_low(p):
    # Long trough on a shadow-gap plinth, its top inset into a 2 cm rim.
    p.box("black_matte", (1.14, 0.29, 0.02), (0, 0, 0.01), bevel=0.003)
    p.tray("black_matte", (1.2, 0.35, 0.42), (0, 0, 0.23), rim=0.02, depth=0.03)
    p.box("soil", (1.155, 0.305, 0.02), (0, 0, 0.405), bevel=0.0)
    grass_bed(p, p.rng, -0.55, 0.55, -0.12, 0.12, 0.412)


# --- shared chair parts -----------------------------------------------------------
def star_base(p, radius, hub_z=0.075, column_top=0.37):
    p.cyl("metal_dark", 0.045, 0.05, (0, 0, hub_z), segs=16)
    for i in range(5):
        a = PI / 2 + 2 * PI * i / 5
        c, s = math.cos(a), math.sin(a)
        p.box("metal_dark", (radius, 0.042, 0.028), (c * radius / 2, s * radius / 2, hub_z - 0.004),
              rot=(0, 0, a), bevel=0.007)
        tx, ty = c * (radius - 0.02), s * (radius - 0.02)
        p.box("black_matte", (0.03, 0.03, 0.03), (tx, ty, 0.06), rot=(0, 0, a), bevel=0.004)
        p.cyl("black_gloss", 0.026, 0.034, (tx + c * 0.012, ty + s * 0.012, 0.026),
              rot=(PI / 2, 0, a + PI / 2), segs=12)
    p.cyl("metal_dark", 0.024, column_top - hub_z, (0, 0, (column_top + hub_z) / 2), segs=16)
    p.cyl("black_gloss", 0.032, 0.13, (0, 0, hub_z + 0.09), segs=16)


# --- soft seating -----------------------------------------------------------------
def _club_body(p, width, depth, arm_w=0.2, seat_n=1, back_h=0.79, arm_h=0.64):
    """Shared upholstery language for the sofa and the lounge chair."""
    inner_w = width - 2 * arm_w
    leg_x, leg_y = width / 2 - 0.08, depth / 2 - 0.08
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.box("metal_dark", (0.035, 0.035, 0.07), (sx * leg_x, sy * leg_y, 0.035), bevel=0.004)
    # base under the cushions, arms, back frame
    p.rbox("leather", (inner_w, depth - 0.02, 0.2), (0, 0.0, 0.17), r=0.035, splits=(1, 0, 0))
    for sx in (-1, 1):
        p.rbox("leather", (arm_w, depth, arm_h - 0.07), (sx * (width / 2 - arm_w / 2), 0, (arm_h + 0.07) / 2),
               r=0.05, splits=(0, 0, 0), bulge=(0.006, 0.0, 0.004))
    p.rbox("leather", (inner_w, 0.2, back_h - 0.27), (0, depth / 2 - 0.1, (back_h + 0.27) / 2), r=0.05,
           splits=(1, 0, 0))
    # cushions
    cw = inner_w / seat_n
    seat_d = depth - 0.24
    for i in range(seat_n):
        x = -inner_w / 2 + cw * (i + 0.5)
        p.rbox("leather", (cw - 0.008, seat_d, 0.16), (x, -depth / 2 + seat_d / 2 + 0.015, 0.35), r=0.05,
               splits=(1, 1, 0), bulge=(0.0, 0.004, 0.014))
        p.rbox("leather", (cw - 0.012, 0.17, 0.42), (x, depth / 2 - 0.27, 0.645), rot=(-0.2, 0, 0), r=0.06,
               splits=(1, 0, 1), bulge=(0.0, 0.018, 0.0))


def sofa(p):
    _club_body(p, width=2.2, depth=0.9, seat_n=3)


def lounge_chair(p):
    _club_body(p, width=0.88, depth=0.86, arm_w=0.18, seat_n=1, back_h=0.8, arm_h=0.62)


def exec_chair(p):
    """High-back executive chair. Seat top 0.47 with its centre at y=+0.02,
    backrest starting at y=+0.24 (the workstation seat contract)."""
    star_base(p, 0.34, column_top=0.35)
    p.box("black_matte", (0.24, 0.26, 0.05), (0, 0.02, 0.36), bevel=0.008)
    p.rbox("black_matte", (0.54, 0.52, 0.04), (0, 0.02, 0.39), r=0.018, steps=1)
    # channel-tufted seat: three strips running front to back
    for i, x in enumerate((-0.176, 0.0, 0.176)):
        p.rbox("leather", (0.174, 0.5, 0.07), (x, 0.015, 0.435), r=0.03, steps=1, splits=(0, 1, 0),
               bulge=(0.0, 0.0, 0.008))
    # back, pivoted a little behind the seat and reclined
    with p.frame((0, 0.3, 0.5), (-0.14, 0, 0)):
        p.rbox("black_matte", (0.56, 0.045, 0.84), (0, 0.045, 0.42), r=0.02, steps=1, splits=(1, 0, 1))
        for i in range(5):
            p.rbox("leather", (0.52, 0.075, 0.148), (0, -0.01, 0.08 + i * 0.152), r=0.035, steps=1,
                   splits=(1, 0, 0), bulge=(0.0, 0.01, 0.0))
        p.rbox("leather", (0.4, 0.09, 0.14), (0, -0.03, 0.86), r=0.045, steps=1, splits=(1, 0, 0),
               bulge=(0.0, 0.012, 0.0))
        p.box("metal_dark", (0.07, 0.03, 0.2), (0, 0.08, 0.05), bevel=0.006)
    p.box("metal_dark", (0.07, 0.24, 0.025), (0, 0.18, 0.365), bevel=0.006)
    # armrests
    for sx in (-1, 1):
        p.box("metal_dark", (0.16, 0.04, 0.02), (sx * 0.2, 0.1, 0.372), bevel=0.005)
        p.tube("metal_dark", [(sx * 0.29, 0.1, 0.37), (sx * 0.295, 0.1, 0.5), (sx * 0.295, 0.08, 0.63)], 0.013,
               segs=8)
        p.rbox("leather", (0.075, 0.3, 0.035), (sx * 0.295, 0.05, 0.645), r=0.015, steps=1)


def meeting_chair(p):
    """Mid-back conference chair, seat top 0.47, centred on the origin."""
    star_base(p, 0.3, column_top=0.37)
    p.box("black_matte", (0.2, 0.2, 0.04), (0, 0.0, 0.38), bevel=0.006)
    p.rbox("black_matte", (0.5, 0.48, 0.03), (0, 0.0, 0.41), r=0.012, steps=1)
    p.rbox("leather", (0.49, 0.47, 0.06), (0, 0.0, 0.44), r=0.03, steps=2, splits=(1, 1, 0),
           bulge=(0.0, 0.0, 0.01))
    with p.frame((0, 0.24, 0.48), (-0.16, 0, 0)):
        p.rbox("black_matte", (0.48, 0.03, 0.44), (0, 0.035, 0.28), r=0.012, steps=1)
        p.rbox("leather", (0.46, 0.05, 0.42), (0, 0.0, 0.28), r=0.025, steps=2, splits=(1, 0, 1),
               bulge=(0.0, 0.01, 0.0))
        p.box("metal_dark", (0.06, 0.025, 0.18), (0, 0.06, 0.02), bevel=0.005)
    p.box("metal_dark", (0.06, 0.22, 0.022), (0, 0.13, 0.385), bevel=0.005)
    for sx in (-1, 1):
        p.tube("metal_dark", [(sx * 0.2, 0.05, 0.4), (sx * 0.27, 0.05, 0.47), (sx * 0.27, 0.05, 0.6),
                              (sx * 0.27, -0.05, 0.64)], 0.011, segs=8)
        p.rbox("black_matte", (0.05, 0.24, 0.025), (sx * 0.27, 0.0, 0.645), r=0.01, steps=1)


# --- tables -------------------------------------------------------------------------
def coffee_table(p):
    """Smoked black glass on a thin gunmetal frame with a gloss under-shelf."""
    w, d, h = 1.1, 0.6, 0.38
    p.slab("glass_dark", w, d, 0.012, (0, 0, h - 0.006), corner=0.02, bevel=0.003, csegs=3)
    lx, ly = w / 2 - 0.035, d / 2 - 0.035
    t = 0.022
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.box("metal_dark", (t, t, h - 0.012), (sx * lx, sy * ly, (h - 0.012) / 2), bevel=0.003)
    for z in (h - 0.012 - t / 2, 0.09):
        for sy in (-1, 1):
            p.box("metal_dark", (2 * lx - t, t, t), (0, sy * ly, z), bevel=0.003)
        for sx in (-1, 1):
            p.box("metal_dark", (t, 2 * ly - t, t), (sx * lx, 0, z), bevel=0.003)
    p.box("black_gloss", (2 * lx - t, 2 * ly - t, 0.012), (0, 0, 0.09 + t / 2 + 0.006), bevel=0.002)
    # styling: two stacked books and a low bowl on the glass
    p.box("fabric_dark", (0.24, 0.17, 0.028), (0.24, 0.05, h + 0.014), rot=(0, 0, 0.12), bevel=0.003)
    p.box("leather", (0.21, 0.15, 0.022), (0.245, 0.05, h + 0.039), rot=(0, 0, -0.1), bevel=0.003)
    p.lathe("black_gloss", [(0.0, 0.0), (0.05, 0.0), (0.1, 0.03), (0.115, 0.055), (0.108, 0.057),
                            (0.09, 0.034), (0.0, 0.02)], loc=(-0.26, -0.04, h), segs=24, sharp=50)


def meeting_table(p):
    """3.2 x 1.2 m black gloss top on two panel legs with a spine, a gunmetal
    cable port in the middle."""
    h = 0.75
    p.slab("black_gloss", 3.2, 1.2, 0.045, (0, 0, h - 0.0225), corner=0.14, csegs=6, bevel=0.005)
    p.slab("metal_dark", 0.56, 0.12, 0.004, (0, 0, h + 0.001), corner=0.05, csegs=4, bevel=0.001)
    p.box("black_gloss", (0.5, 0.06, 0.002), (0, 0, h + 0.0035), bevel=0.0)
    for sx in (-1, 1):
        x = sx * 1.05
        p.box("black_matte", (0.07, 0.86, 0.02), (x, 0, h - 0.055), bevel=0.004)
        # tapered panel leg, wider at the floor
        p.rbox("black_matte", (0.07, 0.62, h - 0.065), (x, 0, (h - 0.065) / 2), r=0.012, steps=1,
               taper=(1.0, 0.72))
        p.box("metal_dark", (0.075, 0.66, 0.012), (x, 0, 0.006), bevel=0.003)
        # a thin red light line up the outer face of each leg
        p.box("emissive_red", (0.004, 0.006, h - 0.16), (x + sx * 0.0355, 0, (h - 0.065) / 2 - 0.02), bevel=0.0)
    p.box("black_matte", (2.03, 0.1, 0.07), (0, 0, h - 0.1), bevel=0.006)
