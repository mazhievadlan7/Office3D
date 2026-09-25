"""Sit down: from standing in front of the chair into SIT. One shot, 40 frames.

The app plays it forwards when an agent sits down and reversed as "stand up",
so every phase also has to read backwards (feet pulled back under the seat,
trunk leans forward over them with a hand pushing on the armrest, rise).

Frame 0 is STAND with the whole body START_Y in front of the chair centre
(where the walker stops); frame 40 is exactly _base.SIT.

   0-8   glance down over the right shoulder at the chair, weight onto the
         left leg, knees unlock
   6-24  hips and knees bend, the trunk leans forward to keep the weight over
         the feet while the pelvis travels back and down; the right hand
         finds the front of the armrest (real chair: pad top z 0.67, x -0.275)
  16-30  the feet slide forward into the SIT stance, left then right, as the
         weight goes back onto the hand and the seat
  24-30  buttocks land, the cushion gives a little and pushes back
  26-40  the trunk rolls up to the seated lean with a small settle, the hands
         come to rest on the thighs and the eyes come up to the monitor
"""

import math

import rig
from _base import (
    MONITOR,
    SIT,
    SIT_ANKLE_L,
    SIT_ANKLE_R,
    SIT_KNEE_POLE,
    SIT_TOE_OUT_L,
    SIT_TOE_OUT_R,
    STAND,
    THIGH_WRIST,
    _THIGH_FINGERS_L,
    _mirror_val,
    _val,
    arm_ik,
    fk,
    joint,
    left_thumb,
    leg_ik,
    look_at,
)
from mathutils import Quaternion, Vector
from pose import merge, mirror

NAME = "SitDown"
FRAMES = 40
CYCLIC = False

# Hips@ y at frame 0 (src/features/hq/core/config.ts WORKSTATION.approachOffset).
START_Y = -0.14
START = merge(STAND, {"Hips@": (0.0, START_Y, 0.0)})
HIPS_REST_Z = rig.head_of("Hips").z

# Front of the right armrest pad of the real chair (blender/hq/workstation.py):
# wrist position with the palm flat on the pad and the fingers over its front.
ARMREST_WRIST_R = Vector((-0.272, 0.0, 0.70))

KEYS = [0, 3, 6, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 34, 37, 40]


# --- interpolation --------------------------------------------------------------
def curve(points):
    """Monotone cubic (PCHIP) through [(frame, value or tuple)], flat at the ends.
    Used to sample authored channels at the key frames so every channel keeps
    its own timing (overlap) while all bones are keyed together."""
    fs = [float(p[0]) for p in points]
    vs = [tuple(p[1]) if hasattr(p[1], "__len__") else (float(p[1]),) for p in points]
    n, dim = len(fs), len(vs[0])
    tan = [[0.0] * dim for _ in range(n)]
    for c in range(dim):
        d = [(vs[i + 1][c] - vs[i][c]) / (fs[i + 1] - fs[i]) for i in range(n - 1)]
        for i in range(1, n - 1):
            if d[i - 1] * d[i] > 0:
                h0, h1 = fs[i] - fs[i - 1], fs[i + 1] - fs[i]
                w1, w2 = 2 * h1 + h0, h1 + 2 * h0
                tan[i][c] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def ev(f):
        if f <= fs[0]:
            v = vs[0]
        elif f >= fs[-1]:
            v = vs[-1]
        else:
            i = max(k for k in range(n - 1) if fs[k] <= f)
            h = fs[i + 1] - fs[i]
            t = (f - fs[i]) / h
            a, b = 2 * t ** 3 - 3 * t ** 2 + 1, t ** 3 - 2 * t ** 2 + t
            c_, d_ = -2 * t ** 3 + 3 * t ** 2, t ** 3 - t ** 2
            v = tuple(a * vs[i][c] + b * h * tan[i][c] + c_ * vs[i + 1][c] + d_ * h * tan[i + 1][c]
                      for c in range(dim))
        return v if dim > 1 else v[0]

    return ev


def V(*a):
    return Vector(a)


