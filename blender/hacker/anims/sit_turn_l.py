"""Talking with the neighbour on the left, seated (SitTurnL): 144 frames at
30 fps. Intro, a HELD loop and an outro in one clip:

    0-16  from SitIdle's frame 0 he turns to the neighbour on his left
          (desk pitch 1.6 m: their head at x +1.6): pelvis ~12 deg (the knees
          stay inside the armrests), chest ~30 deg, the head the rest of the
          way; the left hand lifts off the desk (up first, over the desk
          edge) and its forearm settles on the left armrest; the right hand
          stays on the mouse
   16-128 HOLD (the app loops it while they talk):
     16-72    TALKS: breath in, the left hand comes up palm up and explains
              (two beats with nods, opens out toward the listener, back to
              himself), then settles back on the armrest
     72-128   LISTENS: leans back a touch, two slow nods ("mm-hm"), a head
              tilt, the fingers tap the armrest
          Frames 16, 72 and 128 are the same pose standing still, so the app
          can start the partner (SitTurnR) half a loop later: one talks while
          the other listens, and a turn can begin either way.
  128-144 the reverse, exactly SitIdle's frame 0 at 144

SitTurnR is this clip mirrored (sit_turn_r.py). HQ_CLIP_INFO: hold [16/30,
128/30] s, talk window [16/30, 72/30] s.
"""

import math

from mathutils import Vector

import _base as B
import _seat as S
from pose import merge

NAME = "SitTurnL"
FRAMES = 144
CYCLIC = False
N = FRAMES
HOLD = (16, 128)
TALK = (16, 72)
H0, H1 = HOLD
MID = TALK[1]

# build tools: where the partner's workstation is in the preview (x, y, yaw deg)
PREVIEW_PARTNER = (1.6, 0.0, 0.0)
NEIGHBOUR = Vector((1.55, -0.12, 1.24))  # the partner's eyes (turned toward us)

TURN = S.Track([(0, 0.0), (3, 0.05), (11, 0.9), (14, 1.0), (H0, 1.0), (H1, 1.0), (130, 1.0), (137, 0.1),
                (141, 0.0), (144, 0.0)])
# lean toward the listener while talking (+), back a touch while listening (-)
LEAN = S.Track([(0, 0.0), (H0, 0.0), (26, 0.8), (50, 1.0), (64, 0.3), (MID, 0.0), (MID + 2, 0.0), (80, -0.6), (118, -0.7),
                (H1, 0.0), (144, 0.0)])
BREATH = S.Track([(0, 0.0), (H0, 0.0), (21, 1.0), (40, 0.3), (56, 0.7), (MID, 0.0), (90, 0.6), (110, -0.4),
                  (H1, 0.0), (144, 0.0)])
NOD = S.Track([(0, 0.0), (H0, 0.0), (25, -1.0), (28, 4.5), (31, -0.5), (34, 0.0), (43, -1.0), (46, 4.0),
               (49, 0.0), (MID, 0.0), (82, 0.0), (86, 5.0), (89, 0.5), (92, 4.0), (96, 0.0), (108, 0.0),
               (112, 3.0), (116, 0.0), (H1, 0.0), (144, 0.0)])
TILT = S.Track([(0, 0.0), (H0, 0.0), (36, 1.5), (52, -1.0), (MID, 0.0), (MID + 2, 0.0), (84, 3.5), (104, 4.0), (120, 1.0),
                (H1, 0.0), (144, 0.0)])
# while talking the eyes sometimes drop to his own hand / the space between them
GLANCE = S.Track([(0, 0.0), (H0, 0.0), (34, 0.0), (38, 0.5), (44, 0.45), (48, 0.0), (MID, 0.0), (H1, 0.0),
                  (144, 0.0)])
ENDS = S.Track([(0, 1.0), (3, 0.4), (6, 0.0), (138, 0.0), (141, 0.4), (144, 1.0)])

# The left forearm on the armrest pad (top z 0.67, x 0.235..0.315, y -0.09..0.18).
ARMREST = S.Tgt((0.283, -0.115, 0.715), (-0.12, -0.96, -0.25), (-0.15, 0.05, -1.0), (0.18, 0.35, -0.45),
                (0, 2, -1), S.SOFT_F)


def _g(w, fwd, palm, fing=S.SOFT_F, sh=(0, 1, -2), pole=(0.35, 0.25, -0.5)):
    return S.Tgt(w, fwd, palm, pole, sh, fing)


