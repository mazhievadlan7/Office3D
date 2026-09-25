"""Server rack, server pillar, data monolith, coffee bar, AM7's shelf, wall
screen and floor lamp (AM7's desk and chair are in props_exec.py). Blender
frame: metres, Z up, front faces -Y, origin at the centre of the footprint on
the floor.

LED convention for "emissive_red" (as three.js reads the GLB): every LED quad
carries a constant UV, (phase, 1) for a blinking LED with a random phase in
[0, 1) and (0, 0) for steady light (strips, accent lines, power LEDs), so a
shader can blink the rack LEDs individually without extra attributes.
"""

import math

from props_lib import led_uv

PI = math.pi
U = 0.04445  # one rack unit


def _led(p, w, h, loc, blink=True, rot=None):
    p.quad("emissive_red", w, h, loc, rot=rot, uv=led_uv(p.rng.random(), blink))


# --- server rack --------------------------------------------------------------------
def server_rack(p):
    W, D = 0.6, 1.1
    rng = p.rng
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.cyl("metal_dark", 0.022, 0.05, (sx * 0.24, sy * 0.47, 0.025), segs=10)
    p.box("black_matte", (W, D, 0.05), (0, 0, 0.075), bevel=0.004)
    p.box("black_matte", (W, D, 0.05), (0, 0, 2.075), bevel=0.005)
    for sx in (-1, 1):
        p.box("black_matte", (0.02, D - 0.04, 1.95), (sx * (W / 2 - 0.01), 0, 1.075), bevel=0.003)
    p.box("black_matte", (W - 0.04, 0.02, 1.95), (0, D / 2 - 0.01, 1.075), bevel=0.003)
    # roof fans
    for y in (-0.22, 0.22):
        p.ring("metal_dark", 0.078, 0.098, 2.1, 2.108, loc=(0, y, 0), segs=24)
        p.cyl("black_gloss", 0.078, 0.004, (0, y, 2.102), segs=24)
        p.cyl("metal_dark", 0.022, 0.008, (0, y, 2.104), segs=12)
        for k in range(3):
            p.box("metal_dark", (0.15, 0.006, 0.003), (0, y, 2.105), rot=(0, 0, k * PI / 3), bevel=0.0)

    # front door: gunmetal frame, smoked glass with a dot-frit band that fades
    # toward the middle (the "perforated" front), a pull handle and a red line.
    fy = -D / 2 + 0.01
    for sx in (-1, 1):
        p.box("metal_dark", (0.03, 0.02, 1.95), (sx * (W / 2 - 0.015), fy, 1.075), bevel=0.003)
    for z in (0.115, 2.035):
        p.box("metal_dark", (W - 0.06, 0.02, 0.03), (0, fy, z), bevel=0.003)
    p.box("glass_dark", (W - 0.058, 0.006, 1.892), (0, fy, 1.075), bevel=0.0)
    gy = fy - 0.0035
    cols, pitch = 17, 0.03
    for band_z, rows, down in ((2.0, 8, True), (0.15, 6, False)):
        for r in range(rows):
            s = 0.016 * (1.0 - r / rows) ** 0.9
            if s < 0.003:
                continue
            z = band_z - r * pitch if down else band_z + r * pitch
            for c in range(cols):
                x = (c - (cols - 1) / 2) * pitch + (pitch / 2 if r % 2 else 0)
                if abs(x) > 0.25:
                    continue
                p.quad("black_gloss", s, s, (x, gy, z))
    p.box("metal_dark", (0.014, 0.022, 0.34), (W / 2 - 0.05, fy - 0.03, 1.12), bevel=0.004)
    for z in (0.97, 1.27):
        p.box("metal_dark", (0.012, 0.03, 0.012), (W / 2 - 0.05, fy - 0.015, z), bevel=0.0)
    p.box("emissive_red", (W - 0.14, 0.004, 0.005), (0, fy - 0.0105, 2.035), bevel=0.0)

    # equipment behind the glass
    for sx in (-1, 1):
        p.box("metal_dark", (0.02, 0.03, 1.9), (sx * 0.235, -0.49, 1.075), bevel=0.0)
    face_y = -0.505
    z = 0.14
    kinds = ["switch", "srv1", "srv2", "stor", "blank", "gap"]
    weights = [0.18, 0.18, 0.3, 0.1, 0.12, 0.12]
    top = 1.99
    last = None
    while z < top - U:
        kind = rng.choices(kinds, weights)[0]
        if kind == last and kind in ("gap", "blank", "stor"):
            continue
        units = {"switch": 1, "srv1": 1, "srv2": 2, "stor": 4, "blank": 1, "gap": 1}[kind]
        if z + units * U > top:
            kind, units = "blank", 1
        h = units * U
        zc = z + h / 2
        last = kind
        z += h
        if kind == "gap":
            continue
        plate = "metal_dark" if kind == "switch" else "black_matte"
        p.box(plate, (0.46, 0.02, h - 0.002), (0, face_y + 0.01, zc), bevel=0.0)
        fz = face_y - 0.0005
        if kind == "switch":
            for row in range(2):
                for c in range(12):
                    x = -0.17 + c * 0.024 + (0.02 if c >= 6 else 0.0)
                    pz = zc - 0.008 + row * 0.014
                    p.quad("black_gloss", 0.014, 0.009, (x, fz, pz))
                    _led(p, 0.004, 0.0025, (x + 0.0045, fz - 0.0003, pz + 0.0065),
                         blink=rng.random() < 0.8)
            _led(p, 0.008, 0.004, (0.19, fz, zc), blink=False)
        elif kind in ("srv1", "srv2"):
            bays = 4 if kind == "srv1" else 8
            bw = 0.034
            for b in range(bays):
                x = -0.2 + b * (bw + 0.006) + bw / 2
                p.quad("black_gloss", bw, h - 0.012, (x, fz, zc))
                _led(p, 0.004, 0.003, (x + bw / 2 - 0.006, fz - 0.0003, zc - h / 2 + 0.01),
                     blink=rng.random() < 0.65)
            p.quad("black_gloss", 0.08, h * 0.45, (0.12, fz, zc))  # vent grille
            _led(p, 0.006, 0.004, (0.195, fz, zc + 0.006), blink=False)
            _led(p, 0.006, 0.004, (0.195, fz, zc - 0.006), blink=rng.random() < 0.5)
        elif kind == "stor":
            for r in range(3):
                for c in range(4):
                    x = -0.15 + c * 0.1
                    pz = zc - h / 2 + 0.03 + r * 0.05
                    p.quad("black_gloss", 0.092, 0.04, (x, fz, pz))
                    _led(p, 0.005, 0.003, (x + 0.036, fz - 0.0003, pz - 0.014), blink=rng.random() < 0.7)
            _led(p, 0.008, 0.005, (0.2, fz, zc + h / 2 - 0.02), blink=False)