# --- body -----------------------------------------------------------------------
# Hips joint in world space: small weight shift to the left, then back and
# down onto the seat; lands at f28 (cushion gives ~4 mm), rebounds, settles.
HIPS = curve([
    (0, (0.0, START_Y, 0.96)),
    (3, (0.004, START_Y - 0.001, 0.956)),
    (6, (0.009, START_Y + 0.003, 0.942)),
    (9, (0.008, START_Y + 0.016, 0.910)),
    (12, (0.005, -0.103, 0.862)),
    (15, (0.002, -0.076, 0.802)),
    (18, (0.0, -0.047, 0.738)),
    (21, (0.0, -0.018, 0.675)),
    (24, (0.0, 0.010, 0.612)),
    (26, (0.0, 0.022, 0.585)),
    (28, (0.0, 0.030, 0.566)),
    (31, (0.0, 0.034, 0.574)),
    (34, (0.0, 0.035, 0.568)),
    (37, (0.0, 0.035, 0.5705)),
    (40, (0.0, 0.035, 0.570)),
])
# Pelvis leads the lean (hip flexion); the spine segments follow a frame or
# two later and roll back up after the landing in the same order.
PELVIS = curve([
    (0, (0, 0, 0)), (3, (1, -0.8, -0.5)), (6, (3.5, -1.5, -1.0)), (9, (8.5, -1.0, -0.8)), (12, (14, -0.4, -0.3)),
    (15, (19, 0, 0)), (18, (22, 0, 0)), (21, (22.5, 0, 0)), (24, (18.5, 0, 0)), (27, (11, 0, 0)),
    (30, (5, 0, 0)), (33, (1.8, 0, 0)), (36, (3.3, 0, 0)), (40, (3, 0, 0)),
])
SPINE = curve([
    (0, (-1, 0, 0)), (3, (-1, 0.6, -0.5)), (6, (-0.3, 1.0, -1.5)), (9, (1.2, 0.6, -1.5)), (12, (3, 0.2, -1)),
    (15, (4.5, 0, -0.5)), (18, (5.5, 0, 0)), (21, (6, 0, 0)), (24, (6, 0, 0)), (27, (5, 0, 0)),
    (30, (3.5, 0, 0)), (33, (2.2, 0, 0)), (36, (2.4, 0, 0)), (40, (2.5, 0, 0)),
])
SPINE1 = curve([
    (0, (1, 0, 0)), (3, (1, 0.4, -1)), (6, (1.2, 0.6, -3)), (9, (1.8, 0.3, -3)), (12, (2.6, 0, -1.5)),
    (15, (3.4, 0, -0.5)), (18, (4, 0, 0)), (21, (4.5, 0, 0)), (24, (4.8, 0, 0)), (27, (4.6, 0, 0)),
    (30, (4, 0, 0)), (33, (2.6, 0, 0)), (36, (2.8, 0, 0)), (40, (3, 0, 0)),
])
SPINE2 = curve([
    (0, (1.5, 0, 0)), (3, (1.5, 0, -1.5)), (6, (1.5, 0, -4)), (9, (1.7, 0, -3.5)), (12, (2.1, 0, -1.5)),
    (15, (2.6, 0, -0.5)), (18, (3, 0, 0)), (21, (3.4, 0, 0)), (24, (3.8, 0, 0)), (27, (4.2, 0, 0)),
    (30, (4.1, 0, 0)), (33, (3.2, 0, 0)), (36, (3.2, 0, 0)), (40, (3.5, 0, 0)),
])
# Where the eyes aim (Neck/Head solved by look_at), plus the glance at the
# chair and the head's lag behind the landing as additive offsets.
GAZE = curve([
    (0, (0, -3.0, 1.6)), (3, (0, -3.0, 1.5)), (6, (0, -2.5, 1.2)), (10, (0, -1.8, 0.7)), (15, (0, -1.4, 0.45)),
    (20, (0, -1.3, 0.45)), (24, (0, -1.3, 0.6)), (28, (0, -1.1, 0.85)), (32, (0, -0.95, 1.0)),
    (36, tuple(MONITOR)), (40, tuple(MONITOR)),
])
NECK_ADD = curve([
    (0, (0, 0, 0)), (3, (2, 0, -5)), (6, (5, 0, -12)), (9, (4, 0, -10)), (12, (1.5, 0, -3)), (15, (0, 0, 0)),
    (26, (0, 0, 0)), (28, (1.5, 0, 0)), (31, (-1, 0, 0)), (34, (0.3, 0, 0)), (37, (0, 0, 0)), (40, (0, 0, 0)),
])
HEAD_ADD = curve([
    (0, (0, 0, 0)), (3, (3, -1, -10)), (6, (9, -3, -26)), (9, (8, -2.5, -22)), (12, (3, -1, -8)), (15, (0, 0, 0)),
    (26, (0, 0, 0)), (29, (2.5, 0, 0)), (32, (-1.5, 0, 0)), (35, (0.5, 0, 0)), (38, (0, 0, 0)), (40, (0, 0, 0)),
])

