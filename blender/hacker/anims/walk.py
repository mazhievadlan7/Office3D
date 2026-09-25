"""Walk: a confident, natural adult walk cycle, IN PLACE (the app moves the root).

32 frames at 30 fps, stride 1.40 m (two 0.70 m steps) -> 1.31 m/s.
Frame 0 = left heel contact, frame 16 = right heel contact.

Per step (left step shown, the right one is the same 16 frames later):
  0     contact   left heel down, toes up ~20 deg; right foot pushing off on the ball
  ~2    down      lowest pelvis, left knee takes the weight
  ~9    passing   highest pelvis, right foot passes the planted left foot
  ~13   up        left heel peels off, the body starts falling into the next step

The ground runs backward under the character at STRIDE / FRAMES per frame, so
a planted foot slides +Y at exactly that speed. The foot's contact point (heel,
then the whole sole, then the ball of the foot) is what is locked to the
ground; legs are solved with IK against the pelvis of each key, so there is no
sliding or sinking. Arms are also solved with IK from world-space swing arcs,
with the forearm, hand and fingers trailing the upper arm (follow-through).

Axis conventions: see pose.py. IK helpers come from _base.
"""

import math
import os

from mathutils import Quaternion, Vector

import rig
from _base import _two_bone, _twist_angle, _val, arm_ik, fk, joint, left_thumb, look_at, point
from pose import merge, mirror

NAME = "Walk"
FRAMES = 32
CYCLIC = True

STRIDE = 1.40
V = STRIDE / FRAMES  # ground speed, m per frame (+Y = backward)
W = 2 * math.pi / FRAMES  # one cycle
X_AX = Vector((1, 0, 0))
Z_AX = Vector((0, 0, 1))


# --- small curve helpers ------------------------------------------------------
def _smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def _hermite(pts, t):
    """Cubic Hermite through [(t, value, slope)], slopes None -> Catmull-Rom."""
    pts = list(pts)
    n = len(pts)
    for k, (tk, vk, mk) in enumerate(pts):
        if mk is None:
            (ta, va, _), (tb, vb, _) = pts[max(k - 1, 0)], pts[min(k + 1, n - 1)]
            pts[k] = (tk, vk, (vb - va) / (tb - ta))
    k = 0
    while k < len(pts) - 2 and t > pts[k + 1][0]:
        k += 1
    (t0, v0, m0), (t1, v1, m1) = pts[k], pts[k + 1]
    h = t1 - t0
    s = (t - t0) / h
    return (v0 * (2 * s ** 3 - 3 * s ** 2 + 1) + m0 * (h * (s ** 3 - 2 * s ** 2 + s))
            + v1 * (-2 * s ** 3 + 3 * s ** 2) + m1 * (h * (s ** 3 - s ** 2)))


class Loop:
    """Periodic cubic through (frame, value) points; Catmull-Rom slopes."""

    def __init__(self, pts, period=FRAMES):
        pts = sorted(pts)
        self.period = period
        ext = [(t - period, v) for t, v in pts[-2:]] + pts + [(t + period, v) for t, v in pts[:2]]
        self.pts = [(t, v, None) for t, v in ext]

    def __call__(self, t):
        t = t % self.period
        return _hermite(self.pts, t)


# --- feet ----------------------------------------------------------------------
# Left-foot timing in frames (the right foot runs 16 frames later).
HS_PITCH = 20.0  # toes up at heel contact
FF = 3.0  # foot flat
HO = 12.5  # heel off: the foot rolls over the ball (toes flat on the floor)
TT = 17.0  # ... then over the toe tip (toes peel up)
TO = 19.0  # toe off (59% stance, ~3 frames of double support)
P_TT = 42.0  # heel-up angle when the roll reaches the toe tip
P_TO = 58.0  # ... and at toe off
PUSH = [(HO, 0.0, 0.0), (TT, P_TT, 9.0), (TO, P_TO, 8.0)]  # (frame, pitch, slope)
Y0 = -0.320  # y of the flat-foot ankle at frame 0; it runs back at V per frame
XS = 0.07  # ankle x while planted (left; right mirrored)
TOE_OUT = 6.0
L1 = (rig.tail_of("LeftUpLeg") - rig.head_of("LeftUpLeg")).length
L2 = (rig.tail_of("LeftLeg") - rig.head_of("LeftLeg")).length

