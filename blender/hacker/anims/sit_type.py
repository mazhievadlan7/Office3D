"""Seated focused typing (SitType): 96 frames at 30 fps, cyclic, in place.

Built on _base.SIT + SIT_TYPE_ARMS. Every key re-solves the legs (feet stay
planted), the gaze (look_at) and both arms (wrists on the keyboard) from the
clip's own spine, then layers the finger taps on top. See pose.py for axes.

Beat sheet (frames):
   0-28  burst A: alternating-hand taps, a right-thumb space; the head reads
         across the centre monitor in small saccades
  28-48  glance to the left monitor and back (head ~35 deg, the chest turns
         ~4 deg a few frames behind it); two light taps while reading, a
         left-thumb space as the eyes come back
  48-58  burst B: the right hand reaches out for Enter with the pinky (wrist
         travel plus ulnar deviation, the chest turns into the reach)
  60-80  pause: both hands lift and hover, then pelvis and spine lean in and
         the head goes toward the centre monitor; hands settle back first
  80-96  burst C, settling back into the loop pose

A tap is a slow finger lift (~1 cm), a 1-2 frame strike (~3-4 mm of key
travel) and a quick release with a small rebound; neighbouring fingers follow
a little (shared tendons) and the wrist dips about a millimetre on each strike.
All taps and gaze/hover/lean beats sit on even frames, so keys are at most
every 2 frames (every 4 in quiet stretches).

Uses _base's private _TYPE_FINGERS_L and _mirror_val (same package).
"""

import math

from mathutils import Quaternion, Vector

import _base as B
from pose import merge, mirror

NAME = "SitType"
FRAMES = 96
CYCLIC = True
N = FRAMES


# --- time helpers --------------------------------------------------------------
def _wrap(dt):
    return (dt + N / 2) % N - N / 2