# --- server pillar --------------------------------------------------------------------
PILLAR_H = 1.35


def server_pillar(p):
    """0.62 x 0.62 x 1.35 m rack column at the pod ends: low enough that the
    agents seated beside it stay in view from the usual high camera.

    Black gloss shell on a gunmetal plinth with shadow gaps under the shell and
    the roof cap; the front is a 5 cm bezel around a smoked glass door, behind
    it a stack of blade faceplates carrying a 6-column grid of status LEDs
    (about half lit, most blinking). Thin red strips run up both door edges in
    gunmetal channels; louvred vents on the sides, a fan in the roof. Every red
    light is the same material, so strips and LEDs glow in one tone.
    """
    rng = p.rng
    W, H = 0.6, PILLAR_H
    z0, z1 = 0.07, H - 0.05  # shell bottom and top
    zc, hh = (z0 + z1) / 2, z1 - z0
    front = -W / 2
    rim, recess = 0.05, 0.03
    # plinth, a recessed shadow gap, the shell with its recessed door opening
    p.box("metal_dark", (0.62, 0.62, 0.045), (0, 0, 0.0225), bevel=0.006)
    p.box("black_matte", (0.55, 0.55, 0.035), (0, 0, 0.055), bevel=0.0)
    p.tray("black_gloss", (W, hh, W), (0, 0, zc), rim=rim, depth=recess, bevel=0.005, rot=(PI / 2, 0, 0))
    # roof: shadow gap, overhanging cap, fan
    p.box("black_matte", (0.57, 0.57, 0.03), (0, 0, z1 + 0.005), bevel=0.0)
    p.box("black_gloss", (0.62, 0.62, 0.035), (0, 0, H - 0.0175), bevel=0.007)
    p.ring("metal_dark", 0.15, 0.172, H - 0.001, H + 0.007, segs=28)
    p.cyl("black_matte", 0.151, 0.004, (0, 0, H), segs=28)
    p.cyl("metal_dark", 0.034, 0.008, (0, 0, H + 0.003), segs=14)
    for k in range(4):
        p.box("metal_dark", (0.29, 0.008, 0.004), (0, 0, H + 0.003), rot=(0, 0, k * PI / 4 + PI / 8), bevel=0.0)

    # the equipment wall behind the glass
    open_w, open_z0, open_z1 = W - 2 * rim, z0 + rim, z1 - rim
    back = front + recess  # recessed face of the shell
    p.box("black_matte", (open_w - 0.004, 0.006, open_z1 - open_z0 - 0.004), (0, back - 0.003, zc), bevel=0.0)
    plate = back - 0.006
    for sx in (-1, 1):
        p.box("metal_dark", (0.014, 0.008, open_z1 - open_z0 - 0.02), (sx * 0.228, plate - 0.004, zc), bevel=0.002)
    rows, cols = 12, 6
    lo, hi = open_z0 + 0.035, open_z1 - 0.035
    pitch = (hi - lo) / rows
    col_x = (-0.165, -0.115, -0.065, 0.065, 0.115, 0.165)
    fz = plate - 0.002
    # light half the grid, favouring busy blades over idle ones
    activity = [rng.uniform(0.3, 1.0) for _ in range(rows)]
    score = {(r, c): rng.random() * activity[r] for r in range(rows) for c in range(cols)}
    lit = set(sorted(score, key=score.get, reverse=True)[: round(0.5 * rows * cols)])
    for r in range(rows):
        z = lo + pitch * (r + 0.5)
        p.quad("black_gloss", 0.43, pitch - 0.009, (0, plate - 0.001, z))
        p.quad("metal_dark", 0.012, pitch * 0.5, (-0.2, fz, z))
        for c in range(cols):
            x = col_x[c]
            if (r, c) in lit:
                _led(p, 0.028, 0.007, (x, fz, z), blink=rng.random() < 0.85)
            else:
                p.quad("black_matte", 0.028, 0.007, (x, fz, z))

    # smoked glass door with a pull handle
    gy = front + 0.007
    p.box("glass_dark", (open_w - 0.002, 0.006, open_z1 - open_z0 - 0.002), (0, gy + 0.003, zc), bevel=0.0)
    hx = 0.205
    p.box("metal_dark", (0.014, 0.016, 0.26), (hx, front - 0.012, zc), bevel=0.004)
    for z in (zc - 0.1, zc + 0.1):
        p.box("metal_dark", (0.01, 0.016, 0.01), (hx, front - 0.0005, z), bevel=0.0)

    # thin red strips in gunmetal channels along both door edges
    strip_z0, strip_z1 = open_z0 + 0.015, open_z1 - 0.015
    for sx in (-1, 1):
        x = sx * (open_w / 2 + 0.013)
        p.box("metal_dark", (0.014, 0.004, strip_z1 - strip_z0 + 0.01), (x, front - 0.0015, zc), bevel=0.001)
        p.box("emissive_red", (0.004, 0.003, strip_z1 - strip_z0), (x, front - 0.004, zc), bevel=0.0)

    # bezel details: power and activity LEDs on the top rail, intake slits below
    _led(p, 0.012, 0.005, (-0.2, front - 0.001, z1 - rim / 2), blink=False)
    for k in range(3):
        _led(p, 0.006, 0.005, (-0.17 + k * 0.014, front - 0.001, z1 - rim / 2), blink=True)
    for k in range(14):
        p.quad("black_matte", 0.018, 0.008, (-0.169 + k * 0.026, front - 0.001, z0 + rim / 2))

    # louvred vents on both sides, low (intake) and high (exhaust)
    for sx in (-1, 1):
        for vz in (0.36, 1.0):
            p.box("black_matte", (0.004, 0.36, 0.26), (sx * (W / 2 + 0.001), 0.03, vz), bevel=0.0)
            for k in range(7):
                z = vz - 0.108 + k * 0.036
                p.box("black_gloss", (0.012, 0.33, 0.004), (sx * (W / 2 + 0.005), 0.03, z),
                      rot=(0, sx * 0.6, 0), bevel=0.0)
    # rear service panel
    p.box("black_matte", (0.5, 0.004, hh - 0.14), (0, W / 2 + 0.001, zc), bevel=0.0)
    for z in (z0 + 0.15, zc, z1 - 0.15):
        p.box("metal_dark", (0.03, 0.008, 0.06), (-0.22, W / 2 + 0.003, z), bevel=0.002)