ANKLE_REST = Vector((0.0, 0.025, 0.09))
BALL_REST = Vector((0.0, -0.095, 0.03))  # ToeBase head (ball of the foot)
TIP_REST = Vector((0.0, -0.175, 0.0))  # front edge of the boot sole
HEEL = Vector((0.0, 0.075, 0.0)) - ANKLE_REST  # back edge of the heel
BALL = BALL_REST - ANKLE_REST

# Swing, left leg, joint space in the side plane (degrees): thigh angle from
# vertical (+ = forward), knee bend, ankle plantarflexion. The ends (toe off,
# heel contact) are taken from the planted-foot solution so the curves join it
# with matching speed.
SWING_THIGH = [(20.5, -1.0), (22.0, 6.0), (23.5, 13.0), (25.0, 19.0), (26.5, 23.0),
               (28.0, 26.0), (29.5, 27.0), (31.0, 26.0)]
SWING_KNEE = [(20.5, 47.0), (22.0, 58.0), (23.5, 62.0), (25.0, 57.0), (26.5, 45.0),
              (28.0, 30.0), (29.5, 16.0), (31.0, 8.0)]
SWING_ANKLE = [(21.0, 12.0), (23.5, 3.0), (26.0, -2.0), (29.0, -3.0)]
SWING_OUT = [(25.0, 0.012)]  # the ankle drifts out a little while passing
SWING_TOE = [(20.5, -18.0), (22.5, -3.0), (24.0, 0.0)]


def _foot_q(pitch, side):
    return Quaternion(Z_AX, math.radians(TOE_OUT * side)) @ Quaternion(X_AX, math.radians(pitch))


def _stance(t):
    """Left foot on the ground, t in [0, TO]: (ankle, pitch, toe bend).
    Heel rocker (pivot on the heel edge) -> flat -> forefoot rocker (pivot on
    the ball, toes flat) -> toe rocker (pivot on the toe tip). The pivot is
    locked to the ground, which runs back at V per frame."""
    anchor = Vector((XS, Y0 + V * t, 0.09))
    rz = Quaternion(Z_AX, math.radians(TOE_OUT))
    if t < HO:
        pitch = -HS_PITCH * (1 - min(t / FF, 1.0)) ** 2  # foot slap: fast, then eases onto the floor
        return anchor + rz @ HEEL - _foot_q(pitch, 1) @ HEEL, pitch, 0.0
    pitch = _hermite(PUSH, min(t, TO))
    if t <= TT:
        return anchor + rz @ BALL - _foot_q(pitch, 1) @ BALL, pitch, -pitch
    toe = -P_TT
    tip = anchor + rz @ (TIP_REST - ANKLE_REST)
    ball = tip - _foot_q(pitch + toe, 1) @ (TIP_REST - BALL_REST)
    return ball - _foot_q(pitch, 1) @ BALL, pitch, toe


def hip_at(t):
    return joint(body(t), "LeftUpLeg")


def _sag(hip, ankle):
    """Thigh angle, knee bend, shin angle (deg, + = forward) of the leg from
    hip to ankle in the side plane."""
    dy, dz = ankle.y - hip.y, ankle.z - hip.z
    d = min(math.hypot(dy, dz), L1 + L2 - 1e-6)
    beta = math.atan2(-dy, -dz)
    a1 = math.acos(max(-1.0, min(1.0, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))))
    a2 = math.acos(max(-1.0, min(1.0, (L2 * L2 + d * d - L1 * L1) / (2 * L2 * d))))
    phi, psi = math.degrees(beta + a1), math.degrees(beta - a2)
    return phi, phi - psi, psi


