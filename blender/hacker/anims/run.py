"""Run: a purposeful jog/run at ~3.6 m/s, IN PLACE (the app moves the root).

20 frames at 30 fps = 180 steps/min and 2.4 m per cycle, so a planted foot
slides back 0.12 m per frame. Left leg (the right one is the same half a cycle
later, mirrored):

  0      touchdown, midfoot/forefoot strike, ankle ~0.2 m ahead of the hip
  0-2    loading: the heel settles, knee bends to ~45 deg, pelvis drops
  3      midstance, pelvis lowest
  4-6    heel rolls up about the ball of the foot, toes stay flat
  ~6.3   toe-off; flight until the right touchdown at 10
  7-12   heel recovery behind (knee ~105 deg at 13)
  13-17  knee drive (thigh ~52 deg), shank whips forward
  17-20  swing-leg retraction: the foot pulls back to land under the body

Legs: a stance foot is solved with IK every frame (the ball of the foot moves
back at exactly 0.12 m/frame at z 0.03, toes flat on the floor). The swing leg
is authored as thigh-angle / knee-bend / ankle keys, splined together with the
angles the stance IK produces, so toe-off and touchdown blend without pops.
The pelvis height follows a stance compression plus a ballistic flight arc.
Arms are authored as shoulder swing and elbow bend in the chest frame (pumping
front-back, elbows ~90 deg, loose fists) and solved with arm_ik.

Every frame is keyed: the planted foot has to track the root speed exactly and
the curves come from smooth periodic functions, so this adds no jitter.
"""

import math

from mathutils import Quaternion, Vector

import rig
from _base import _twist_angle, _two_bone, _val, arm_ik, fk, joint, left_thumb
from pose import merge, mirror

NAME = "Run"
FRAMES = 20
CYCLIC = True

SPEED = 2.4 / FRAMES  # ground speed of a planted foot, metres per frame
STEP = FRAMES // 2

# --- leg geometry --------------------------------------------------------------
L1 = (rig.tail_of("LeftUpLeg") - rig.head_of("LeftUpLeg")).length
L2 = (rig.tail_of("LeftLeg") - rig.head_of("LeftLeg")).length
SHANK_REST = math.degrees(math.atan2(
    -(rig.tail_of("LeftLeg").y - rig.head_of("LeftLeg").y),
    rig.head_of("LeftLeg").z - rig.tail_of("LeftLeg").z))  # ~-3.4 (ankle behind knee)
BALL_FROM_ANKLE = rig.head_of("LeftToeBase") - rig.head_of("LeftFoot")  # (0,-0.12,-0.06)
BALL_Z = rig.head_of("LeftToeBase").z  # 0.03 with the toes flat on the floor
HIP_REST_Z = rig.head_of("LeftUpLeg").z  # 0.93

# --- timing and pelvis height --------------------------------------------------
T_CONTACT = 6.3  # frames of ground contact per step (0.21 s), flight 0.12 s
G = 9.81 / (30.0 * 30.0)  # gravity in m/frame^2
_T_FLIGHT = STEP - T_CONTACT
_V_TAKEOFF = G * _T_FLIGHT / 2.0  # vertical speed at toe-off / touchdown
_SINK = _V_TAKEOFF * T_CONTACT / math.pi  # stance compression, velocity-matched
HIP_TD = 0.90  # hip-joint height at touchdown / toe-off

# --- stance plant (left foot; right is mirrored) ---------------------------------
BALL_Y_TD = -0.32  # ball of the foot at touchdown (ankle ~0.21 ahead of the hip)
BALL_X = 0.074  # feet land close to the line of travel
TOE_OUT = 5.0
TOE_OUT_SWING = 2.0
# World pitch of the foot, toes down +, at stance frames 0..6: slight toe-down
# landing, flat by 2, heel rise from 4 rolling about the ball to toe-off.
STANCE_PITCH = [7.0, 3.0, 0.5, 1.0, 9.0, 28.0, 60.0]
STANCE_FRAMES = range(0, 7)

