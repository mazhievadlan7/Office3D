"""Reading at the workstation (SitRead): 180 frames at 30 fps, cyclic.

Frame 0 is SitIdle's frame 0 (right hand on the mouse, left wrist on the
desk, eyes on the centre monitor), so the two crossfade cleanly.

Beat sheet (frames):
   0-50   reads line by line: the eyes sweep slowly left to right along a line
          and snap back to the next one; a scroll (three index flicks on the
          wheel) at 20-28 and the eyes jump back up the page
  50-56   sits back a little
  56-72   the left hand comes up to the brow (index and middle fingertips on
          it, thumb toward the temple), the head dips a touch to meet it
  72-118  rubs the brow in two slow circles while reading on; another scroll
          at 90-98
  118-136 the hand goes back down to the desk
  136-180 leans in to read closely, a last scroll at 150-158, a small mouse
          move and a click at 168, and settles into frame 0

The brow contact is solved in head space every key (like SitIdle's chin),
so the fingertips stay on the brow while the head reads and breathes.
"""

import math

from mathutils import Quaternion, Vector

import _base as B
import _seat as S
from pose import merge

NAME = "SitRead"
FRAMES = 180
CYCLIC = True
N = FRAMES


def T(keys):
    return S.Track(keys, period=N)


# --- reading gaze ----------------------------------------------------------------
def _reading():
    """Gaze (x, z) on the centre monitor: lines read left to right (~14
    frames a line), a quick return sweep, scrolls reset to the top."""
    pts = []
    top, line_h = 0.05, 0.018

    def lines(f0, f1, first_line):
        f, ln = f0, first_line
        while f + 16 <= f1:
            z = top - ln * line_h
            pts.append((f, (-0.11, z)))
            pts.append((f + 13, (0.10, z - 0.002)))
            f += 16
            ln += 1
        return f

    lines(0, 20, 2)
    pts.append((22, (0.0, -0.02)))  # watching the page move
    pts.append((28, (0.0, 0.03)))
    lines(30, 90, 0)
    pts.append((92, (0.02, -0.03)))
    pts.append((98, (0.0, 0.04)))
    lines(100, 150, 0)
    pts.append((152, (0.0, -0.03)))
    pts.append((158, (0.0, 0.04)))
    lines(160, 176, 0)
    pts.append((177, (-0.06, 0.02)))
    return T(pts)


READ = _reading()
LEAN = T([(0, 0.0), (40, 0.3), (50, 0.2), (56, -1.2), (70, -1.4), (110, -1.0), (130, -0.6), (140, 0.2),
          (150, 1.3), (166, 1.4), (174, 0.5)])
BREATH = T([(0, 0.0), (30, 1.0), (75, -0.6), (110, 0.8), (150, -0.8)])

# --- right hand: mouse and wheel ------------------------------------------------------
SCROLLS = (20, 90, 150)


def _flicks(f0):
    # three pulls on the wheel: the index curls ~10 deg and lets go
    out = []
    for k in range(3):
        c = f0 + 1 + 3 * k
        out += [(c - 1, 0.0), (c, 10.0), (c + 1, 3.0), (c + 2, 0.0)]
    return out


WHEEL = T([(0, 0.0)] + sum((_flicks(s) for s in SCROLLS), []) + [(165, 0.0), (166, -5.0), (168, 6.0),
                                                                    (170, 4.5), (172, -1.0), (174, 0.0)])
MOUSE_DX = T([(0, 0.0), (158, 0.0), (162, 0.006), (166, 0.0065), (172, 0.004), (178, 0.0)])
MOUSE_DY = T([(0, 0.0), (158, 0.0), (163, -0.003), (172, -0.002), (178, 0.0)])

# --- left hand: desk <-> brow -------------------------------------------------------------
UP = T([(0, 0.0), (56, 0.0), (62, 0.35), (68, 0.88), (72, 1.0), (118, 1.0), (122, 0.9), (128, 0.4),
        (134, 0.04), (137, 0.0)])
# Rub: contact offset in head space (x across, z up), two slow circles.
RUB_X = T([(0, 0.0), (72, 0.0), (80, 0.006), (88, 0.0), (95, -0.005), (102, 0.0), (108, 0.006), (113, 0.0),
           (118, 0.0)])
RUB_Z = T([(0, 0.0), (72, 0.0), (76, 0.004), (84, 0.0), (91, -0.004), (98, 0.0), (104, 0.004), (110, -0.003),
           (116, 0.0)])