# --- data monolith --------------------------------------------------------------------
def data_monolith(p):
    """0.5 x 0.18 x 2.6 m black gloss stele on a 0.9 x 0.5 x 0.05 m gunmetal
    base. The stele is split down the middle by a 2 cm slit whose matte core
    carries a steady red light line; six dim red ticks cross the front and a
    red line runs along the front edge of the base."""
    H = 2.6
    yc = 0.02  # stele a little behind centre: a deeper lit ledge in front
    D = 0.18
    yf = yc - D / 2
    p.box("metal_dark", (0.9, 0.5, 0.05), (0, 0, 0.025), bevel=0.006)
    p.box("emissive_red", (0.82, 0.006, 0.004), (0, -0.228, 0.0515), bevel=0.0)
    p.box("black_matte", (0.47, 0.15, 0.03), (0, yc, 0.06), bevel=0.0)
    s0 = 0.07
    gap = 0.02
    half = (0.5 - gap) / 2
    for sx in (-1, 1):
        p.box("black_gloss", (half, D, H - s0), (sx * (gap / 2 + half / 2), yc, (H + s0) / 2), bevel=0.005)
    # matte core in the slit, recessed 14 mm from every face
    inset = 0.014
    p.box("black_matte", (gap + 0.004, D - 2 * inset, H - s0 - inset), (0, yc, (H + s0 - inset) / 2), bevel=0.0)
    p.box("emissive_red", (0.01, 0.004, 2.2), (0, yf + inset - 0.002, 1.35), bevel=0.0)
    for i in range(6):
        z = 0.5 + i * 0.35
        for sx in (-1, 1):
            p.box("emissive_red_dim", (0.13, 0.003, 0.005), (sx * (gap / 2 + 0.018 + 0.065), yf - 0.0005, z),
                  bevel=0.0)


