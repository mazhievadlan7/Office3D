"""Leaning back to think (SitLeanBack): 180 frames at 30 fps. Intro, a HELD
loop and an outro in one clip:

   0-30   from SitIdle's frame 0 the hands leave the mouse and the desk (up
          first, clear of the desk edge), the pelvis slides forward, the back
          goes into the backrest and the hands come round to clasp behind
          the head, elbows out
  30-150  HOLD (the app loops this span while the beat lasts; frames 30 and
          150 are the same pose with the same motion): breathing, a slow
          rock of the chair, the eyes go up to the ceiling to think and come
          back to the screen
 150-180  the reverse: hands come round the head and down onto the mouse and
          the desk, the body comes forward, exactly SitIdle's frame 0 at 180

HQ_CLIP_INFO.SitLeanBack.hold = [30/30, 150/30] s in src/features/hq/core/config.ts.
"""

import math

from mathutils import Vector

import _base as B
import _seat as S
from pose import merge

NAME = "SitLeanBack"
FRAMES = 180
CYCLIC = False
N = FRAMES
HOLD = (30, 150)
H0, H1 = HOLD
HL = H1 - H0

RECL = S.Track([(0, 0.0), (6, 0.05), (20, 0.8), (28, 1.0), (H0, 1.0), (H1, 1.0), (152, 1.0), (166, 0.3),
                (174, 0.05), (180, 0.0)])
LIFE = S.Track([(0, 0.0), (22, 0.0), (H0, 1.0), (H1, 1.0), (158, 0.0), (180, 0.0)])
UP_L = Vector((0.35, -0.8, 1.65))
THINK = S.Track([(0, 0.0), (H0, 0.0), (36, 0.0), (52, 0.9), (70, 1.0), (84, 0.85), (100, 0.25), (112, 0.0),
                 (H1, 0.0), (180, 0.0)])
ENDS = S.Track([(0, 1.0), (4, 0.4), (8, 0.0), (172, 0.0), (176, 0.4), (180, 1.0)])
ANKLE_FWD = Vector((0.0, -0.12, 0.0))


def _cyc(f, k, ph=0.0):
    """k whole cycles over the hold span (seamless at 30/150), 0 outside it."""
    return math.sin(2 * math.pi * k * (f - H0) / HL + ph) * LIFE(f)


def _mirror_tgt(t):
    def mx(v):
        return Vector((-v[0], v[1], v[2]))
    return S.Tgt(mx(t.w), mx(t.fwd), mx(t.palm), mx(t.pole), t.sh, t.fing)


def _keys(side):
    def m(t):
        return t if side > 0 else _mirror_tgt(t)

    def base(p, f):
        return S.desk_tgt() if side > 0 else S.mouse_tgt()

    def lifted(p, f):
        return base(p, f).moved((0.0, 0.03, 0.045))

    def behind_head(p, f):
        pulse = 0.004 * _cyc(f, 2, 0.5 * side)
        w = S.head_space(p, (0.093 * side, 0.19 + pulse, 1.63))
        fwd = S.head_dir(p, (-1.0 * side, 0.0, 0.15))
        palm = S.head_dir(p, (0.0, -1.0, 0.0))
        return S.Tgt(w, fwd, palm, (0.46 * side, -0.02, 0.08), (0, -4, 0), S.CLASP_F)

    out = m(S.Tgt((0.25, -0.10, 1.12), (-0.25, -0.6, 0.5), (-0.8, 0.2, 0.2), (0.35, 0.15, -0.35), (0, -2, 0),
                  S.SOFT_F))
    lag = 0 if side > 0 else 1.5
    return [
        (0, base), (6 + lag, lifted), (16 + lag, out), (28 + lag, behind_head), (H0 + 2, behind_head),
        (H1 - 2, behind_head), (152 - lag, behind_head), (164 - lag, out), (174 - lag, lifted), (180, base),
    ]


PATHS = {s: S.Path(_keys(s), rot_lag=1.5, fing_lag=2.0) for s in (1, -1)}


def pose_at(f):
    r = RECL(f)
    rock = _cyc(f, 1, 0.0)
    br = _cyc(f, 2, 1.2)
    p = merge(B.SIT_SPINE, {
        "Hips@": (0.0, -0.075 * r, -0.03 * r),
        "Hips": (-15.0 * r - 0.8 * rock, 0, 0.6 * _cyc(f, 1, 2.0)),
        "Spine": (-3.0 * r + 0.3 * br, 0, 0),
        "Spine1": (-2.5 * r - 0.5 * br, 0, 0),
        "Spine2": (0.5 * r - 0.8 * br, 0, 0),
    })
    # feet slide forward with the pelvis (legs stretched a little)
    legs = B.leg_ik(p, 1, B.SIT_ANKLE_L + ANKLE_FWD * r, B.SIT_KNEE_POLE, B.SIT_TOE_OUT_L)
    pole_r = Vector((-B.SIT_KNEE_POLE.x, B.SIT_KNEE_POLE.y, B.SIT_KNEE_POLE.z))
    legs.update(B.leg_ik(p, -1, B.SIT_ANKLE_R + ANKLE_FWD * r * 1.15, pole_r, B.SIT_TOE_OUT_R))
    legs.update({"LeftToeBase": (0, 0, 0), "RightToeBase": (0, 0, 0)})
    p.update(legs)
    gaze = (B.MONITOR + Vector((0.0, 0.0, -0.02))).lerp(UP_L, THINK(f))
    p = B.look_at(p, gaze, neck_share=0.45)
    p = merge(p, {"Head": (0.6 * _cyc(f, 3, 0.3), 1.2 * THINK(f - 3) + 0.5 * _cyc(f, 1, 1.0), 0)})
    arms = {}
    for s in (1, -1):
        arms.update(S.solve(p, s, PATHS[s](p, f)))
    p = B.override(p, arms)
    e = ENDS(f)
    if e > 0:
        p = S.lerp_pose(p, S.base_idle(), e)
    return p


def build(anim):
    extra = [k for k, _ in _keys(1)] + [int(k) for k, _ in _keys(-1)]
    for f in S.key_frames(N, 2, extra):
        anim.key(f, S.base_idle() if f in (0, N) else pose_at(f))