# --- swing keys (frame after touchdown: value) ----------------------------------
# alpha: thigh angle from vertical, forward +. kappa: knee bend (knee-ankle line
# vs thigh line). phi: ankle plantarflexion vs the rest pose. tau: toe bend
# (toes down +). x: ankle distance from the midline.
# Thigh stays near full extension just after toe-off while the knee folds
# (~10 deg/frame at first), so the foot eases off the ground instead of
# flicking back; knee peaks at ~70% of the cycle, thigh at ~80-85%, then the
# thigh retracts so the foot is travelling slowly back at touchdown.
SWING_ALPHA = {7: -23.8, 8: -22.5, 9: -19.0, 10: -13.0, 11: -4.0, 12: 8.0, 13: 21.0,
               14: 33.0, 15: 44.0, 16: 51.0, 17: 49.0, 18: 40.5, 19: 32.3}
SWING_KAPPA = {7: 22.0, 8: 36.0, 9: 52.0, 10: 67.0, 11: 82.0, 12: 96.0, 13: 104.0,
               14: 104.0, 15: 90.0, 16: 68.0, 17: 45.0, 18: 27.0, 19: 20.5}
SWING_PHI = {7: 28.0, 8: 24.0, 9: 19.0, 10: 13.0, 12: 5.0, 14: -2.0, 16: -3.0,
             17: 3.0, 18: 12.0, 19: 18.0}
SWING_TAU = {7: -28.0, 8: -12.0, 9: -4.0, 10: 0.0, 17: 0.0, 18: -2.0, 19: -5.0}
SWING_X = {9: 0.080, 13: 0.088, 17: 0.084}