# --- feet -----------------------------------------------------------------------
A0L = joint(START, "LeftFoot")
A0R = joint(START, "RightFoot")


# The feet slide forward on the balls of the feet (heel raised, toes flat), so
# they never leave the floor while the weight moves from them onto the hand
# and the seat. Ankle height keeps the ToeBase joint on the floor for a pitch.
_TOE_OFF = rig.head_of("LeftToeBase") - rig.head_of("LeftFoot")  # (0, -0.12, -0.06)


def _ankle_z(pitch):
    a = math.radians(pitch)
    return rig.head_of("LeftToeBase").z - (_TOE_OFF.y * math.sin(a) + _TOE_OFF.z * math.cos(a))


def _slide(a0, a1, f0, f1):
    return curve([(0, tuple(a0.xy)), (f0, tuple(a0.xy)), (f1, tuple(a1.xy)), (40, tuple(a1.xy))])


ANKLE_L = _slide(A0L, SIT_ANKLE_L, 17, 25)
ANKLE_R = _slide(A0R, SIT_ANKLE_R, 20, 28)
PITCH_L = curve([(0, 0), (16, 0), (19.5, 9), (22.5, 7), (25.5, 0), (40, 0)])
PITCH_R = curve([(0, 0), (19, 0), (22.5, 9), (25.5, 7), (28.5, 0), (40, 0)])
TOE_L = curve([(0, 0), (17, 0), (25, SIT_TOE_OUT_L), (40, SIT_TOE_OUT_L)])
TOE_R = curve([(0, 0), (20, 0), (28, SIT_TOE_OUT_R), (40, SIT_TOE_OUT_R)])
POLE_L = SIT_KNEE_POLE
POLE_R = V(-SIT_KNEE_POLE.x, SIT_KNEE_POLE.y, SIT_KNEE_POLE.z)


def _leg(p, side, xy, pitch, toe_out, pole):
    """leg_ik for an ankle at xy, then the foot pitched toes-down by `pitch`
    degrees (heel up) about the ankle with the toes kept flat on the floor."""
    pre = "Left" if side > 0 else "Right"
    out = leg_ik(p, side, Vector((xy[0], xy[1], _ankle_z(pitch))), pole, toe_out)
    if pitch > 1e-3:
        q = dict(p)
        q.update(out)
        r_shin, _ = fk(q, pre + "Leg")
        r_foot = Quaternion((0, 0, 1), math.radians(toe_out * side)) @ Quaternion((1, 0, 0), math.radians(pitch))
        out[pre + "Foot"] = _val(r_shin.inverted() @ r_foot)
    out[pre + "ToeBase"] = (-pitch, 0, 0)
    return out


# --- arms -----------------------------------------------------------------------
def _arm_state(p, side):
    """Wrist offset from the shoulder, hand direction, palm normal and elbow
    offset of pose p (the targets that make arm_ik reproduce it)."""
    pre = "Left" if side > 0 else "Right"
    s, e, w = joint(p, pre + "Arm"), joint(p, pre + "ForeArm"), joint(p, pre + "Hand")
    r, _ = fk(p, pre + "Hand")
    d0 = (rig.tail_of(pre + "Arm") - rig.head_of(pre + "Arm")).normalized()
    return w - s, r @ d0, r @ rig._palm_normal(side), e - s


REL0_L, FWD0_L, PALM0_L, POLE0_L = _arm_state(START, 1)
REL0_R, FWD0_R, PALM0_R, POLE0_R = _arm_state(START, -1)
TW_L = V(THIGH_WRIST.x, THIGH_WRIST.y, THIGH_WRIST.z)
TW_R = V(-THIGH_WRIST.x, THIGH_WRIST.y, THIGH_WRIST.z)
# thigh_arm() targets (see _base.thigh_arm)
TFWD_L, TPALM_L, TPOLE_L = V(-0.55, -0.8, -0.2), V(-0.2, 0.05, -1.0), V(0.22, 0.2, -0.4)
TFWD_R, TPALM_R, TPOLE_R = V(0.55, -0.8, -0.2), V(0.2, 0.05, -1.0), V(-0.22, 0.2, -0.4)