BROW = Vector((0.032, -0.081, 1.714))  # head rest space, on the brow left of centre
BROW_N = Vector((0.12, -0.95, 0.25)).normalized()
PAD = 0.007
BROW_FWD = Vector((-0.72, 0.22, 0.64))  # fingers inward and up (head space)
BROW_PALM = Vector((0.1, 0.9, -0.4))  # pads toward the face
BROW_POLE = Vector((0.26, -0.16, -0.46))
TWO_F = merge({  # index and middle out to touch, ring and pinky tucked
    "LeftHandIndex1": (-2, 10, 0),
    "LeftHandIndex2": (0, 12, 0),
    "LeftHandMiddle1": (0, 12, 0),
    "LeftHandMiddle2": (0, 14, 0),
    "LeftHandRing1": (2, 48, 0),
    "LeftHandRing2": (0, 56, 0),
    "LeftHandPinky1": (5, 56, 0),
    "LeftHandPinky2": (0, 60, 0),
}, B.left_thumb(0.6, 0.55, 0.05, 6))


def _spine(f):
    lean = LEAN(f)
    br = BREATH(f)
    br2 = BREATH(f - 5)
    up = UP(f - 2)
    return merge(B.SIT_SPINE, {
        "Hips@": (0.0, -0.0014 * lean, 0.0),
        "Hips": (0.5 * lean, 0, 0),
        "Spine": (0.25 * lean + 0.25 * br, 0, 0.3 * up),
        "Spine1": (0.25 * lean - 0.5 * br, 0, 0.5 * up),
        "Spine2": (0.3 * lean - 0.7 * br2 + 0.8 * up, 0, 0.6 * up),
    }), br2


def _gaze(f):
    dx, dz = READ(f)
    return B.MONITOR + Vector((0.55 * dx, 0.0, 0.55 * dz - 0.01))


def _brow_tgt(p, f, sh):
    c = BROW + Vector((RUB_X(f), 0.0, RUB_Z(f))) + BROW_N * PAD
    target = S.head_space(p, c)
    fwd = S.head_dir(p, BROW_FWD)
    palm = S.head_dir(p, BROW_PALM)
    return S.contact_tgt(p, 1, "LeftHandMiddle2", target, fwd, palm, BROW_POLE, sh, TWO_F)


def pose_at(f):
    p, br2 = _spine(f)
    p.update(B.sit_legs(p))
    lead = B.look_at(p, _gaze(f + 2))
    p["Neck"] = lead["Neck"]
    p = B.look_at(p, _gaze(f), neck_share=0.0)
    up = UP(f)
    # the head dips and turns a touch toward the hand (meets it)
    p = merge(p, {"Head": (3.0 * up, 1.5 * up, -2.0 * up)})

    arms = {}
    # right hand on the mouse, index on the wheel
    c = WHEEL(f)
    a = math.sin(2 * math.pi * 2 * f / N + 0.4)
    fing = merge(S.MOUSE_F, {"LeftHandIndex1": (0, c, 0), "LeftHandIndex2": (0, 0.5 * c, 0),
                             "LeftHandMiddle1": (0, 0.15 * c + 0.6 * a, 0), "LeftHandRing1": (0, 0.7 * a, 0)})
    arms.update(S.solve(p, -1, S.mouse_tgt(MOUSE_DX(f), MOUSE_DY(f), sh=(0, -0.6 * br2, 0), fing=fing)))

    # left hand: desk <-> brow along an arc, the hand turning a little behind the wrist
    going_up = 50 <= f < 100
    sh_desk = (0.0, -0.6 * br2, 0.0)
    sh_brow = (0.0, -4.0, -4.0)
    desk = S.desk_tgt(sh=sh_desk)
    if up <= 0.0:
        tl = desk
    else:
        brow = _brow_tgt(p, f, sh_brow)
        s_rot = UP(f - 2.5) if going_up else UP(f + 2)
        s_fing = UP(f - 4) if going_up else UP(f + 1)
        lift = (0.07, -0.05, 0.02) if going_up else (0.09, -0.07, 0.0)
        tl = S.mix(desk, brow, up, lift=lift, s_rot=s_rot, s_fing=s_fing) if up < 0.999 else brow
    arms.update(S.solve(p, 1, tl))
    return B.override(p, arms)


def build(anim):
    extra = UP.frames() + WHEEL.frames()
    for f in S.key_frames(N, 2, extra, dense=((56, 74), (116, 138))):
        anim.key(f, pose_at(f % N))
