"""Seated work, second variant (SitType2): 120 frames at 30 fps, cyclic.

The same hands-on-the-keys mechanics as SitType (sit_type.py) but another
rhythm and more mouse, so two neighbours typing never read as copies.

Beat sheet (frames):
   0-28  burst A: quicker, more even taps than SitType, eyes reading along
         the centre monitor
  30-38  the right hand leaves the keys for the mouse (lifts ~2 cm, turns
         palm-over as it goes); the eyes go ahead of it to the right monitor
  38-70  mouse work: small moves, a click, a double click, a drag; the left
         hand holds a shortcut (pinky Ctrl, index C) meanwhile
  70-78  back to the keys; a quick look down at the keyboard to find home
  80-116 burst C with a lean in to read closely (100-112) and Enter with the
         right pinky at 110, then settles back into frame 0

Every key re-solves the legs, the gaze and both arms from the clip's own
spine; the hand targets come from _seat (keyboard / mouse), mixed along an
arc for the reach so the fingers clear the keys.
"""

import math

from mathutils import Vector

import _base as B
import _seat as S
from pose import merge

NAME = "SitType2"
FRAMES = 120
CYCLIC = True
N = FRAMES


def T(keys):
    return S.Track(keys, period=N)


def _wrap(dt):
    return (dt + N / 2) % N - N / 2


# --- performance -------------------------------------------------------------
EVENTS = [
    # burst A
    (2, "L", "I", 1.0), (4, "R", "M", 0.9), (6, "L", "M", 0.8), (8, "R", "I", 1.0), (10, "L", "R", 0.8),
    (12, "R", "T", 1.0), (14, "L", "I", 0.9), (16, "R", "R", 0.8), (18, "L", "M", 1.0), (20, "R", "I", 0.9),
    (24, "L", "T", 0.9), (26, "R", "M", 0.8),
    # shortcut with the left hand while the right is on the mouse
    (50, "L", "P", 0.9), (52, "L", "I", 0.8), (62, "L", "M", 0.6),
    # burst C, Enter with the right pinky at 110
    (82, "R", "I", 0.9), (84, "L", "M", 1.0), (86, "R", "M", 0.8), (88, "L", "I", 0.9), (92, "R", "R", 0.8),
    (94, "L", "R", 0.9), (96, "R", "T", 1.0), (98, "L", "M", 0.9), (100, "R", "I", 1.0), (102, "L", "I", 0.8),
    (106, "R", "M", 0.9), (110, "R", "P", 1.1), (114, "L", "M", 0.7),
]
FINGERS = {"I": "Index", "M": "Middle", "R": "Ring", "P": "Pinky"}
SYMPATHY = {"I": {"M": 0.2}, "M": {"I": 0.15, "R": 0.3}, "R": {"M": 0.25, "P": 0.45}, "P": {"R": 0.4}}
LIFT = (9.0, 5.0)
PRESS = (2.2, 1.6)
PRESS_DIP = 0.001

# Right hand on the mouse: 0 = keys, 1 = mouse.
MOUSE = T([(0, 0.0), (30, 0.0), (38, 1.0), (70, 1.0), (78, 0.0)])
REACH_LIFT = Vector((0.0, 0.012, 0.022))
MOUSE_DX = T([(0, 0.0), (38, 0.0), (44, -0.0065), (49, -0.006), (54, 0.0035), (60, 0.004), (64, -0.002),
              (68, -0.0015), (72, 0.0)])
MOUSE_DY = T([(0, 0.0), (38, 0.0), (44, 0.002), (54, -0.002), (64, 0.001), (72, 0.0)])


def _click(c, lift=-6.0, press=6.0):
    return [(c - 5, 0.0), (c - 3, lift), (c, press), (c + 2, press * 0.8), (c + 4, -1.5), (c + 6, 0.0)]


CLICK = T([(0, 0.0), (38, 0.0)] + _click(46) + [(52, 0.0), (54, -5.0), (56, 6.0), (57, 1.0), (58, 6.0),
                                                 (60, 4.0), (62, -1.0), (64, 0.0)] + [(70, 0.0)])

