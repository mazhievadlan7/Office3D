"""Looking over a seated colleague's shoulder (StandLookOver): 180 frames at
30 fps. Intro, a HELD loop and an outro in one clip, in place.

The root stands at the host workstation's shoulder place and faces its
centre monitor (HQ_SHOULDER in src/features/hq/core/config.ts; the sim puts
him there): in the workstation frame (chair centre on the floor, the sitter
facing -Y, +X the sitter's left) he stands at (-0.55, +0.42), behind the
sitter's right shoulder. His LEFT hand rests on the chair back's right top
corner (GRIP_CHAIR below, the contract's `hand`), he leans in to the screen
and now and then points at it with his right hand.

    0-20  from a relaxed stand (Idle's pose): the left hand goes onto the
          chair back, weight onto the left leg, the trunk leans in
   20-164 HOLD (the app loops it while the visit lasts):
     20-40    reads the screen, a small nod
     40-72    the right hand comes up and points at the centre monitor, a
              tap on one spot, over to another, a second tap (he explains:
              HQ_CLIP_INFO.talk window 40/30..72/30 s)
     72-86    the hand goes back down
     86-112   follows along on the screen, weight settles, a slow nod
     112-138  glances down at the sitter, two nods, back to the screen
          Frames 20 and 164 are the same pose, still.
  164-180 back to the relaxed stand

check() measures the left palm on the evaluated rig against GRIP_CHAIR.
"""

import math

from mathutils import Matrix, Vector

import _base as B
import _seat as S
import rig
from pose import merge, mirror

NAME = "StandLookOver"
FRAMES = 180
CYCLIC = False
N = FRAMES
HOLD = (20, 164)
TALK = (40, 72)
H0, H1 = HOLD
HL = H1 - H0

# --- the workstation, seen from the guest -----------------------------------------
# HQ_SHOULDER (three.js local: x = -0.55, z = -0.42) in Blender's chair frame.
SHOULDER = Vector((-0.55, 0.42, 0.0))
MONITOR_CHAIR = Vector((0.0, -0.95, 1.13))
_d = Vector((MONITOR_CHAIR.x - SHOULDER.x, MONITOR_CHAIR.y - SHOULDER.y, 0.0)).normalized()
_LEFT = Vector((-_d.y, _d.x, 0.0))


def chair_to_local(v):
    """A point in the chair frame to the guest's root frame."""
    w = Vector(v) - SHOULDER
    return Vector((w.dot(_LEFT), -w.dot(_d), w.z))


def chair_dir(v):
    v = Vector(v)
    return Vector((v.dot(_LEFT), -v.dot(_d), v.z))


# build tools: the host workstation in this clip's frame (x, y, yaw deg)
_o = chair_to_local((0, 0, 0))
PREVIEW_FRAME = (_o.x, _o.y, math.degrees(math.atan2(chair_dir((1, 0, 0)).y, chair_dir((1, 0, 0)).x)))

# The palm centre on top of the chair back's right top corner (chair frame;
# blender/hq/workstation.py back_surface(1, 1) is (-0.183, 0.316, 1.08) with
# the steel ring round it). Mirrors HQ_SHOULDER.hand (three.js x, y, -y).
GRIP_CHAIR = Vector((-0.19, 0.325, 1.10))
GRIP = chair_to_local(GRIP_CHAIR)
PALM_DOWN = 0.055  # palm centre down the hand from the wrist
PALM_DEPTH = 0.018  # wrist axis to the palm surface
GRIP_TOLERANCE = 0.02
MONITOR = chair_to_local(MONITOR_CHAIR)
SITTER = chair_to_local((0.0, -0.06, 1.25))
SPOT1 = chair_to_local((0.08, -0.93, 1.05))
SPOT2 = chair_to_local((-0.18, -0.93, 1.16))

# --- tracks ----------------------------------------------------------------------------
IN = S.Track([(0, 0.0), (4, 0.05), (16, 0.95), (H0, 1.0), (H1, 1.0), (168, 0.95), (178, 0.05), (180, 0.0)])
# weight: + on the left leg (the hand on the chair side)
WEIGHT = S.Track([(0, 0.0), (H0, 0.55), (40, 0.6), (70, 0.4), (96, 0.75), (120, 0.65), (144, 0.5),
                  (H1, 0.55), (180, 0.0)])
LEAN = S.Track([(0, 0.0), (H0, 1.0), (44, 1.15), (66, 1.2), (84, 1.0), (112, 1.05), (130, 0.9), (H1, 1.0),
                (180, 0.0)])