# --- coffee bar ------------------------------------------------------------------------
def coffee_bar(p):
    """2.4 m counter: fluted black front, gloss stone top, espresso machine,
    grinder, a tray of cups and red LED lines under the top and at the kick."""
    W = 2.4
    p.box("black_matte", (W - 0.04, 0.56, 0.08), (0, 0.05, 0.04), bevel=0.003)
    p.box("black_matte", (W, 0.62, 0.84), (0, 0.015, 0.5), bevel=0.004)
    # vertical flutes across the front
    front = -0.295
    r = 0.019
    n = int((W - 0.06) / (2 * r))
    x0 = -(n * 2 * r) / 2 + r
    verts, faces = [], []
    for i in range(n):
        cx = x0 + i * 2 * r
        base = len(verts)
        for k in range(7):
            a = PI * k / 6
            for z in (0.1, 0.9):
                verts.append((cx - r * math.cos(a), front - r * 0.8 * math.sin(a), z))
        for k in range(6):
            a0, a1 = base + 2 * k, base + 2 * (k + 1)
            faces.append((a0, a1, a1 + 1, a0 + 1))
    p.mesh("black_gloss", verts, faces, smooth=True, sharp=60)
    p.box("black_gloss", (W + 0.04, 0.68, 0.04), (0, 0.0, 0.94), bevel=0.005)
    p.box("emissive_red", (W - 0.08, 0.006, 0.008), (0, -0.322, 0.914), bevel=0.0)
    p.box("emissive_red", (W - 0.1, 0.006, 0.006), (0, -0.2245, 0.016), bevel=0.0)
    top = 0.96

    # espresso machine
    mx, my = -0.42, 0.07
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.cyl("black_matte", 0.02, 0.02, (mx + sx * 0.3, my + sy * 0.18, top + 0.01), segs=10)
    p.box("metal_dark", (0.72, 0.46, 0.4), (mx, my, top + 0.22), bevel=0.012)
    p.box("black_gloss", (0.68, 0.012, 0.13), (mx, my - 0.234, top + 0.33), bevel=0.003)
    for k, gx in enumerate((-0.17, 0.17)):
        x = mx + gx
        p.cyl("metal_dark", 0.042, 0.05, (x, my - 0.27, top + 0.2), segs=18)
        p.cyl("metal_dark", 0.038, 0.03, (x, my - 0.27, top + 0.16), segs=18)
        p.tube("black_gloss", [(x, my - 0.29, top + 0.155), (x + 0.02 * (1 - 2 * k), my - 0.44, top + 0.14)],
               0.012, segs=8)
        _led(p, 0.012, 0.004, (x, my - 0.2415, top + 0.305), blink=False)
    p.box("metal_dark", (0.62, 0.15, 0.022), (mx, my - 0.3, top + 0.011), bevel=0.004)
    p.box("black_gloss", (0.58, 0.12, 0.002), (mx, my - 0.3, top + 0.023), bevel=0.0)
    p.tube("metal_dark", [(mx + 0.3, my - 0.24, top + 0.3), (mx + 0.32, my - 0.3, top + 0.25),
                          (mx + 0.33, my - 0.33, top + 0.1)], 0.006, segs=6)
    for sx in (-1, 1):
        p.box("metal_dark", (0.012, 0.4, 0.012), (mx + sx * 0.33, my, top + 0.426), bevel=0.0)
    for sy in (-1, 1):
        p.box("metal_dark", (0.66, 0.012, 0.012), (mx, my + sy * 0.2, top + 0.426), bevel=0.0)
    for i in range(3):
        _cup(p, (mx - 0.18 + i * 0.12, my + 0.05, top + 0.42 + 0.07), upside_down=True)

    # grinder
    gx, gy = -1.02, 0.1
    p.box("black_gloss", (0.19, 0.25, 0.3), (gx, gy, top + 0.15), bevel=0.01)
    p.cyl("metal_dark", 0.045, 0.05, (gx, gy, top + 0.325), segs=16)
    p.lathe("glass_dark", [(0.04, 0.0), (0.095, 0.16), (0.1, 0.17), (0.094, 0.17), (0.036, 0.004)],
            loc=(gx, gy, top + 0.35), segs=20)
    p.lathe("soil", [(0.0, 0.01), (0.04, 0.01), (0.08, 0.1), (0.0, 0.11)], loc=(gx, gy, top + 0.35), segs=16)
    p.cyl("black_gloss", 0.1, 0.018, (gx, gy, top + 0.529), segs=20)

    # cup tray
    p.box("metal_dark", (0.66, 0.17, 0.012), (0.45, -0.08, top + 0.006), bevel=0.003)
    for i in range(5):
        _cup(p, (0.19 + i * 0.13, -0.08, top + 0.012))