# Wrist offsets on the keys (m; x = character's left, y = back, z = up).
WRIST_L = T([(0, (0.0, 0.0, 0.0)), (6, (0.006, -0.003, 0.0)), (12, (-0.004, 0.002, 0.0)),
             (18, (0.008, -0.004, 0.0)), (26, (0.0, 0.0, 0.0)), (48, (-0.012, 0.004, 0.0)),
             (52, (-0.006, 0.0, 0.0)), (64, (0.0, 0.002, 0.001)), (84, (0.006, -0.004, 0.0)),
             (94, (0.012, 0.0, 0.0)), (102, (-0.004, -0.003, 0.0)), (114, (0.003, 0.0, 0.0))])
WRIST_R = T([(0, (0.0, 0.0, 0.0)), (4, (0.004, -0.004, 0.0)), (10, (-0.006, 0.0, 0.0)),
             (16, (-0.008, -0.004, 0.0)), (22, (0.004, 0.0, 0.0)), (28, (0.0, 0.0, 0.0)),
             (84, (0.004, -0.004, 0.0)), (92, (-0.008, 0.0, 0.0)), (100, (0.004, -0.004, 0.0)),
             (106, (-0.004, 0.0, 0.0)), (109, (-0.028, -0.013, 0.003)), (111, (-0.030, -0.014, 0.003)),
             (114, (-0.008, -0.002, 0.002)), (118, (0.0, 0.0, 0.0))])
# Lean in (deg-ish weights): reading closely.
LEAN = T([(0, 0.0), (20, 0.25), (30, 0.0), (60, 0.15), (78, 0.0), (96, 0.1), (102, 0.9), (110, 1.0),
          (114, 0.4), (119, 0.0)])

# Gaze: (x, z) offsets on the centre monitor for reading, then blends.
READ = T([(0, (-0.03, 0.01)), (6, (-0.03, 0.01)), (8, (0.02, 0.012)), (13, (0.02, 0.012)),
          (15, (0.06, 0.006)), (20, (0.06, 0.006)), (22, (-0.05, -0.012)), (28, (-0.05, -0.012)),
          (80, (-0.05, -0.012)), (86, (-0.01, -0.016)), (92, (0.04, -0.018)), (98, (0.04, -0.018)),
          (100, (-0.03, -0.035)), (106, (0.02, -0.04)), (112, (0.05, -0.02)), (116, (-0.03, 0.01))])
RIGHT_MON = Vector((-0.50, -0.93, 1.10))
LOOK_RIGHT = T([(0, 0.0), (30, 0.0), (34, 0.9), (36, 1.02), (40, 1.0), (52, 0.95), (56, 0.3), (58, 0.05),
                (62, 0.0)])
KEYS = Vector((0.0, -0.52, 0.80))
LOOK_KEYS = T([(0, 0.0), (72, 0.0), (75, 0.55), (79, 0.6), (82, 0.1), (84, 0.0)])
NOD = T([(0, 0.0), (108, 0.0), (111, 2.2), (114, -0.4), (117, 0.0)])


def _taps(f, hand):
    s = {k: 0.0 for k in "IMRPT"}
    press = 0.0
    for t, hd, fg, amp in EVENTS:
        if hd != hand:
            continue
        v = amp * S.tap(_wrap(f - t))
        if v == 0.0:
            continue
        s[fg] += v
        press = max(press, v)
        for nb, k in SYMPATHY.get(fg, {}).items():
            s[nb] += k * v
    return s, press


def _type_fingers(f, s, phase):
    out = {}
    for i, (k, fn) in enumerate(FINGERS.items()):
        v = s[k]
        live = math.sin(2 * math.pi * (2 + i) * f / N + phase + 1.7 * i)
        c1 = (v * LIFT[0] if v < 0 else v * PRESS[0]) + 1.0 * live
        c2 = (v * LIFT[1] if v < 0 else v * PRESS[1]) + 0.8 * live
        b1 = S.TYPE_F[f"LeftHand{fn}1"]
        b2 = S.TYPE_F[f"LeftHand{fn}2"]
        out[f"LeftHand{fn}1"] = (b1[0], b1[1] + c1, b1[2])
        out[f"LeftHand{fn}2"] = (b2[0], b2[1] + c2, b2[2])
    t = s["T"]
    down = 0.3 + (0.03 * t if t > 0 else 0.05 * t)
    out.update(B.left_thumb(0.6, 0.55, down, 12 + 3 * t))
    return out