def _fk_ankle(hip, phi, kappa):
    a, b = math.radians(phi), math.radians(phi - kappa)
    return Vector((0.0, hip.y - L1 * math.sin(a) - L2 * math.sin(b), hip.z - L1 * math.cos(a) - L2 * math.cos(b)))


_SW = {}


def _swing_setup():
    eps = 0.01

    def st(t):
        a, pitch, _ = _stance(t % FRAMES)
        phi, kap, psi = _sag(hip_at(t), a)
        return a, phi, kap, pitch + psi

    a0, ph0, k0, al0 = st(TO)
    a0m, ph0m, k0m, al0m = st(TO - eps)
    a1, ph1, k1, al1 = st(FRAMES)
    a1p, ph1p, k1p, al1p = st(FRAMES + eps)

    def track(v0, d0, pts, v1, d1):
        return [(TO, v0, d0)] + [(t, v, None) for t, v in pts] + [(FRAMES, v1, d1)]

    sw = {
        "thigh": track(ph0, (ph0 - ph0m) / eps, SWING_THIGH, ph1, (ph1p - ph1) / eps),
        "knee": track(k0, (k0 - k0m) / eps, SWING_KNEE, k1, (k1p - k1) / eps),
        # before contact the foot holds its angle (the slap starts on impact)
        "ankle": track(al0, (al0 - al0m) / eps, SWING_ANKLE, al1, (ph1p - ph1 - k1p + k1) / eps),
        "out": track(0.0, 0.0, SWING_OUT, 0.0, 0.0),
        "toe": track(-P_TT, 0.0, SWING_TOE, 0.0, 0.0),
    }
    _SW.update(sw)

    def fk_at(t):
        return _fk_ankle(hip_at(t), _hermite(sw["thigh"], t), _hermite(sw["knee"], t))

    # Position/velocity mismatch at both ends, blended out over the swing.
    f0, f0e = fk_at(TO), fk_at(TO + eps)
    f1, f1e = fk_at(FRAMES), fk_at(FRAMES - eps)
    _SW["d0"] = a0 - f0
    _SW["v0"] = (a0 - a0m) / eps - (f0e - f0) / eps
    _SW["d1"] = a1 - f1
    _SW["v1"] = (a1p - a1) / eps - (f1 - f1e) / eps
    for k in ("d0", "v0", "d1", "v1"):
        _SW[k].x = 0.0


def _swing(t):
    if not _SW:
        _swing_setup()
    phi, kap = _hermite(_SW["thigh"], t), _hermite(_SW["knee"], t)
    ankle = _fk_ankle(hip_at(t), phi, kap)
    T = FRAMES - TO
    s = (t - TO) / T
    ankle += (_SW["d0"] * (2 * s ** 3 - 3 * s ** 2 + 1) + _SW["v0"] * (T * (s ** 3 - 2 * s ** 2 + s))
              + _SW["d1"] * (-2 * s ** 3 + 3 * s ** 2) + _SW["v1"] * (T * (s ** 3 - s ** 2)))
    ankle.x = XS + _hermite(_SW["out"], t)
    pitch = _hermite(_SW["ankle"], t) - (phi - kap)
    return ankle, pitch, _hermite(_SW["toe"], t)


def foot_state(t):
    """Left foot at cycle time t: (ankle, heel-up pitch, toe bend)."""
    t = t % FRAMES
    return _stance(t) if t <= TO else _swing(t)