# Left arm: hangs, drifts forward over the knee as the trunk leans (keeps the
# weight forward), then follows through onto the thigh after the landing.
L_REL = curve([
    (0, tuple(REL0_L)), (4, tuple(REL0_L + V(0, 0.008, 0.002))), (8, (0.082, 0.018, -0.515)),
    (12, (0.084, 0.02, -0.505)), (16, (0.085, 0.0, -0.49)), (40, (0.085, 0.0, -0.49)),
])
# beside the thigh, clear of the desk edge, then over and onto its top
L_WORLD = curve([
    (0, (0.25, -0.28, 0.68)), (17, (0.25, -0.28, 0.68)), (20, (0.248, -0.29, 0.655)), (23, (0.235, -0.285, 0.655)),
    (25, (0.205, -0.268, 0.672)), (27, (0.172, -0.24, 0.664)), (29, (0.153, -0.215, 0.645)),
    (31, (0.148, -0.2, 0.638)), (34, (0.148, -0.198, 0.6395)), (37, (0.148, -0.2005, 0.6402)), (40, tuple(TW_L)),
])
L_CONTACT = curve([(0, 0), (12, 0), (19, 1), (40, 1)])
L_ORIENT = curve([(0, 0), (20, 0), (30, 1), (40, 1)])  # STAND hand -> thigh hand
L_SHOULDER = curve([(0, (0, 3, 0)), (10, (0, 3, -1)), (20, (0, 3.5, -2.5)), (27, (0, 3, -1.5)), (34, (0, 2, 0)),
                    (40, (0, 2, 0))])

# Right arm: reaches back and down for the armrest front, holds it while the
# body lowers (elbow bends back, shoulder rides up), lets go after the landing
# and comes forward onto the right thigh.
R_REL = curve([
    (0, tuple(REL0_R)), (4, tuple(REL0_R + V(0, 0.008, 0.002))), (8, (-0.1, 0.03, -0.512)),
    (11, (-0.13, 0.07, -0.49)), (40, (-0.13, 0.07, -0.49)),
])
R_WORLD = curve([
    (0, tuple(ARMREST_WRIST_R + V(-0.035, -0.03, 0.12))), (10, tuple(ARMREST_WRIST_R + V(-0.035, -0.03, 0.12))),
    (14, tuple(ARMREST_WRIST_R + V(-0.018, -0.012, 0.04))), (17, tuple(ARMREST_WRIST_R)),
    (26, tuple(ARMREST_WRIST_R)), (28, tuple(ARMREST_WRIST_R + V(0.012, -0.04, 0.035))),
    (31, (-0.18, -0.172, 0.678)), (33, (-0.152, -0.202, 0.645)), (36, (-0.148, -0.199, 0.6395)),
    (40, tuple(TW_R)),
])
R_CONTACT = curve([(0, 0), (8, 0), (15, 1), (40, 1)])
# hand orientation weights: (stand, armrest, thigh)
R_ORIENT = curve([(0, (1, 0, 0)), (9, (1, 0, 0)), (16, (0, 1, 0)), (26, (0, 1, 0)), (32, (0, 0, 1)), (40, (0, 0, 1))])
R_POLE_REST = V(-0.22, 0.5, 0.05)  # elbow back and out while leaning on the armrest
R_FWD_REST = V(0.06, -1.0, -0.15)
R_PALM_REST = V(0.08, 0.02, -1.0)
# Right clavicle, as a LEFT value (mirrored): retracts for the reach, rides up
# while the hand bears weight, then drops.
R_SHOULDER = curve([(0, (0, 3, 0)), (9, (0, 3, 1)), (15, (0, 2, 5)), (22, (0, -1.5, 4)), (26, (0, -2, 3)),
                    (31, (0, 1.5, 0.5)), (36, (0, 2, 0)), (40, (0, 2, 0))])

# --- fingers --------------------------------------------------------------------
_F_BONES = ["Index", "Middle", "Ring", "Pinky"]
F_STAND = {k: v for k, v in STAND.items() if k.startswith("LeftHand") and k != "LeftHand"}
F_OPEN = merge({f"LeftHand{b}{s}": (0, v, 0) for b, vv in zip(_F_BONES, ((4, 6), (5, 8), (7, 10), (9, 12)))
                for s, v in zip((1, 2), vv)}, left_thumb(0.45, 0.85, 0.15, 4))
F_GRIP = merge({f"LeftHand{b}{s}": (x, v, 0) for b, vv, x in zip(_F_BONES, ((38, 46), (40, 50), (42, 50), (44, 50)),
                                                               (-2, 0, 2, 4))
                for s, v in zip((1, 2), vv)}, left_thumb(0.75, 0.45, 0.45, 14))