def _mouse_fingers(f):
    c = CLICK(f)
    a = math.sin(2 * math.pi * 2 * f / N + 0.4)
    dx = MOUSE_DX(f)
    return merge(S.MOUSE_F, {
        "LeftHandIndex1": (0, c, 0),
        "LeftHandIndex2": (0, 0.4 * c, 0),
        "LeftHandMiddle1": (0, 0.15 * c + 0.6 * a, 0),
        "LeftHandRing1": (0, 0.8 * a - 250 * max(-dx, 0.0), 0),
        "LeftHandPinky1": (0, 1.0 * a - 400 * max(-dx, 0.0), 0),
    })


def _spine(f):
    br = math.sin(2 * math.pi * f / N + 0.9)
    br2 = math.sin(2 * math.pi * f / N + 0.5)
    lean = LEAN(f)
    look = LOOK_RIGHT(f - 3)  # the chest follows the head a few frames late
    reach = MOUSE(f - 2)
    return merge(B.SIT_SPINE, {
        "Hips": (1.8 * lean, 0, 0.5 * look + 0.6 * reach),
        "Spine": (0.2 * br + 1.2 * lean, 0, -0.5 * look - 0.6 * reach),
        "Spine1": (-0.45 * br + 2.2 * lean, 0, -1.2 * look - 1.0 * reach),
        "Spine2": (-0.6 * br2 + 2.8 * lean, 0, -2.0 * look - 1.4 * reach),
        "Neck": (4.0 * lean, 0, 0),
    }), br2


def _gaze(f):
    dx, dz = READ(f)
    centre = B.MONITOR + Vector((0.6 * dx, 0.0, 0.6 * dz))
    g = centre.lerp(RIGHT_MON, LOOK_RIGHT(f))
    return g.lerp(KEYS, LOOK_KEYS(f))


def pose_at(f):
    p, br2 = _spine(f)
    p.update(B.sit_legs(p))
    lagged, _ = _spine(f - 1.5)
    hd = B.look_at(lagged, _gaze(f), neck_share=0.35)
    p["Neck"] = hd["Neck"]
    w = 2 * math.pi * f / N
    drift = (0.35 * math.sin(3 * w + 0.3), 0.3 * math.sin(2 * w + 1.4), 0.4 * math.sin(4 * w + 0.7))
    tilt = -1.0 * LOOK_RIGHT(f - 1) - 0.8 * LEAN(f - 1)
    p["Head"] = merge({"Head": hd["Head"]}, {"Head": (drift[0] + NOD(f), drift[1] + tilt, drift[2])})["Head"]

    arms = {}
    # left hand: always on the keys
    s, press = _taps(f, "L")
    dw = WRIST_L(f) + Vector((0, 0, -PRESS_DIP * press))
    tl = S.type_tgt(1, dw, sh=(0.0, -0.6 * br2, 60.0 * dw.y), fing=_type_fingers(f, s, 0.0))
    arms.update(S.solve(p, 1, tl))
    # right hand: keys <-> mouse
    s, press = _taps(f, "R")
    dw = WRIST_R(f) + Vector((0, 0, -PRESS_DIP * press))
    tk = S.type_tgt(-1, dw, sh=(0.0, -0.6 * br2, 60.0 * dw.y), fing=_type_fingers(f, s, 2.1))
    tm = S.mouse_tgt(MOUSE_DX(f), MOUSE_DY(f), sh=(0.0, -0.6 * br2, 0.0), fing=_mouse_fingers(f))
    m = MOUSE(f)
    tr = S.mix(tk, tm, m, lift=REACH_LIFT, s_rot=MOUSE(f + 1.5), s_fing=MOUSE(f - 1.0))
    arms.update(S.solve(p, -1, tr))
    return B.override(p, arms)


def build(anim):
    extra = [t + d for t, *_ in EVENTS for d in (-2, 0, 2)]
    for tr in (MOUSE, CLICK, LOOK_RIGHT, LOOK_KEYS, LEAN):
        extra += tr.frames()
    for f in S.key_frames(N, 2, extra, dense=((30, 40), (68, 80))):
        anim.key(f, pose_at(f % N))
