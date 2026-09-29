"""Showing the screen to a colleague at the shoulder (SitShowScreen): 144
frames at 30 fps. Intro, a HELD loop and an outro in one clip. The guest
stands behind his right shoulder (HQ_SHOULDER in config.ts: 0.55 m to his
right, 0.42 m behind the chair centre) playing StandLookOver.

    0-16  from SitIdle's frame 0: the chest turns a little to the right
          (toward the guest) and the head glances up at them and back
   16-128 HOLD (the app loops it while the guest stays):
     16-30    a glance up over the right shoulder, a nod
     30-80    the right hand leaves the mouse and points: first at the centre
              monitor (a tap toward the line in question), then over to the
              right monitor; the eyes follow the finger
     80-90    the hand comes back down onto the mouse
     90-112   clicks through something; eyes on the screen
     112-128  another glance up at the guest, and back
          Frames 16 and 128 are the same pose, still.
  128-144 back to SitIdle's frame 0 (144)

The left hand stays on the desk. HQ_CLIP_INFO: hold [16/30, 128/30] s.
"""

from mathutils import Vector

import _base as B
import _seat as S
from pose import merge

NAME = "SitShowScreen"
FRAMES = 144
CYCLIC = False
N = FRAMES
HOLD = (16, 128)
H0, H1 = HOLD

# Where the head turns to look at the guest: toward their face, but the head
# stops ~80 deg round; the eyes would do the rest.
GUEST = Vector((-0.95, -0.05, 1.60))
SPOT1 = Vector((0.05, -0.95, 1.02))  # a line on the centre monitor
SPOT2 = Vector((-0.50, -0.90, 1.10))  # the right monitor

TURN = S.Track([(0, 0.0), (12, 1.0), (H0, 1.0), (H1, 1.0), (132, 1.0), (144, 0.0)])
LOOK_GUEST = S.Track([(0, 0.0), (4, 0.0), (9, 0.75), (11, 0.75), (15, 0.0), (H0, 0.0), (18, 0.0), (22, 0.95),
                      (27, 1.0), (31, 0.0), (80, 0.0), (84, 0.6), (89, 0.65), (93, 0.0), (112, 0.0), (116, 0.9),
                      (122, 0.95), (126, 0.0), (H1, 0.0), (144, 0.0)])
# which spot the eyes are on: 0 centre (neutral), 1 SPOT1, 2 SPOT2
SPOT = S.Track([(0, 0.0), (H0, 0.0), (33, 0.0), (37, 1.0), (54, 1.0), (58, 2.0), (76, 2.0), (82, 0.0),
                (H1, 0.0), (144, 0.0)])
NOD = S.Track([(0, 0.0), (H0, 0.0), (23, 0.0), (25, 4.0), (28, 0.5), (29, 0.0), (44, 0.0), (46, 2.5),
               (48, 0.0), (86, 0.0), (88, 3.0), (90, 0.0), (117, 0.0), (119, 3.5), (122, 0.0), (H1, 0.0),
               (144, 0.0)])
BREATH = S.Track([(0, 0.0), (H0, 0.0), (44, 1.0), (72, -0.5), (100, 0.8), (H1, 0.0), (144, 0.0)])
ENDS = S.Track([(0, 1.0), (3, 0.4), (6, 0.0), (138, 0.0), (141, 0.4), (144, 1.0)])

POINT1 = S.Tgt((-0.14, -0.51, 0.98), (0.22, -0.93, 0.28), (-0.35, -0.2, -0.92), (-0.3, 0.1, -0.45), (0, 0, -5),
               S.POINT_F)
POINT1B = POINT1.moved((0.005, -0.03, 0.006))
POINT2 = S.Tgt((-0.28, -0.50, 1.01), (-0.35, -0.88, 0.32), (0.3, -0.25, -0.92), (-0.35, 0.1, -0.4), (0, 0, -5),
               S.POINT_F)
POINT2B = POINT2.moved((-0.01, -0.025, 0.004))
HOVER = S.Tgt((-0.28, -0.46, 0.88), (0.05, -0.97, -0.2), (0.2, 0.0, -1.0), (-0.28, 0.06, -0.5), (0, 1, -3),
              S.SOFT_F)


def _mouse(p, f):
    return S.mouse_tgt()


def _mouse_up(p, f):
    return S.mouse_tgt().moved((0.0, 0.02, 0.045))


RIGHT = S.Path([
    (0, _mouse), (H0, _mouse), (28, _mouse), (32, _mouse_up), (38, POINT1), (44, POINT1B), (47, POINT1),
    (52, POINT1), (60, POINT2), (66, POINT2B), (69, POINT2), (74, POINT2), (80, HOVER), (85, _mouse_up),
    (89, _mouse), (H1, _mouse), (144, _mouse),
], rot_lag=1.0, fing_lag=2.0)
CLICK = S.Track([(0, 0.0), (94, 0.0), (96, -5.0), (98, 6.0), (100, 0.0), (104, -5.0), (106, 6.0), (107, 1.0),
                 (108, 6.0), (110, 0.0), (144, 0.0)])


def pose_at(f):
    t, br = TURN(f), BREATH(f)
    lg = LOOK_GUEST(f - 3)  # the chest follows the head a little, late
    p = merge(B.SIT_SPINE, {
        "Hips": (0, 0, -3.0 * t),
        "Spine": (0.3 * br, 0, -2.0 * t - 2.0 * lg),
        "Spine1": (-0.5 * br, 0, -2.0 * t - 3.0 * lg),
        "Spine2": (-0.8 * br - 1.5 * lg, -1.0 * lg, -2.5 * t - 4.0 * lg),
    })
    p.update(B.sit_legs(p))
    sp = SPOT(f)
    screen = B.MONITOR.lerp(SPOT1, min(sp, 1.0)).lerp(SPOT2, max(sp - 1.0, 0.0))
    gaze = screen.lerp(GUEST, LOOK_GUEST(f))
    p = B.look_at(p, gaze, neck_share=0.45)
    p = merge(p, {"Neck": (0.3 * NOD(f - 1), 0, 0), "Head": (0.7 * NOD(f), -3.0 * LOOK_GUEST(f), 0)})
    tr = RIGHT(p, f)
    c = CLICK(f)
    if c:
        tr.fing = merge(tr.fing, {"LeftHandIndex1": (0, c, 0), "LeftHandIndex2": (0, 0.4 * c, 0)})
    arms = S.solve(p, -1, tr)
    arms.update(S.solve(p, 1, S.desk_tgt(sh=(0, -0.6 * br, 0))))
    p = B.override(p, arms)
    e = ENDS(f)
    if e > 0:
        p = S.lerp_pose(p, S.base_idle(), e)
    return p


def build(anim):
    extra = [int(k) for k, _ in RIGHT.keys] + LOOK_GUEST.frames() + NOD.frames()
    for f in S.key_frames(N, 2, extra):
        anim.key(f, S.base_idle() if f in (0, N) else pose_at(f))