F_THIGH = _THIGH_FINGERS_L
L_FING = curve([(0, (1, 0, 0)), (12, (1, 0, 0)), (22, (0.4, 0.6, 0)), (27, (0, 0.7, 0.3)), (32, (0, 0, 1)),
                (40, (0, 0, 1))])  # (stand, open, thigh)
R_FING = curve([(0, (1, 0, 0, 0)), (9, (1, 0, 0, 0)), (14, (0, 1, 0, 0)), (18, (0, 0, 1, 0)), (26, (0, 0, 1, 0)),
                (28, (0, 0.8, 0.2, 0)), (33, (0, 0, 0, 1)), (40, (0, 0, 0, 1))])  # (stand, open, grip, thigh)


def _mix(sets, weights):
    tot = sum(weights) or 1.0
    out = {}
    for s, w in zip(sets, weights):
        for k, v in s.items():
            v = tuple(v) + (0,) * (4 - len(v))
            cur = out.get(k, (0, 0, 0, 0))
            out[k] = tuple(a + b * w / tot for a, b in zip(cur, v))
    return out


def _vmix(vecs, weights):
    return sum((v * w for v, w in zip(vecs, weights)), Vector()).normalized()


def _arm(p, side, wrist, fwd, palm, pole_off, shoulder_left):
    pre = "Left" if side > 0 else "Right"
    sh = shoulder_left if side > 0 else _mirror_val("LeftShoulder", shoulder_left)
    q = dict(p)
    q[pre + "Shoulder"] = sh
    s = joint(q, pre + "Arm")
    return arm_ik(q, side, wrist, pole=s + pole_off, hand_fwd=fwd, palm=palm, shoulder=sh)


def shoulder_pos(p, side, shoulder_left):
    pre = "Left" if side > 0 else "Right"
    q = dict(p)
    q[pre + "Shoulder"] = shoulder_left if side > 0 else _mirror_val("LeftShoulder", shoulder_left)
    return joint(q, pre + "Arm")


# --- assemble -------------------------------------------------------------------
def pose_at(f):
    hx, hy, hz = HIPS(f)
    p = {
        "Hips@": (hx, hy, hz - HIPS_REST_Z),
        "Hips": PELVIS(f),
        "Spine": SPINE(f),
        "Spine1": SPINE1(f),
        "Spine2": SPINE2(f),
        "Neck": (0, 0, 0),
        "Head": (0, 0, 0),
    }
    for side, ank, pitch, toe, pole in ((1, ANKLE_L, PITCH_L, TOE_L, POLE_L), (-1, ANKLE_R, PITCH_R, TOE_R, POLE_R)):
        p.update(_leg(p, side, ank(f), pitch(f), toe(f), pole))
    p = look_at(p, GAZE(f))
    p = merge(p, {"Neck": NECK_ADD(f), "Head": HEAD_ADD(f)})

    # left arm
    shl = L_SHOULDER(f)
    s = shoulder_pos(p, 1, shl)
    c = L_CONTACT(f)
    w = (s + Vector(L_REL(f))).lerp(Vector(L_WORLD(f)), c)
    o = L_ORIENT(f)
    p.update(_arm(p, 1, w, _vmix((FWD0_L, TFWD_L), (1 - o, o)), _vmix((PALM0_L, TPALM_L), (1 - o, o)),
                  POLE0_L.lerp(TPOLE_L, o), shl))
    fw = L_FING(f)
    p.update(_mix((F_STAND, F_OPEN, F_THIGH), fw))

    # right arm
    shr = R_SHOULDER(f)
    s = shoulder_pos(p, -1, shr)
    c = R_CONTACT(f)
    w = (s + Vector(R_REL(f))).lerp(Vector(R_WORLD(f)), c)
    ow = R_ORIENT(f)
    pole = POLE0_R * ow[0] + R_POLE_REST * ow[1] + TPOLE_R * ow[2]
    p.update(_arm(p, -1, w, _vmix((FWD0_R, R_FWD_REST, TFWD_R), ow), _vmix((PALM0_R, R_PALM_REST, TPALM_R), ow),
                  pole / max(sum(ow), 1e-6), shr))
    p.update(mirror(_mix((F_STAND, F_OPEN, F_GRIP, F_THIGH), R_FING(f))))
    return p


def build(anim):
    for f in KEYS:
        if f == 0:
            anim.key(f, START)
        elif f == FRAMES:
            anim.key(f, SIT)
        else:
            anim.key(f, pose_at(f))