def leg_solve(p, side, ankle, pitch, toe):
    """UpLeg/Leg/Foot/ToeBase values putting the ankle at `ankle` with the foot
    pitched `pitch` deg (+ = heel up) and turned out TOE_OUT deg."""
    pre = "Left" if side > 0 else "Right"
    r_h, t_h = fk(p, "Hips")
    hip = r_h @ rig.head_of(pre + "UpLeg") + t_h
    t0 = (rig.tail_of(pre + "UpLeg") - rig.head_of(pre + "UpLeg")).normalized()
    s0 = (rig.tail_of(pre + "Leg") - rig.head_of(pre + "Leg")).normalized()
    l1 = (rig.tail_of(pre + "UpLeg") - rig.head_of(pre + "UpLeg")).length
    l2 = (rig.tail_of(pre + "Leg") - rig.head_of(pre + "Leg")).length
    fwd = Quaternion(Z_AX, math.radians(0.6 * TOE_OUT * side)) @ Vector((0, -1, 0))
    pole = (hip + ankle) * 0.5 + fwd * 0.8
    knee, a = _two_bone(hip, ankle, l1, l2, pole)
    r_thigh = (r_h @ t0).rotation_difference((knee - hip).normalized()) @ r_h
    r_shin = (r_thigh @ s0).rotation_difference((a - knee).normalized()) @ r_thigh
    r_foot = _foot_q(pitch, side)
    tw = _twist_angle(r_shin.inverted() @ r_foot, s0)
    r_shin = r_shin @ Quaternion(s0, tw * 0.5)
    return {
        pre + "UpLeg": _val(r_h.inverted() @ r_thigh),
        pre + "Leg": _val(r_thigh.inverted() @ r_shin),
        pre + "Foot": _val(r_shin.inverted() @ r_foot),
        pre + "ToeBase": (toe, 0.0, 0.0),
    }


def legs(p, f):
    out = {}
    for side, t in ((1, f), (-1, f - 16)):
        ankle, pitch, toe = foot_state(t)
        ankle = Vector((ankle.x * side, ankle.y, ankle.z))
        out.update(leg_solve(p, side, ankle, pitch, toe))
    return out


# --- pelvis and spine ----------------------------------------------------------
# Pelvis height comes from the legs: the knee of the leading (weight-accepting)
# leg follows this profile (degrees between thigh and shin; the rest pose has
# 3.4) and the Hips height is solved per frame to match it. Frames 12..16 (heel
# off, falling into the next step) are bridged by the spline, so the lowest
# point lands just after contact (down) and the highest near passing.
STANCE_KNEE = [(0.0, 11.5), (1.0, 16.0), (2.0, 19.5), (3.0, 21.0), (4.5, 21.5), (6.0, 20.8),
               (8.0, 18.8), (10.0, 16.3), (12.0, 14.5)]
_BOB = []