BREATH = S.Track([(0, 0.0), (H0, 0.0), (50, 1.0), (90, -0.4), (126, 0.8), (H1, 0.0), (180, 0.0)])
POINTING = S.Track([(0, 0.0), (40, 0.0), (48, 1.0), (70, 1.0), (82, 0.0), (180, 0.0)])
SPOT = S.Track([(0, 0.0), (44, 0.0), (48, 1.0), (58, 1.0), (62, 2.0), (70, 2.0), (80, 0.0), (180, 0.0)])
TAP = S.Track([(0, 0.0), (51, 0.0), (53, 1.0), (55, 0.0), (64, 0.0), (66, 1.0), (68, 0.0), (180, 0.0)])
LOOK_SITTER = S.Track([(0, 0.0), (112, 0.0), (117, 1.0), (132, 1.0), (138, 0.0), (180, 0.0)])
NOD = S.Track([(0, 0.0), (32, 0.0), (35, 3.5), (39, 0.0), (52, 0.0), (54, 2.0), (56, 0.0), (98, 0.0),
               (102, 3.0), (106, 0.0), (118, 0.0), (121, 5.0), (124, 0.5), (127, 4.0), (131, 0.0), (180, 0.0)])

ANKLE_L = B.joint(B.STAND, "LeftFoot")
ANKLE_R = B.joint(B.STAND, "RightFoot")
KNEE_POLE = Vector((0.12, -1.0, 0.45))

# --- hands -------------------------------------------------------------------------------
# Left: fingers forward-inward over the top edge (toward the sitter's front),
# palm down on the corner.
_CHAIR_FWD = chair_dir(Vector((0.85, -0.25, -0.3)).normalized())
_CHAIR_PALM = chair_dir(Vector((0.05, -0.35, -1.0)))
DRAPE_F = merge({
    "LeftHandIndex1": (-2, 16, 0),
    "LeftHandIndex2": (0, 14, 0),
    "LeftHandMiddle1": (0, 18, 0),
    "LeftHandMiddle2": (0, 16, 0),
    "LeftHandRing1": (2, 22, 0),
    "LeftHandRing2": (0, 20, 0),
    "LeftHandPinky1": (4, 26, 0),
    "LeftHandPinky2": (0, 24, 0),
}, B.left_thumb(0.6, 0.7, 0.25, 10))


def _grip_wrist():
    f = _CHAIR_FWD.normalized()
    n = (_CHAIR_PALM - f * _CHAIR_PALM.dot(f)).normalized()
    return GRIP - f * PALM_DOWN - n * PALM_DEPTH


GRIP_TGT = S.Tgt(_grip_wrist(), _CHAIR_FWD, _CHAIR_PALM, (0.06, 0.45, -0.3), (0, 1, -3), DRAPE_F)
RELAX_F = {k: v for k, v in B.STAND.items() if k.startswith("LeftHand") and k != "LeftHand"}
_THUMB_L = B.left_thumb(0.95, 0.3, 0.15, 12)
RELAX_F.update(_THUMB_L)


def _hang(p, side):
    """A relaxed hanging arm from the current shoulder (keeps hanging while
    the trunk leans)."""
    s = S.shoulder_joint(p, side, (0, 3, 0))
    w = s + Vector((0.065 * side, -0.03, -0.5))
    return S.Tgt(w, (0.05 * side, -0.12, -1.0), (-0.95 * side, 0.1, 0.0), (0.25 * side, 0.4, 0.0), (0, 3, 0),
                 RELAX_F)


# On the way to the chair back the hand comes up in front of the hip and
# over the back's right edge from above and outside (clear of the headrest).
_ABOVE = chair_to_local((-0.30, 0.40, 1.21))
ABOVE_TGT = S.Tgt(_ABOVE, chair_dir((0.3, -0.6, -0.75)), chair_dir((0.0, -0.3, -1.0)), (0.1, 0.45, -0.3),
                  (0, 1, -2), S.SOFT_F)


def _hang_l(p, f):
    return _hang(p, 1)


def _front_l(p, f):
    h = _hang(p, 1)
    return S.Tgt(h.w + Vector((-0.01, -0.12, 0.14)), (0.1, -0.5, -0.85), (-0.9, -0.1, 0.2), (0.3, 0.3, -0.3),
                 (0, 2, -1), S.SOFT_F)


LEFT = S.Path([
    (0, _hang_l), (6, _front_l), (11, ABOVE_TGT), (15, GRIP_TGT.moved(chair_dir((-0.035, 0.01, 0.045)))), (18, GRIP_TGT),
    (H0, GRIP_TGT), (H1, GRIP_TGT), (167, GRIP_TGT.moved(chair_dir((-0.04, 0.01, 0.05)))), (171, ABOVE_TGT),
    (176, _front_l), (180, _hang_l),
], rot_lag=1.5, fing_lag=2.0)