G1 = _g((0.30, -0.24, 0.90), (0.35, -0.9, 0.2), (-0.55, -0.1, 0.83))
G1B = _g((0.305, -0.25, 0.865), (0.35, -0.9, 0.05), (-0.5, -0.15, 0.85))
G2 = _g((0.39, -0.17, 0.95), (0.75, -0.6, 0.15), (-0.1, -0.2, 0.97), fing=S.OPEN_F, sh=(0, 0.5, -3))
G2B = _g((0.385, -0.18, 0.92), (0.75, -0.62, 0.05), (-0.08, -0.22, 0.97), fing=S.OPEN_F, sh=(0, 0.5, -3))
G3 = _g((0.24, -0.21, 0.94), (-0.3, -0.85, 0.35), (-0.8, 0.1, 0.5), sh=(0, 1.5, -1.5))
DOWN = _g((0.29, -0.16, 0.80), (0.1, -0.9, -0.35), (-0.4, 0.05, -0.9))


# the hand crossing the desk's front edge (y -0.36), well above it
OVER_EDGE = S.Tgt((0.30, -0.30, 0.86), (-0.15, -0.9, -0.4), (-0.4, 0.0, -0.9), (0.25, 0.2, -0.5), (0, 2, -2),
                  S.SOFT_F)


def _desk(p, f):
    return S.desk_tgt()


def _desk_lifted(p, f):
    return S.desk_tgt(dw=(-0.01, 0.035, 0.05))


LEFT = S.Path([
    (0, _desk), (4, _desk_lifted), (8, OVER_EDGE), (12, ARMREST.moved((0.0, -0.02, 0.05))), (H0, ARMREST),
    (20, ARMREST.moved((0.0, -0.01, 0.02))), (24, G1), (28, G1B), (32, G1), (38, G2), (46, G2B), (50, G2),
    (56, G3), (62, DOWN), (68, ARMREST.moved((0.0, 0.0, 0.006))), (MID, ARMREST),
    (H1, ARMREST), (132, ARMREST.moved((0.0, -0.02, 0.05))), (136, OVER_EDGE), (140, _desk_lifted),
    (144, _desk),
], rot_lag=1.5, fing_lag=2.5)
# fingers tapping the armrest while listening (curl offsets, degrees)
TAPS = S.Track([(0, 0.0), (88, 0.0)] + sum(([(t - 2, 0.0), (t, 9.0), (t + 2, 0.0)] for t in (92, 96, 100, 104)),
                                           []) + [(110, 0.0), (144, 0.0)])


def _mouse(f):
    t = TURN(f)
    # the hand stays on the mouse; the turn rolls it onto its side a little
    return S.mouse_tgt(0.002 * t, 0.004 * t, sh=(0, 1.0 * t, 2.0 * t))


def raw_pose_at(f):
    """The clip's own pose, before the ends are blended onto SitIdle."""
    t, lean, br = TURN(f), LEAN(f), BREATH(f)
    p = merge(B.SIT_SPINE, {
        "Hips": (1.0 * lean, 0, 12.0 * t),
        "Spine": (0.8 * lean + 0.3 * br, 0.6 * TILT(f - 4), 5.0 * t),
        "Spine1": (1.0 * lean - 0.6 * br, 0.4 * TILT(f - 4), 6.0 * t),
        "Spine2": (1.2 * lean - 0.9 * br, 0, 7.0 * t),
    })
    p.update(B.sit_legs(p))
    mon = B.MONITOR
    gaze = mon.lerp(NEIGHBOUR, min(1.0, TURN(f + 1.5) * 1.02))
    gaze = gaze.lerp(Vector((0.55, -0.35, 0.95)), GLANCE(f))
    p = B.look_at(p, gaze, neck_share=0.4)
    p = merge(p, {"Neck": (0.35 * NOD(f - 1), 0.4 * TILT(f), 0), "Head": (0.65 * NOD(f), 0.6 * TILT(f), 0)})
    tl = LEFT(p, f)
    tap = TAPS(f)
    if tap:
        tl.fing = merge(tl.fing, {"LeftHandIndex1": (0, tap, 0), "LeftHandMiddle1": (0, 0.6 * TAPS(f - 1), 0)})
    arms = S.solve(p, 1, tl)
    arms.update(S.solve(p, -1, _mouse(f)))
    return B.override(p, arms)


def pose_at(f):
    p = raw_pose_at(f)
    e = ENDS(f)
    if e > 0:
        p = S.lerp_pose(p, S.base_idle(), e)
    return p


def build(anim):
    extra = [int(k) for k, _ in LEFT.keys] + NOD.frames()
    for f in S.key_frames(N, 2, extra):
        anim.key(f, S.base_idle() if f in (0, N) else pose_at(f))