def _knee_deg(d):
    c = (d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def _solve_bob():
    pts = []
    for i in range(0, 25):
        t = i * 0.5
        ankle = _stance(t)[0]
        want = _hermite([(tk, v, None) for tk, v in STANCE_KNEE], t)
        lo, hi = -0.15, 0.02
        for _ in range(40):
            z = 0.5 * (lo + hi)
            d = (ankle - joint(body(t, z), "LeftUpLeg")).length
            if _knee_deg(d) > want:
                lo = z
            else:
                hi = z
        pts.append((t, 0.5 * (lo + hi)))
    _BOB.append(Loop(pts, period=16))


def bob(f):
    if not _BOB:
        _solve_bob()
    return _BOB[0](f)


def pelvis(f, z=None):
    """Hips@ offset and Hips rotation (pitch, roll, yaw) in degrees."""
    x = 0.018 * math.sin(W * (f - 0.5))  # over the stance foot
    y = -0.006 * math.sin(2 * W * (f - 1))  # faster at double support, slower at passing
    z = bob(f) if z is None else z
    pitch = 3.0 + 1.0 * math.cos(2 * W * (f - 12))
    roll = -3.5 * math.sin(W * (f + 3))  # swing-side hip drops (+ = left hip down)
    yaw = -5.0 * math.cos(W * f)  # leading hip forward at contact (- = left hip forward)
    return (x, y, z), (pitch, roll, yaw)


def chest(f):
    """Chest (Spine2) world orientation: pitch, roll, yaw in degrees."""
    pitch = 4.0 + 0.8 * math.cos(2 * W * (f - 3))
    roll = 0.4 * 3.5 * math.sin(W * (f + 2))  # counters the pelvis roll, 1 frame late
    yaw = 4.0 * math.cos(W * (f - 1))  # right shoulder forward at left contact
    return pitch, roll, yaw


def body(f, z=None):
    off, (pp, pr, py) = pelvis(f, z)
    cp, cr, cy = chest(f)
    dp, dr, dy = cp - pp, cr - pr, cy - py
    return {
        "Hips@": off,
        "Hips": (pp, pr, py),
        "Spine": (0.3 * dp, 0.3 * dr, 0.3 * dy),
        "Spine1": (0.35 * dp, 0.35 * dr, 0.35 * dy),
        "Spine2": (0.35 * dp, 0.35 * dr, 0.35 * dy),
        "Neck": (2.0, 0.0, 0.0),
        "Head": (-2.0, 0.0, 0.0),
    }


def head(p, f):
    r, t = fk(p, "Head")
    eye = r @ Vector((0.0, -0.085, 1.686)) + t
    p = look_at(p, Vector((0.0, -8.0, eye.z - 8.0 * math.tan(math.radians(3.0)))))
    _, cr, cy = chest(f - 1)
    nod = 0.8 * math.cos(2 * W * (f - 4))
    return merge(p, {"Neck": (0.0, -0.4 * cr, 0.0), "Head": (nod, -0.4 * cr, 0.12 * cy)})


# --- arms ----------------------------------------------------------------------
UP_OUT = 11.0  # upper arm hangs this far out from vertical
FORE_OUT = 6.0


def _dir(side, out_deg, fwd_deg):
    o, a = math.radians(out_deg), math.radians(fwd_deg)
    return Vector((side * math.sin(o) * math.cos(a), -math.sin(a), -math.cos(o) * math.cos(a))).normalized()


def arm_swing(f, side):
    """(upper arm fwd angle, elbow bend, hand fwd angle) in degrees; + = forward.
    The left arm swings with the right leg (forward at right contact, f16)."""
    c = 16 if side > 0 else 0
    up = lambda t: -3.5 + 16.5 * math.cos(W * (t - c - 1.5))
    bend = lambda t: 26.0 + 12.0 * math.cos(W * (t - c - 3.0))
    fore = lambda t: up(t) + bend(t)
    return up(f), bend(f), fore(f - 2.5)


_FINGERS_L = merge({
    "LeftHandIndex1": (-2, 15, 0),
    "LeftHandIndex2": (0, 20, 0),
    "LeftHandMiddle1": (0, 19, 0),
    "LeftHandMiddle2": (0, 24, 0),
    "LeftHandRing1": (2, 23, 0),
    "LeftHandRing2": (0, 26, 0),
    "LeftHandPinky1": (4, 26, 0),
    "LeftHandPinky2": (0, 28, 0),
}, left_thumb(0.6, 0.55, 0.35, 10))


def arm(p, f, side):
    pre = "Left" if side > 0 else "Right"
    up, bend, hand = arm_swing(f, side)
    _, _, cy = chest(f)
    yaw = Quaternion(Z_AX, math.radians(0.5 * cy))
    prot = -2.5 * (up / 16.5) * side  # clavicle protracts as the arm swings forward
    sh = (0.0, 3.0 * side, prot)
    q = dict(p)
    q[pre + "Shoulder"] = sh
    s = joint(q, pre + "Arm")
    u1 = yaw @ _dir(side, UP_OUT - 0.12 * up, up)
    u2 = yaw @ _dir(side, FORE_OUT - 0.1 * (up + bend), up + bend)
    u3 = yaw @ _dir(side, FORE_OUT - 0.1 * hand, hand)
    e = s + u1 * rig.UPPER_ARM
    w = e + u2 * rig.FOREARM
    pole = e + (e - (s + w) * 0.5).normalized() * 0.3
    palm = Vector((-side, 0.3, 0.0))
    out = arm_ik(q, side, w, pole=pole, hand_fwd=u3, palm=palm, shoulder=sh)
    # Fingers trail the hand: open a touch while it accelerates, curl as it stops.
    c = 16 if side > 0 else 0
    k = math.cos(W * (f - c - 5))
    fing = merge(_FINGERS_L, {
        "LeftHandIndex1": (0, 2.0 * k, 0),
        "LeftHandMiddle1": (0, 2.5 * k, 0),
        "LeftHandRing1": (0, 3.0 * k, 0),
        "LeftHandPinky1": (0, 3.5 * k, 0),
        "LeftHandIndex2": (0, 1.5 * k, 0),
        "LeftHandMiddle2": (0, 2.0 * k, 0),
    })
    out.update(fing if side > 0 else mirror(fing))
    return out


# --- assemble --------------------------------------------------------------------
def pose_at(f):
    p = body(f)
    p.update(legs(p, f))
    p = head(p, f)
    p.update(arm(p, f, 1))
    p.update(arm(p, f, -1))
    return p


def _diagnostics():
    sole = [Vector((0, 0.075, 0.0)), Vector((0.04, 0.07, 0.0)), Vector((-0.04, 0.07, 0.0)),
            Vector((0, -0.095, 0.0))]
    toe = [Vector((0, -0.19, 0.012)), Vector((0, -0.15, 0.0))]
    foot_state(TO + 1)
    for k in ("thigh", "knee", "ankle"):
        (t0, v0, d0), (t1, v1, d1) = _SW[k][0], _SW[k][-1]
        print(f"[walk] swing {k}: TO {v0:6.1f} ({d0:+.1f}/f)  HS {v1:6.1f} ({d1:+.1f}/f)")
    print(f"[walk] swing corr d0 {tuple(round(c, 4) for c in _SW['d0'])} v0 {tuple(round(c, 4) for c in _SW['v0'])}"
          f" d1 {tuple(round(c, 4) for c in _SW['d1'])} v1 {tuple(round(c, 4) for c in _SW['v1'])}")
    for f in range(0, FRAMES + 1):
        p = pose_at(f)
        row = []
        for pre, x in (("Left", 0.095), ("Right", -0.095)):
            h, k, a = joint(p, pre + "UpLeg"), joint(p, pre + "Leg"), joint(p, pre + "Foot")
            ang = math.degrees((k - h).angle(a - k))
            reach = (a - h).length
            zs = [point(p, pre + "Foot", Vector((x, 0, 0)) + v).z for v in sole]
            zs += [point(p, pre + "ToeBase", Vector((x, 0, 0)) + v).z for v in toe]
            row.append(f"{pre[0]} knee {ang:5.1f} reach {reach:.3f} low {min(zs):+.3f}")
        el = []
        for pre in ("Left", "Right"):
            s, e, w = joint(p, pre + "Arm"), joint(p, pre + "ForeArm"), joint(p, pre + "Hand")
            el.append(f"{pre[0]} elbow {math.degrees((e - s).angle(w - e)):4.1f} wrist y {w.y:+.3f}")
        hz = joint(p, "Hips").z
        print(f"[walk] f{f:02d} hips z {hz:.3f} | " + " | ".join(row) + " | " + " | ".join(el))


def build(anim):
    for f in range(0, FRAMES + 1, 2):
        anim.key(f, pose_at(f))  # everything is periodic: frame FRAMES == frame 0
    if os.environ.get("WALK_DEBUG"):
        _diagnostics()
