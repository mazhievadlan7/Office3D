"""Standing and listening (StandListen): 150 frames at 30 fps, cyclic, in
place. For listeners at a social spot and at a briefing.

The hands are loosely clasped in front of the hips (fingers interlaced,
thumbs fidgeting) the whole loop, so the app can enter it at any frame; the
weight rolls onto the left leg, back through the middle onto the right, and
home; the head answers with nods at its own moments:
   14-24  a single small nod
   58-74  a double "mm-hm"
  112-124 a slow, deeper nod
and tilts a little one way, then the other. The eyes stay on the speaker
straight ahead (the app's look-at turns the head to them on near agents).

Feet are planted with leg_ik and the pelvis height keeps the straighter knee
slightly flexed (idle.py's solve); the clasp lives in chest space so the
hands ride the weight shift.
"""

import math

from mathutils import Vector

import _base as B
import _seat as S
import idle as I
from pose import merge, mirror

NAME = "StandListen"
FRAMES = 150
CYCLIC = True
N = FRAMES


def T(keys):
    return S.Track(keys, period=N)


WEIGHT = T([(0, 0.0), (14, 0.5), (30, 0.85), (52, 0.8), (70, 0.2), (86, -0.6), (100, -0.8), (120, -0.7),
            (138, -0.25)])
BREATH = T([(0, 0.0), (18, 1.0), (50, 0.1), (75, 0.9), (105, 0.0), (128, 0.8)])
NOD = T([(0, 0.0), (14, 0.0), (17, 3.5), (21, 0.3), (24, 0.0), (58, 0.0), (61, 4.0), (64, 0.5), (67, 3.5),
         (71, 0.0), (112, 0.0), (117, 6.0), (122, 0.8), (125, 0.0)])
TILT = T([(0, 0.0), (30, 2.5), (60, 3.2), (80, 0.5), (100, -2.0), (128, -2.4), (140, -0.8)])
GAZE_X = T([(0, 0.0), (40, 0.08), (80, -0.05), (110, -0.12), (135, 0.02)])
THUMB = T([(0, 0.0), (20, 0.0), (26, 1.0), (32, 0.0), (38, 1.0), (44, 0.0), (90, 0.0), (96, 1.0), (104, 0.2),
           (110, 0.0)])

ANKLE_L = I.ANKLE[1]
ANKLE_R = I.ANKLE[-1]
BASE = I.BASE

# the clasp (left hand; x mirrored), chest space of STAND
_R2, _T2 = B.fk(B.STAND, "Spine2")
_R2I = _R2.inverted()
CLASP_W = _R2I @ (Vector((0.068, -0.175, 0.905)) - _T2)
CLASP_FWD = _R2I @ Vector((-0.75, -0.25, -0.6))
CLASP_PALM = _R2I @ Vector((-0.35, 0.55, 0.3))
CLASP_POLE = _R2I @ Vector((0.35, 0.25, -0.1))


def _body(f):
    w = WEIGHT(f)
    br = BREATH(f)
    p = merge(BASE, {
        "Hips": (0.0, -2.2 * WEIGHT(f - 1), 1.6 * WEIGHT(f - 2)),
        "Spine": (-0.2 * br, 1.2 * WEIGHT(f - 3), -0.6 * WEIGHT(f - 4)),
        "Spine1": (-0.5 * br, 1.3 * WEIGHT(f - 4), -0.5 * WEIGHT(f - 5)),
        "Spine2": (0.8 - 0.8 * br, 1.0 * WEIGHT(f - 5), -0.4 * WEIGHT(f - 6)),
        "LeftShoulder": (0.0, -1.0 * br, 0.6 * br),
        "RightShoulder": (0.0, 1.0 * br, -0.6 * br),
    })
    sway = 0.003 * math.sin(2 * math.pi * f / N + 1.1)
    p["Hips@"] = (0.034 * w, sway, 0.0)
    p["Hips@"] = (0.034 * w, sway, I._hips_z(p, 5.0 + 3.0 * abs(WEIGHT(f + 2) - WEIGHT(f - 2))))
    return p


def _legs(p, f):
    out = {}
    for side, pre in I.SIDES:
        hip = B.joint(p, pre + "UpLeg")
        free = max(0.0, min(1.0, -WEIGHT(f) * side))
        pole = hip + Vector((side * (0.08 - 0.3 * free), -1.0, -0.4))
        out.update(B.leg_ik(p, side, ANKLE_L if side > 0 else ANKLE_R, pole, I.TOE_OUT[side]))
        out[pre + "ToeBase"] = (0.0, 0.0, 0.0)
    return out


def _clasp(p, side, f):
    r2, t2 = B.fk(p, "Spine2")

    def m(v):
        return r2 @ Vector((v.x * side, v.y, v.z))

    w = r2 @ Vector((CLASP_W.x * side, CLASP_W.y, CLASP_W.z)) + t2
    fing = dict(S.CLASP_F)
    th = THUMB(f + (0 if side > 0 else 3))
    fing.update(B.left_thumb(0.7, 0.55 - 0.15 * th, 0.35 + 0.2 * th, 16 + 10 * th))
    return S.Tgt(w, m(CLASP_FWD), m(CLASP_PALM), m(CLASP_POLE), (0, 3, -1), fing)


def pose_at(f):
    p = _body(f)
    p.update(_legs(p, f))
    p = B.look_at(p, Vector((GAZE_X(f), -2.2, 1.6)), neck_share=0.4)
    p = merge(p, {"Neck": (0.35 * NOD(f - 1), 0.4 * TILT(f - 2), 0), "Head": (0.65 * NOD(f), 0.6 * TILT(f), 0)})
    arms = {}
    for s in (1, -1):
        arms.update(S.solve(p, s, _clasp(p, s, f)))
    return B.override(p, arms)


def build(anim):
    for f in S.key_frames(N, 3, NOD.frames() + THUMB.frames()):
        anim.key(f, pose_at(f % N))
