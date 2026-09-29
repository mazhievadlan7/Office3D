"""A stretch at the desk (SitStretch): 150 frames at 30 fps, ONE SHOT, from
SitType's frame 0 back to it (the app plays it once, then types on).

Beat sheet (frames):
   0-14   the hands lift off the keys and draw back a little
  14-36   both arms rise in front of the chest (fingers up, palms in), the
          right a couple of frames behind the left, and meet over the head
  36-64   fingers interlaced, palms up, the arms push up; the back arches,
          the head goes back (a yawn), a lean to the left and to the right
  64-84   the hands come down behind the head, elbows out, and he leans
          back into the chair
  84-106  holds there, breathing out
  106-140 the hands come round the sides of the head, forward and down onto
          the keys (they arrive from above, wrists last)
  140-150 settles exactly into SitType's frame 0

Legs are solved every key (feet planted); the arms follow keyed hand targets
(_seat.Path); the first and last frames are blended onto SitType's frame 0 so
the crossfades in and out are between identical poses.
"""

from mathutils import Vector

import _base as B
import _seat as S
from pose import merge

NAME = "SitStretch"
FRAMES = 150
CYCLIC = False
N = FRAMES

EXT = S.Track([(0, 0.0), (14, 0.0), (26, 0.35), (40, 1.0), (50, 1.1), (60, 1.0), (72, 0.55), (84, 0.35),
               (106, 0.3), (122, 0.1), (140, 0.0), (150, 0.0)])
# lean back into the chair (pelvis and chest), hands behind the head
BACK = S.Track([(0, 0.0), (64, 0.0), (84, 1.0), (106, 1.0), (126, 0.2), (140, 0.0), (150, 0.0)])
SIDE = S.Track([(0, 0.0), (42, 0.0), (48, 1.0), (52, 1.0), (58, -0.9), (62, -0.9), (68, 0.0), (150, 0.0)])
YAWN = S.Track([(0, 0.0), (40, 0.0), (48, 1.0), (56, 1.0), (64, 0.0), (150, 0.0)])
LOOK_UP = S.Track([(0, 0.0), (18, 0.0), (36, 0.8), (60, 0.8), (76, 0.3), (104, 0.35), (128, 0.0), (150, 0.0)])
BREATH = S.Track([(0, 0.0), (20, 0.0), (44, 1.0), (60, 0.8), (90, -0.6), (110, -0.2), (150, 0.0)])
ENDS = S.Track([(0, 1.0), (4, 0.6), (10, 0.0), (140, 0.0), (146, 0.6), (150, 1.0)])


def _mirror_tgt(t):
    def mx(v):
        return Vector((-v[0], v[1], v[2]))
    return S.Tgt(mx(t.w), mx(t.fwd), mx(t.palm), mx(t.pole), t.sh, t.fing)


def _keys(side):
    """Hand targets for one side, authored for the LEFT hand (x mirrored)."""
    def m(t):
        return t if side > 0 else _mirror_tgt(t)

    def keys_on(dw=(0, 0, 0), pitch=0.0):
        return lambda p, f: S.type_tgt(side, dw, pitch)

    def behind_head(p, f):
        w = S.head_space(p, (0.095 * side, 0.19, 1.63))
        fwd = S.head_dir(p, (-1.0 * side, 0.0, 0.15))
        palm = S.head_dir(p, (0.0, -1.0, 0.0))
        return S.Tgt(w, fwd, palm, (0.45 * side, -0.02, 0.05), (0, -4, 0), S.CLASP_F)

    rise = m(S.Tgt((0.16, -0.24, 1.10), (-0.1, -0.3, 0.95), (-0.9, 0.2, 0.0), (0.3, 0.1, -0.5), (0, -3, 0),
                   S.OPEN_F))
    over = m(S.Tgt((0.062, -0.02, 1.47), (-1.0, 0.0, 0.1), (0.0, 0.0, 1.0), (0.4, 0.15, -0.1), (0, -9, 0),
                   S.CLASP_F))
    push = m(S.Tgt((0.058, -0.015, 1.50), (-1.0, 0.0, 0.1), (0.0, 0.0, 1.0), (0.4, 0.15, -0.1), (0, -11, 0),
                   S.CLASP_F))
    down = m(S.Tgt((0.15, 0.03, 1.40), (-0.8, 0.2, 0.4), (0.0, -0.5, 0.8), (0.45, 0.1, -0.2), (0, -7, 0),
                   S.CLASP_F))
    out = m(S.Tgt((0.25, -0.10, 1.26), (-0.25, -0.6, -0.5), (-0.7, 0.0, -0.6), (0.35, 0.15, -0.45), (0, -2, 0),
                  S.SOFT_F))
    over_keys = m(S.Tgt((0.14, -0.33, 0.93), (-0.2, -0.95, -0.2), (-0.25, -0.2, -1.0), (0.24, 0.05, -0.5),
                        (0, 0, -3), S.SOFT_F))
    lag = 0 if side > 0 else 2
    return [
        (0, keys_on()),
        (8 + lag, keys_on((0, 0.02, 0.03), 8.0)),
        (22 + lag, rise),
        (36 + lag, over),
        (50 + lag, push),
        (62 + lag, over),
        (72 + lag, down),
        (84 + lag, behind_head),
        (106 + lag, behind_head),
        (118 + lag, out),
        (130 + lag, over_keys),
        (140, keys_on((0, 0.004, 0.006), 2.0)),
        (150, keys_on()),
    ]


PATHS = {1: S.Path(_keys(1), rot_lag=1.5, fing_lag=2.5), -1: S.Path(_keys(-1), rot_lag=1.5, fing_lag=2.5)}


def pose_at(f):
    ext, back, side, br = EXT(f), BACK(f), SIDE(f - 2), BREATH(f)
    p = S.seated({
        "Hips@": (0.0, 0.0, 0.0),
        "Hips": (-2.5 * back - 1.0 * ext, 0, 0),
        "Spine": (-3.5 * ext - 2.0 * back + 0.3 * br, 2.0 * side, 0),
        "Spine1": (-5.0 * ext - 2.5 * back - 0.6 * br, 3.0 * side, 0),
        "Spine2": (-5.5 * ext - 2.0 * back - 0.9 * br, 3.0 * side, 0),
    })
    gaze = B.MONITOR.lerp(Vector((0.0, -0.7, 1.95)), LOOK_UP(f))
    p = B.look_at(p, gaze)
    y = YAWN(f)
    p = merge(p, {"Neck": (-4.0 * y, -1.0 * side, 0), "Head": (-7.0 * y, -1.5 * side, 0)})
    arms = {}
    for s in (1, -1):
        arms.update(S.solve(p, s, PATHS[s](p, f)))
    p = B.override(p, arms)
    e = ENDS(f)
    if e > 0:
        p = S.lerp_pose(p, S.base_type(), e)
    return p


def build(anim):
    extra = [k for k, _ in _keys(1)] + [k for k, _ in _keys(-1)]
    for f in S.key_frames(N, 2, extra):
        anim.key(f, S.base_type() if f in (0, N) else pose_at(f))