def _cup(p, loc, upside_down=False):
    prof = [(0.0, 0.0), (0.028, 0.0), (0.036, 0.008), (0.042, 0.068), (0.037, 0.07), (0.032, 0.012), (0.0, 0.012)]
    rot = (PI, 0, 0) if upside_down else None
    p.lathe("black_gloss", prof, loc=loc, rot=rot, segs=12, sharp=50)


# --- executive shelf -----------------------------------------------------------------
def exec_shelf(p):
    """2.0 x 0.4 x 2.2 m black shelving, three columns, red backlight strips
    under every shelf and a few styled objects."""
    W, D, H = 2.0, 0.4, 2.2
    rng = p.rng
    p.box("black_matte", (W, D - 0.02, 0.08), (0, 0.0, 0.04), bevel=0.004)
    for sx in (-1, 1):
        p.box("black_matte", (0.03, D, H), (sx * (W / 2 - 0.015), 0, H / 2), bevel=0.004)
    p.box("black_matte", (W, D, 0.03), (0, 0, H - 0.015), bevel=0.004)
    back_y = D / 2 - 0.01
    p.box("black_matte", (W - 0.06, 0.02, H - 0.11), (0, back_y, 0.08 + (H - 0.11) / 2), bevel=0.0)
    for sx in (-1, 1):
        p.box("black_matte", (0.025, D - 0.02, H - 0.11), (sx * 0.33, -0.01, 0.08 + (H - 0.11) / 2), bevel=0.003)
    levels = [0.08, 0.52, 0.96, 1.4, 1.82, H - 0.03]
    for z in levels[1:-1]:
        p.box("black_gloss", (W - 0.06, D - 0.025, 0.025), (0, -0.0125, z - 0.0125), bevel=0.003)
    cols = [(-0.97, -0.3425), (-0.3175, 0.3175), (0.3425, 0.97)]
    strip_y = back_y - 0.013
    for lo_z, hi_z in zip(levels, levels[1:]):
        shelf_bottom = hi_z - (0.025 if hi_z < H - 0.03 else 0.0)
        shelf_top = lo_z
        for x0, x1 in cols:
            # one line under the shelf above (seen from below) and one along the
            # back of the shelf top (seen from the usual high camera)
            for zz in (shelf_bottom - 0.006, shelf_top + 0.005):
                p.box("emissive_red", (x1 - x0 - 0.03, 0.005, 0.007), ((x0 + x1) / 2, strip_y, zz),
                      bevel=0.0)
    # styling, compartment by compartment: (column, level)
    def books(x0, z, n, lean=0.0):
        x = x0
        for i in range(n):
            t = rng.uniform(0.025, 0.045)
            h = rng.uniform(0.22, 0.3)
            dd = rng.uniform(0.17, 0.22)
            mat = rng.choice(("leather", "fabric_dark", "black_matte"))
            p.box(mat, (t, dd, h), (x + t / 2, 0.04, z + h / 2), bevel=0.0,
                  rot=(0, lean if i == n - 1 else 0.0, 0))
            x += t + 0.002

    def stack(x, z, n):
        for i in range(n):
            t = 0.03
            p.box(rng.choice(("leather", "fabric_dark")), (0.24 - i * 0.015, 0.18, t),
                  (x, 0.03, z + t * (i + 0.5)), rot=(0, 0, rng.uniform(-0.08, 0.08)), bevel=0.0)

    def vase(x, z, h, r):
        p.lathe("black_gloss", [(0.0, 0.0), (r * 0.6, 0.0), (r, h * 0.35), (r * 0.8, h * 0.8), (r * 0.45, h),
                                (r * 0.38, h), (0.0, h * 0.9)], loc=(x, 0.02, z), segs=16, sharp=60)

    def sphere(x, z, r, mat="black_gloss"):
        prof = [(r * math.sin(PI * k / 8), r - r * math.cos(PI * k / 8)) for k in range(9)]
        p.lathe(mat, prof, loc=(x, 0.02, z), segs=16, sharp=80)

    z = levels
    books(-0.93, z[0], 7)
    p.box("leather", (0.22, 0.26, 0.16), (-0.52, 0.02, z[0] + 0.08), bevel=0.004)
    p.box("black_matte", (0.26, 0.28, 0.2), (-0.1, 0.02, z[0] + 0.1), bevel=0.004)
    p.box("leather", (0.26, 0.28, 0.2), (0.18, 0.02, z[0] + 0.1), bevel=0.004)
    vase(0.66, z[0], 0.34, 0.075)
    sphere(-0.66, z[1], 0.09)
    p.cyl("metal_dark", 0.05, 0.02, (-0.66, 0.02, z[1] + 0.01), segs=16)
    books(-0.2, z[1], 9, lean=0.0)
    stack(0.66, z[1], 4)
    p.lathe("metal_dark", [(0.0, 0.0), (0.04, 0.0), (0.04, 0.02), (0.01, 0.03), (0.01, 0.1), (0.045, 0.13),
                           (0.05, 0.19), (0.0, 0.16)], loc=(0.66, 0.02, z[1] + 0.12), segs=14)
    vase(-0.72, z[2], 0.26, 0.06)
    vase(-0.56, z[2], 0.18, 0.05)
    # ring sculpture
    ring_pts = [(0.14 * math.cos(2 * PI * k / 20), 0.02, z[2] + 0.2 + 0.14 * math.sin(2 * PI * k / 20))
                for k in range(21)]
    p.tube("metal_dark", ring_pts, 0.012, segs=8, caps=False)
    p.box("black_matte", (0.14, 0.1, 0.05), (0, 0.02, z[2] + 0.025), bevel=0.004)
    books(0.4, z[2], 10)
    books(-0.93, z[3], 11)
    p.box("black_gloss", (0.12, 0.12, 0.12), (0.0, 0.02, z[3] + 0.06), rot=(0, 0, 0.5), bevel=0.004)
    sphere(0.66, z[3], 0.07, "metal_dark")
    stack(-0.66, z[4], 3)
    books(-0.26, z[4], 6)
    vase(0.7, z[4], 0.22, 0.07)