def _ease(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def _spline(pts, f):
    """Periodic cubic Hermite through [(frame, value)], frames in [0, N).
    Tangents are Catmull-Rom but zeroed at local extremes (like Blender's
    auto-clamped handles), so repeated values give flat holds, no overshoot."""
    ts = [q[0] for q in pts]
    vs = [q[1] if isinstance(q[1], (tuple, list)) else (q[1],) for q in pts]
    n = len(pts)

    def T(i):
        return ts[i % n] + N * (i // n)

    def V(i):
        return vs[i % n]

    def tan(j, c):
        a, b, d = V(j - 1)[c], V(j)[c], V(j + 1)[c]
        if (b - a) * (d - b) <= 0:
            return 0.0
        return (d - a) / (T(j + 1) - T(j - 1))

    f = f % N
    i = -1
    while T(i + 1) <= f:
        i += 1
    t0, t1 = T(i), T(i + 1)
    h = t1 - t0
    u = (f - t0) / h
    h00, h10 = 2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u
    h01, h11 = -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2
    out = tuple(h00 * V(i)[c] + h10 * h * tan(i, c) + h01 * V(i + 1)[c] + h11 * h * tan(i + 1, c)
                for c in range(len(vs[0])))
    return out if isinstance(pts[0][1], (tuple, list)) else out[0]


def _tap(dt):
    """Tap profile around the key-down frame (dt=0): -1 = finger fully lifted,
    +1 = fully pressed. Slow lift, fast strike, quick release, small rebound."""
    if dt <= -5 or dt >= 5:
        return 0.0
    if dt <= -2:
        return -_ease((dt + 5) / 3)
    if dt <= 0:
        return -1 + 2 * _ease((dt + 2) / 2)
    if dt <= 2:
        return 1 - 1.12 * _ease(dt / 2)
    return -0.12 * (1 - _ease((dt - 2) / 3))


# --- performance -------------------------------------------------------------
# (key-down frame, hand, finger, strength). I/M/R/P fingers, T = thumb (space).
EVENTS = [
    # burst A
    (2, "L", "M", 1.0), (4, "R", "I", 0.9), (8, "L", "I", 1.0), (10, "R", "R", 0.8),
    (12, "L", "R", 0.9), (18, "R", "T", 1.0), (20, "R", "I", 1.0), (22, "L", "M", 0.8),
    (24, "R", "M", 0.9), (28, "L", "I", 0.7),
    # while glancing left, then a left-thumb space as the eyes come back
    (36, "L", "I", 0.7), (40, "R", "M", 0.6), (46, "L", "T", 0.9),
    # burst B: the right hand reaches out for Enter with the pinky
    (48, "L", "M", 0.9), (50, "R", "I", 1.0), (52, "L", "I", 0.8), (54, "R", "P", 1.1),
    # burst C
    (80, "R", "I", 0.9), (82, "L", "M", 1.0), (86, "R", "M", 0.8), (88, "R", "T", 1.0),
    (90, "L", "I", 1.0), (92, "L", "R", 0.8), (94, "R", "I", 0.9),
]
FINGERS = {"I": "Index", "M": "Middle", "R": "Ring", "P": "Pinky"}
# Neighbours that move along with a tapping finger (fraction of its motion).
SYMPATHY = {
    "I": {"M": 0.2},
    "M": {"I": 0.15, "R": 0.3},
    "R": {"M": 0.25, "P": 0.45},
    "P": {"R": 0.4},
}
LIFT = (9.0, 5.0)  # curl removed at full lift (Finger1, Finger2), degrees
PRESS = (2.2, 1.6)  # curl added at full press (~3 mm of key travel with the wrist dip)
PRESS_DIP = 0.001  # wrist drop on a strike, metres

# Wrist offsets from TYPE_WRIST (armature axes, metres: x = character's left,
# y = back, z = up). The right hand's Enter reach is at 53-55.
WRIST_L = [
    (0, (0.0, 0.0, 0.0)),
    (6, (0.004, -0.004, 0.0)),
    (12, (0.012, 0.001, 0.0)),
    (18, (0.004, -0.006, 0.0)),
    (24, (-0.004, -0.002, 0.0)),
    (32, (-0.002, 0.002, 0.001)),
    (42, (0.0, 0.0, 0.0)),
    (48, (-0.009, -0.006, 0.0)),
    (54, (0.006, 0.0, 0.0)),
    (60, (0.002, 0.002, 0.0)),
    (74, (0.002, 0.004, 0.0)),
    (82, (-0.006, -0.004, 0.0)),
    (88, (0.005, -0.002, 0.0)),
    (92, (0.002, 0.0, 0.0)),
]
WRIST_R = [
    (0, (0.0, 0.0, 0.0)),
    (5, (0.005, -0.006, 0.0)),
    (11, (-0.009, 0.0, 0.0)),
    (17, (0.0, -0.005, 0.0)),
    (23, (0.004, 0.0, 0.0)),
    (32, (0.0, 0.002, 0.001)),
    (44, (0.0, 0.0, 0.0)),
    (50, (0.004, -0.004, 0.0)),
    (53, (-0.030, -0.013, 0.003)),  # Enter
    (55, (-0.032, -0.015, 0.003)),
    (60, (-0.008, -0.002, 0.002)),
    (66, (-0.003, 0.002, 0.0)),
    (74, (-0.004, 0.002, 0.0)),
    (80, (0.004, -0.004, 0.0)),
    (86, (-0.006, 0.0, 0.0)),
    (91, (0.003, -0.003, 0.0)),
]
HOVER_OFF = Vector((0.0, 0.010, 0.016))  # hands lifted and drawn back a little
HOVER = [(0, 0.0), (40, 0.0), (60, 0.0), (64, 1.0), (72, 0.9), (78, 0.0)]
LEAN = [(0, 0.0), (40, 0.0), (62, 0.0), (68, 1.0), (74, 1.0), (80, 0.0)]
# Glance to the left monitor: 0 = centre, 1 = left monitor (small overshoot).
GLANCE = [(0, 0.0), (28, 0.0), (30, 0.2), (32, 0.75), (34, 1.04), (36, 1.0), (40, 0.97),
          (42, 0.7), (44, 0.15), (46, -0.03), (48, 0.0), (70, 0.0)]
LEFT_MONITOR = Vector((0.52, -0.92, 1.10))
# Reading on the centre monitor: gaze offsets (dx, dz) held, then quick saccades.
SACCADES = [
    (0, (-0.03, 0.010)), (6, (-0.03, 0.010)),
    (8, (0.01, 0.012)), (12, (0.01, 0.012)),
    (14, (0.05, 0.008)), (20, (0.05, 0.008)),
    (22, (-0.04, -0.010)), (46, (-0.04, -0.010)),
    (48, (-0.02, -0.012)), (52, (-0.02, -0.012)),
    (54, (0.03, -0.016)), (60, (0.03, -0.016)),
    (62, (0.0, -0.040)), (74, (0.0, -0.040)),
    (76, (0.02, -0.030)), (80, (0.02, -0.030)),
    (82, (-0.035, -0.005)), (86, (-0.035, -0.005)),
    (88, (0.015, 0.004)), (94, (0.015, 0.004)),
]
HEAD_LAG = 1.5  # frames the head trails the chest


# --- pose pieces ---------------------------------------------------------------
def _spine(f):
    br = math.sin(2 * math.pi * f / N + 0.4)  # one breath per loop
    br2 = math.sin(2 * math.pi * f / N - 0.1)  # upper chest trails
    lean = _spline(LEAN, f)
    gch = _spline(GLANCE, f - 3)  # the chest follows the head's turn
    sway = 30.0 * (_spline(WRIST_L, f)[0] + _spline(WRIST_R, f)[0])  # deg: chest turns into reaches
    return merge(B.SIT_SPINE, {
        "Hips": (2.6 * lean, 0, -0.15 * sway - 0.4 * gch),
        "Spine": (0.2 * br + 1.1 * lean, 0, 0.6 * gch + 0.2 * sway),
        "Spine1": (-0.45 * br + 2.1 * lean, 0, 1.4 * gch + 0.4 * sway),
        "Spine2": (-0.6 * br2 + 2.6 * lean, 0, 2.4 * gch + 0.6 * sway),
        "Neck": (5.0 * lean, 0, 0),
    })


def _gaze(f):
    dx, dz = _spline(SACCADES, f)
    # The eyes do most of a reading saccade; the head follows about 60%.
    centre = B.MONITOR + Vector((0.6 * dx, 0.0, 0.6 * dz))
    g = _spline(GLANCE, f)
    return centre.lerp(LEFT_MONITOR, g)


def _taps(f, hand):
    """Per-finger tap values (I/M/R/P/T) for one hand, incl. sympathetic motion,
    and the strongest press (for the wrist dip)."""
    s = {k: 0.0 for k in "IMRPT"}
    press = 0.0
    for t, hd, fg, amp in EVENTS:
        if hd != hand:
            continue
        v = amp * _tap(_wrap(f - t))
        if v == 0.0:
            continue
        s[fg] += v
        press = max(press, v)
        for nb, k in SYMPATHY.get(fg, {}).items():
            s[nb] += k * v
    return s, press


def _fingers_left(f, s, hover, phase):
    """Left-convention finger values (mirror() gives the right hand)."""
    out = {}
    for i, (k, fn) in enumerate(FINGERS.items()):
        v = s[k]
        live = math.sin(2 * math.pi * (2 + i) * f / N + phase + 1.7 * i)  # fingers never quite still
        c1 = (v * LIFT[0] if v < 0 else v * PRESS[0]) + 1.0 * live + 2.0 * hover
        c2 = (v * LIFT[1] if v < 0 else v * PRESS[1]) + 0.8 * live + 4.0 * hover
        b1 = B._TYPE_FINGERS_L[f"LeftHand{fn}1"]
        b2 = B._TYPE_FINGERS_L[f"LeftHand{fn}2"]
        out[f"LeftHand{fn}1"] = (b1[0], b1[1] + c1, b1[2])
        out[f"LeftHand{fn}2"] = (b2[0], b2[1] + c2, b2[2])
    t = s["T"]
    down = 0.3 + (0.03 * t if t > 0 else 0.05 * t) + 0.03 * hover
    out.update(B.left_thumb(0.6, 0.55, down, 12 + 3 * t + 4 * hover))
    return out


def _arm(p, side, dw, pitch=0.0, sh=(0.0, 0.0, 0.0)):
    """Arm on the keyboard like _base.type_arm, with the wrist offset dw, hand
    yaw from the lateral reach (ulnar/radial deviation), a hand pitch (+ lifts
    the fingers) and a shoulder offset `sh` given as a LEFT value."""
    pre = "Left" if side > 0 else "Right"
    wrist = Vector((B.TYPE_WRIST.x * side, B.TYPE_WRIST.y, B.TYPE_WRIST.z)) + dw
    fwd = Vector((B.TYPE_HAND_FWD.x * side, B.TYPE_HAND_FWD.y, B.TYPE_HAND_FWD.z)).normalized()
    palm = Vector((B.TYPE_PALM.x * side, B.TYPE_PALM.y, B.TYPE_PALM.z)).normalized()
    if pitch:
        q = Quaternion(palm.cross(fwd).normalized(), math.radians(pitch))
        fwd, palm = q @ fwd, q @ palm
    yaw = 200.0 * dw.x  # deg: the hand turns toward where it reaches
    if yaw:
        q = Quaternion((0, 0, 1), math.radians(yaw))
        fwd, palm = q @ fwd, q @ palm
    shoulder = tuple(a + b for a, b in zip(B.TYPE_SHOULDER, sh))
    s = B.joint(p, pre + "Arm")
    return B.arm_ik(
        p, side, wrist,
        pole=s + Vector((0.22 * side, 0.02, -0.5)),
        hand_fwd=fwd, palm=palm,
        shoulder=shoulder if side > 0 else B._mirror_val("LeftShoulder", shoulder),
    )


def pose_at(f):
    spine = _spine(f)
    p = dict(spine)
    p.update(B.sit_legs(p))

    # Head: aimed from the chest pose of HEAD_LAG frames ago, so it trails the
    # body (overlap), with a slight tilt into the glance.
    hd = B.look_at(_spine(f - HEAD_LAG), _gaze(f), neck_share=0.35)
    p["Neck"] = hd["Neck"]
    # Slow drift so the head never locks between saccades; a slight tilt
    # into the glance and a small one to the right while leaning in to read.
    w = 2 * math.pi * f / N
    drift = (0.35 * math.sin(3 * w + 1.0), 0.3 * math.sin(2 * w + 0.4), 0.45 * math.sin(4 * w + 2.2))
    tilt = 1.5 * _spline(GLANCE, f - 1) - 1.2 * _spline(LEAN, f - 1)
    p["Head"] = merge({"Head": hd["Head"]}, {"Head": (drift[0], drift[1] + tilt, drift[2])})["Head"]

    br2 = math.sin(2 * math.pi * f / N - 0.1)
    arms = {}
    # The right hand leaves the keys first and the left follows two frames
    # later, a little lower, so the hover is not mirrored.
    for side, hand, path, lag, amt in ((1, "L", WRIST_L, 2.0, 0.85), (-1, "R", WRIST_R, 0.0, 1.0)):
        hover = amt * _spline(HOVER, f - lag)
        s, press = _taps(f, hand)
        dw = Vector(_spline(path, f)) + HOVER_OFF * hover + Vector((0, 0, -PRESS_DIP * press))
        sh = (0.0, -0.6 * br2 - 0.8 * hover, 60.0 * dw.y)
        arms.update(_arm(p, side, dw, pitch=4.0 * hover, sh=sh))
        fl = _fingers_left(f, s, hover, 0.0 if side > 0 else 2.1)
        arms.update(fl if side > 0 else mirror(fl))
    return B.override(p, arms)


def key_frames():
    ks = set(range(0, N + 1, 4))
    for t, *_ in EVENTS:
        for d in (-2, 0, 2):
            ks.add(int((t + d) % N))
    for pts in (SACCADES, GLANCE, HOVER, LEAN):
        ks.update(int(q[0]) for q in pts)
    ks.update(int(q[0]) + 2 for q in HOVER if q[1])  # the left hand's hover trails by 2
    if 0 in ks:
        ks.add(N)
    return sorted(ks)


def build(anim):
    for f in key_frames():
        anim.key(f, pose_at(f))