def pspline(keys, f, period=FRAMES):
    """Periodic Catmull-Rom (cubic Hermite) through {frame: value} keys."""
    ks = sorted((t % period, v) for t, v in keys.items())
    ts = [k[0] for k in ks]
    vs = [k[1] for k in ks]
    n = len(ks)
    f = f % period
    if f < ts[0]:
        f += period
        i = n - 1
    else:
        i = max(j for j in range(n) if ts[j] <= f)

    def tt(k):
        return ts[k % n] + period * (k // n)

    def vv(k):
        return vs[k % n]

    t0, t1 = tt(i), tt(i + 1)
    m0 = (vv(i + 1) - vv(i - 1)) / (t1 - tt(i - 1))
    m1 = (vv(i + 2) - vv(i)) / (tt(i + 2) - t0)
    h = t1 - t0
    s = (f - t0) / h
    return ((2 * s**3 - 3 * s**2 + 1) * vv(i) + (s**3 - 2 * s**2 + s) * h * m0
            + (-2 * s**3 + 3 * s**2) * vv(i + 1) + (s**3 - s**2) * h * m1)


def wave(f, amp, peak, harmonic=1):
    """amp * cos, peaking at frame `peak`, `harmonic` cycles per loop."""
    return amp * math.cos(2 * math.pi * harmonic * (f - peak) / FRAMES)


# --- pelvis and trunk ----------------------------------------------------------
def hip_height(f):
    u = f % STEP
    if u <= T_CONTACT:
        return HIP_TD - _SINK * math.sin(math.pi * u / T_CONTACT)
    t = u - T_CONTACT
    return HIP_TD + _V_TAKEOFF * t - 0.5 * G * t * t


def pelvis_yaw(f):
    # The swing-side hip travels forward: left hip most forward just before
    # the left touchdown (-Z turns the pelvis toward the character's right).
    return -wave(f, 7.0, -1.0)


def pelvis_roll(f):
    # The swing-side hip drops a little in early/mid stance (-Y drops the right).
    return -4.0 * math.sin(2 * math.pi * (f + 2) / FRAMES)


def pelvis_pitch(f):
    return 6.0 + wave(f, 1.5, 5.0, 2)


def chest_yaw(f):
    # Shoulders counter-rotate: right shoulder forward around the left touchdown.
    return wave(f, 4.5, 0.8)


def trunk_pitch(f):
    # ~10 deg forward at the chest; a little extra flexion just after the
    # loading peak (lags the pelvis by a frame or two).
    return 11.5 + wave(f, 1.0, 4.0, 2)


def body_pose(f):
    sway = 0.008 * math.sin(2 * math.pi * (f + 2) / FRAMES)
    surge = 0.004 * math.sin(2 * math.pi * 2 * (f - 3) / FRAMES)  # brake / push
    hp, hr, hy = pelvis_pitch(f), pelvis_roll(f), pelvis_yaw(f)
    sp = trunk_pitch(f) - hp  # spine flexion on top of the pelvis tilt
    sy = chest_yaw(f) - hy  # spine counter-rotation
    sr = -0.8 * pelvis_roll(f - 1.0)  # chest stays level, lagging a frame
    nod = wave(f, 1.2, 2.6, 2)  # head dips a touch after each impact
    hy_head = -0.85 * chest_yaw(f - 1.0) - 0.15 * chest_yaw(f)  # gaze stabilised
    hr_head = -(hr + sr) * 0.9
    head_pitch = 4.0 + nod - trunk_pitch(f - 0.7)  # eyes ~4 deg down the road
    return {
        "Hips@": (sway, surge, hip_height(f) - HIP_REST_Z),
        "Hips": (hp, hr, hy),
        "Spine": (0.40 * sp, 0.45 * sr, 0.30 * sy),
        "Spine1": (0.40 * sp, 0.35 * sr, 0.35 * sy),
        "Spine2": (0.20 * sp, 0.20 * sr, 0.35 * sy),
        "Neck": (0.4 * head_pitch, 0.4 * hr_head, 0.5 * hy_head),
        "Head": (0.6 * head_pitch, 0.6 * hr_head, 0.5 * hy_head),
    }


# --- legs ------------------------------------------------------------------------
def _qx(deg):
    return Quaternion(Vector((1, 0, 0)), math.radians(deg))


def _qz(deg):
    return Quaternion(Vector((0, 0, 1)), math.radians(deg))


def _leg_angles(hip, ankle):
    """Sagittal 2-bone IK: (alpha, kappa) in degrees for hip -> ankle."""
    dy = ankle.y - hip.y
    dz = ankle.z - hip.z
    d = min(math.hypot(dy, dz), L1 + L2 - 1e-5)
    kappa = 180.0 - math.degrees(math.acos((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2)))
    beta = math.degrees(math.atan2(-dy, -dz))
    gamma = math.degrees(math.acos(max(-1.0, min(1.0, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)))))
    return beta + gamma, kappa


def _knee_2d(hip, alpha, x):
    a = math.radians(alpha)
    return Vector((x, hip.y - L1 * math.sin(a), hip.z - L1 * math.cos(a)))


def _ankle_2d(hip, alpha, kappa, x):
    a, s = math.radians(alpha), math.radians(alpha - kappa)
    return Vector((x, hip.y - L1 * math.sin(a) - L2 * math.sin(s),
                   hip.z - L1 * math.cos(a) - L2 * math.cos(s)))