# --- wall screen ----------------------------------------------------------------------
def wall_screen(p):
    """2.2 x 1.25 m display, 5 cm deep, centred 1.55 m above the floor. The
    body is centred on the origin in depth (y -0.025..0.025): place it 2.5 cm
    in front of the wall face. The display surface is its own "screen"
    material with UVs 0..1 (u to the viewer's right, v up)."""
    zc = 1.55
    p.box("black_gloss", (2.2, 0.05, 1.25), (0, 0, zc), bevel=0.006)
    p.quad("screen", 2.2 - 0.024, 1.25 - 0.024, (0, -0.0252, zc))
    _led(p, 0.012, 0.003, (1.02, -0.0254, zc - 0.625 + 0.006), blink=False)


# --- floor lamp ---------------------------------------------------------------------------
def floor_lamp(p):
    p.lathe("black_gloss", [(0.0, 0.0), (0.15, 0.0), (0.155, 0.006), (0.15, 0.022), (0.13, 0.028), (0.0, 0.03)],
            segs=32, sharp=40)
    p.cyl("black_matte", 0.011, 1.33, (0, 0, 0.03 + 1.33 / 2), segs=10)
    z0, z1, r = 1.3, 1.6, 0.19
    p.lathe("emissive_warm", [(r, z0), (r, z1), (r - 0.006, z1), (r - 0.006, z0), (r, z0)], segs=32, sharp=40)
    p.cyl("emissive_warm", r - 0.01, 0.004, (0, 0, z0 + 0.03), segs=24)
    p.ring("metal_dark", r - 0.002, r + 0.004, z0 - 0.004, z0 + 0.006, segs=32)
    p.ring("metal_dark", r - 0.002, r + 0.004, z1 - 0.006, z1 + 0.004, segs=32)
    for k in range(3):
        a = 2 * PI * k / 3
        p.tube("metal_dark", [(0, 0, z1 - 0.05), (math.cos(a) * (r - 0.004), math.sin(a) * (r - 0.004), z1 - 0.004)],
               0.003, segs=5)
    p.cyl("metal_dark", 0.018, 0.05, (0, 0, z1 - 0.05), segs=12)