def _point(p, f):
    sp = SPOT(f)
    tgt = SPOT1.lerp(SPOT2, max(0.0, min(1.0, sp - 1.0)))
    s = S.shoulder_joint(p, -1, (0, 0, -6))
    reach = 0.40 + 0.03 * TAP(f)
    d = (tgt - s).normalized()
    w = s + d * reach + Vector((0.03, 0.0, -0.06))
    fwd = (tgt - w).normalized()
    palm = Vector((0.35, 0.0, -1.0))
    return S.Tgt(w, fwd, palm, (-0.35, 0.2, -0.45), (0, 0, -6), mirror_left(S.POINT_F))


def mirror_left(fset):
    return fset  # finger sets stay left-authored; solve() mirrors them


def pose_at(f):
    k = IN(f)
    wgt, lean, br = WEIGHT(f), LEAN(f), BREATH(f)
    p = merge(B.STAND, _THUMB_L, mirror(_THUMB_L), {
        "Hips@": (0.022 * wgt, -0.012 * lean, -0.012 * lean - 0.004 * wgt * wgt),
        "Hips": (5.5 * lean, -2.0 * wgt, 1.5 * wgt),
        "Spine": (2.5 * lean + 0.2 * br, 1.0 * wgt, 0.0),
        "Spine1": (3.0 * lean - 0.5 * br, 0.8 * wgt, 0.0),
        "Spine2": (2.5 * lean - 0.7 * br, 0.4 * wgt + 1.5 * k, -1.0 * POINTING(f - 3)),
    })
    p.update(B.leg_ik(p, 1, ANKLE_L, KNEE_POLE, 4.0))
    p.update(B.leg_ik(p, -1, ANKLE_R, Vector((-KNEE_POLE.x, KNEE_POLE.y, KNEE_POLE.z)), 6.0))
    p.update({"LeftToeBase": (0, 0, 0), "RightToeBase": (0, 0, 0)})
    sp = SPOT(f)
    screen = MONITOR.lerp(SPOT1, min(sp, 1.0)).lerp(SPOT2, max(sp - 1.0, 0.0))
    ahead = Vector((0.0, -3.0, 1.55))
    gaze = ahead.lerp(screen, k).lerp(SITTER, LOOK_SITTER(f))
    p = B.look_at(p, gaze, neck_share=0.4)
    p = merge(p, {"Neck": (0.35 * NOD(f - 1), 0, 0), "Head": (0.65 * NOD(f), 1.5 * LOOK_SITTER(f), 0)})

    arms = {}
    arms.update(S.solve(p, 1, LEFT(p, f)))
    pt = POINTING(f)
    tr = _hang(p, -1)
    if pt > 0:
        tr = S.mix(tr, _point(p, f), pt, lift=(-0.04, -0.08, 0.05), s_rot=POINTING(f + 1.5),
                   s_fing=POINTING(f - 1.5))
    arms.update(S.solve(p, -1, tr))
    return B.override(p, arms)


def build(anim):
    extra = IN.frames() + POINTING.frames() + NOD.frames() + TAP.frames()
    for f in S.key_frames(N, 2, extra):
        anim.key(f, pose_at(f))


def _palm(arm_obj):
    pb = arm_obj.pose.bones["LeftHand"]
    m = arm_obj.matrix_world @ pb.matrix
    r = m.to_3x3().normalized() @ pb.bone.matrix_local.to_3x3().normalized().inverted()
    fwd = m.to_3x3().col[1].normalized()
    n = (r @ rig._palm_normal(1)).normalized()
    return m.translation + fwd * PALM_DOWN + n * PALM_DEPTH


def check(scene, arm_obj, action):
    """The left palm against GRIP over the hold (every half frame)."""
    arm_obj.animation_data.action = action
    frame0 = scene.frame_current
    worst = 0.0
    acc = Vector()
    cnt = 0
    for k in range(H0 * 2, H1 * 2 + 1):
        scene.frame_set(k // 2, subframe=0.5 * (k % 2))
        palm = _palm(arm_obj)
        worst = max(worst, (palm - GRIP).length)
        acc += palm
        cnt += 1
    scene.frame_set(frame0)
    mean = acc / cnt
    # back to the chair frame (three.js: x, y up, z = -Blender y)
    w = SHOULDER + _LEFT * mean.x - _d * mean.y
    print(f"[lookover] palm mean in the chair frame: blender ({w.x:+.3f},{w.y:+.3f},{mean.z:+.3f}) -> three.js "
          f"hand {{x: {w.x:.3f}, y: {mean.z:.3f}, z: {-w.y:.3f}}}; worst error {worst * 100:.2f} cm -> "
          f"{'OK' if worst <= GRIP_TOLERANCE else 'FAIL'}")
    return worst