def solve_leg(p, side, ankle, knee_hint, foot_q, toe):
    """UpLeg/Leg/Foot/ToeBase values putting the ankle at `ankle`, the knee in
    the plane of `knee_hint` and the foot at world rotation foot_q."""
    pre = "Left" if side > 0 else "Right"
    r_h, t_h = fk(p, "Hips")
    hip = r_h @ rig.head_of(pre + "UpLeg") + t_h
    t0 = (rig.tail_of(pre + "UpLeg") - rig.head_of(pre + "UpLeg")).normalized()
    s0 = (rig.tail_of(pre + "Leg") - rig.head_of(pre + "Leg")).normalized()
    mid = (hip + ankle) * 0.5
    pole = knee_hint + (knee_hint - mid).normalized() * 0.5 + Vector((0.04 * side, 0, 0))
    knee, a = _two_bone(hip, ankle, L1, L2, pole)
    r_thigh = (r_h @ t0).rotation_difference((knee - hip).normalized()) @ r_h
    r_shin = (r_thigh @ s0).rotation_difference((a - knee).normalized()) @ r_thigh
    tw = _twist_angle(r_shin.inverted() @ foot_q, s0)
    r_shin = r_shin @ Quaternion(s0, tw * 0.5)
    return {
        pre + "UpLeg": _val(r_h.inverted() @ r_thigh),
        pre + "Leg": _val(r_thigh.inverted() @ r_shin),
        pre + "Foot": _val(r_shin.inverted() @ foot_q),
        pre + "ToeBase": (toe, 0, 0),
    }


def _stance_targets(side, u):
    """Planted foot at stance frame u: (ankle, foot rotation, pitch)."""
    th = STANCE_PITCH[u]
    q = _qz(TOE_OUT * side) @ _qx(th)
    ball = Vector((BALL_X * side, BALL_Y_TD + SPEED * u, BALL_Z))
    ball_rest = Vector((BALL_FROM_ANKLE.x, BALL_FROM_ANKLE.y, BALL_FROM_ANKLE.z))
    return ball - q @ ball_rest, q, th


class Legs:
    """Per-leg splines: stance angles from IK, swing angles from the keys."""

    def __init__(self, bodies):
        self.bodies = bodies
        self.curves = {}
        for side, off in ((1, 0), (-1, STEP)):
            pre = "Left" if side > 0 else "Right"
            al, ka, ph, ta, xs = dict(SWING_ALPHA), dict(SWING_KAPPA), dict(SWING_PHI), dict(SWING_TAU), dict(SWING_X)
            for u in STANCE_FRAMES:
                body = bodies[(u + off) % FRAMES]
                hip = joint(body, pre + "UpLeg")
                ankle, _, th = _stance_targets(side, u)
                a, k = _leg_angles(hip, ankle)
                al[u], ka[u] = a, k
                ph[u] = th - (k - a + SHANK_REST)
                ta[u] = -th
                xs[u] = ankle.x * side
            self.curves[side] = (al, ka, ph, ta, xs)

    def pose(self, f, side):
        off = 0 if side > 0 else STEP
        u = (f - off) % FRAMES
        pre = "Left" if side > 0 else "Right"
        body = self.bodies[f % FRAMES]
        hip = joint(body, pre + "UpLeg")
        al, ka, ph, ta, xs = self.curves[side]
        if u in STANCE_FRAMES:
            ankle, q, th = _stance_targets(side, u)
            a, k = al[u], ka[u]
            toe = -th
        else:
            a, k = pspline(al, u), pspline(ka, u)
            x = pspline(xs, u) * side
            ankle = _ankle_2d(hip, a, k, x)
            th = k - a + SHANK_REST + pspline(ph, u)
            q = _qz(TOE_OUT_SWING * side) @ _qx(th)
            toe = pspline(ta, u)
        knee_hint = _knee_2d(hip, a, (hip.x + ankle.x) * 0.5)
        return solve_leg(body, side, ankle, knee_hint, q, toe)


# --- arms --------------------------------------------------------------------------
# Loose fists: fingers curled, thumb resting along the index finger.
_FIST_L = merge({
    "LeftHandIndex1": (-2, 58, 0),
    "LeftHandIndex2": (0, 70, 0),
    "LeftHandMiddle1": (0, 63, 0),
    "LeftHandMiddle2": (0, 72, 0),
    "LeftHandRing1": (2, 67, 0),
    "LeftHandRing2": (0, 72, 0),
    "LeftHandPinky1": (4, 70, 0),
    "LeftHandPinky2": (0, 70, 0),
}, left_thumb(0.55, 0.35, 0.75, 28))
_FINGER_LAG = {"Index": 0.0, "Middle": 0.5, "Ring": 1.0, "Pinky": 1.5}


def fist(f, side):
    """Loose fist for one hand; the fingers breathe a few degrees with the arm
    swing, each one a little later than its neighbour (follow-through)."""
    g = f if side > 0 else f + STEP
    out = dict(_FIST_L)
    for fn, lag in _FINGER_LAG.items():
        c = 3.0 * math.sin(2 * math.pi * (g - 13.5 - lag) / FRAMES)
        for seg, k in (("1", 1.0), ("2", 0.7)):
            b = "LeftHand" + fn + seg
            v = out[b]
            out[b] = (v[0], v[1] + c * k, v[2])
    return out if side > 0 else mirror(out)


def arm_params(f, side):
    """Shoulder swing (forward +), elbow bend, abduction and forearm inward
    angle for one arm, degrees. The left arm is most forward at ~11 (right
    touchdown at 10, arms trail the trunk by a frame) and most back at ~1."""
    g = f if side > 0 else f + STEP
    swing = -6.0 + wave(g, 31.0, 11.0) + wave(g, 2.5, 13.0, 2)
    elbow = 88.0 + wave(g, 13.0, 12.2)  # closes in front, opens behind (lags)
    elbow += wave(g, 2.0, 3.2, 2)  # forearm settles a touch after each impact
    abduct = 11.0 - wave(g, 2.0, 11.0)  # elbow flares slightly when behind
    inward = 3.0 + wave(g, 3.0, 11.0)  # hand drifts a little inward in front
    return swing, elbow, abduct, inward


def shoulder_value(f, side):
    g = f if side > 0 else f + STEP
    fwd = math.cos(2 * math.pi * (g - 11.0) / FRAMES)
    left = (0.0, 3.0 + 1.0 * fwd, -3.0 * fwd)  # protract/lift a touch in front
    return left if side > 0 else mirror({"LeftShoulder": left})["RightShoulder"]


def arm_pose(p, f, side):
    pre = "Left" if side > 0 else "Right"
    sh = shoulder_value(f, side)
    q = dict(p)
    q[pre + "Shoulder"] = sh
    s = joint(q, pre + "Arm")
    r_c, _ = fk(q, "Spine2")
    swing, elbow, abduct, inward = arm_params(f, side)
    sw, el, ab, iw = (math.radians(v) for v in (swing, elbow, abduct, inward))
    # Chest-local directions (x left, y back, z up).
    u = Vector((math.sin(ab) * side, -math.sin(sw) * math.cos(ab), -math.cos(sw) * math.cos(ab)))
    fwd = Vector((0, -1, 0))
    n = (fwd - u * fwd.dot(u)).normalized()
    v = u * math.cos(el) + n * math.sin(el)
    med = Vector((-side, 0, 0))
    med = (med - v * med.dot(v)).normalized()
    v = (v * math.cos(iw) + med * math.sin(iw)).normalized()
    elbow_pt = s + r_c @ (u * rig.UPPER_ARM)
    wrist = elbow_pt + r_c @ (v * rig.FOREARM)
    mid = (s + wrist) * 0.5
    pole = elbow_pt + (elbow_pt - mid).normalized() * 0.3
    hand_fwd = r_c @ v
    palm = r_c @ Vector((-side, 0.0, -0.3))
    out = arm_ik(q, side, wrist, pole, hand_fwd, palm, shoulder=sh, fore_twist=0.5)
    out.update(fist(f, side))
    return out


def run_pose(f, legs, bodies):
    p = dict(bodies[f % FRAMES])
    p.update(legs.pose(f, 1))
    p.update(legs.pose(f, -1))
    p.update(arm_pose(p, f, 1))
    p.update(arm_pose(p, f, -1))
    return p


def build(anim):
    bodies = [body_pose(f) for f in range(FRAMES)]
    legs = Legs(bodies)
    for f in range(0, FRAMES + 1):
        anim.key(f, run_pose(f, legs, bodies))
