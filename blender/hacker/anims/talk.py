"""Standing conversation (stand-ups, talking to another agent), in place.

Beats (30 fps, 144 frames):
  0-12    relaxed, weight on the right leg, breath in before speaking
  12-36   right hand explains: rises palm-up, one beat with a head nod, then
          opens out to the side while the eyes follow it
  36-80   both hands: "this big", a two-hand beat with a nod, a smaller second
          beat, then the hands spread palms-up
  80-108  listen: arms fall back and swing to rest, weight rolls onto the left
          leg, head tilts, a double "mm-hm" nod
  108-136 small shrug: shoulders up, palms turn out, head tilts the other way,
          then a sighing drop with a little settle
  136-144 back to the start pose

Built on _base.STAND. Feet are solved with leg_ik every key so they never
slide; arms are solved with arm_ik from targets that live in chest space, so
the gestures ride on the weight shifts. Each channel is a periodic monotone
spline; the clavicle leads the wrist, the hand orientation trails it and the
fingers trail further with a small index-to-pinky cascade (overlap).
"""

import math

from mathutils import Vector

import _base as B
from _base import STAND, arm_ik, fk, joint, leg_ik, look_at, override
from pose import merge, mirror

NAME = "Talk"
FRAMES = 144
CYCLIC = True
STEP = 3  # key spacing in frames


# --- periodic monotone cubic (PCHIP) tracks -----------------------------------
def _pchip_slopes(ts, ys, period):
    n = len(ts)
    m = []
    for i in range(n):
        t0, t1, t2 = ts[i - 1] - (period if i == 0 else 0), ts[i], ts[(i + 1) % n] + (period if i == n - 1 else 0)
        y0, y1, y2 = ys[i - 1], ys[i], ys[(i + 1) % n]
        h0, h1 = t1 - t0, t2 - t1
        d0, d1 = (y1 - y0) / h0, (y2 - y1) / h1
        if d0 * d1 <= 0:
            m.append(0.0)
        else:
            w1, w2 = 2 * h1 + h0, h1 + 2 * h0
            m.append((w1 + w2) / (w1 / d0 + w2 / d1))
    return m


class Track:
    """Periodic keys [(frame, value)], value a float or a tuple."""

    def __init__(self, keys, period=FRAMES):
        keys = sorted(keys, key=lambda k: k[0])
        self.period = period
        self.ts = [float(k[0]) for k in keys]
        vals = [k[1] if isinstance(k[1], (tuple, list, Vector)) else (k[1],) for k in keys]
        self.scalar = not isinstance(keys[0][1], (tuple, list, Vector))
        self.dim = len(vals[0])
        self.ys = [[float(v[c]) for v in vals] for c in range(self.dim)]
        self.ms = [_pchip_slopes(self.ts, ys, period) for ys in self.ys]

    def __call__(self, t):
        P = self.period
        t = t % P
        ts = self.ts
        n = len(ts)
        if t < ts[0] or t >= ts[-1]:  # wrap segment
            i, j = n - 1, 0
            ta, tb = ts[-1], ts[0] + P
            if t < ts[0]:
                t += P
        else:
            i = max(k for k in range(n) if ts[k] <= t)
            j = i + 1
            ta, tb = ts[i], ts[j]
        h = tb - ta
        s = (t - ta) / h
        h00 = 2 * s ** 3 - 3 * s ** 2 + 1
        h10 = s ** 3 - 2 * s ** 2 + s
        h01 = -2 * s ** 3 + 3 * s ** 2
        h11 = s ** 3 - s ** 2
        out = []
        for c in range(self.dim):
            y, m = self.ys[c], self.ms[c]
            out.append(h00 * y[i] + h10 * h * m[i] + h01 * y[j] + h11 * h * m[j])
        return out[0] if self.scalar else Vector(out)


def _norm(v):
    return Vector(v).normalized()


# --- reference data from STAND (chest space = Spine2 rest frame) ----------------
_R2, _T2 = fk(STAND, "Spine2")
_R2I = _R2.inverted()


def _to_chest(p_world):
    return _R2I @ (Vector(p_world) - _T2)


_D0 = (B.rig.tail_of("LeftArm") - B.rig.head_of("LeftArm")).normalized()
_N0 = B.rig._palm_normal(1)
S_REST = _to_chest(joint(STAND, "LeftArm"))  # left shoulder joint, chest space
_HANG_W = _to_chest(joint(STAND, "LeftHand"))
_HANG_E = _to_chest(joint(STAND, "LeftForeArm"))
_rh, _ = fk(STAND, "LeftHand")
_HANG_FWD = _R2I @ (_rh @ _D0)
_HANG_PALM = _R2I @ (_rh @ _N0)
# Pole: push the elbow away from the shoulder-wrist line (back and out).
_mid = S_REST + (_HANG_W - S_REST) * ((_HANG_E - S_REST).dot(_HANG_W - S_REST) / (_HANG_W - S_REST).length_squared)
_HANG_POLE = (_HANG_E + (_HANG_E - _mid).normalized() * 0.4) - S_REST

ANKLE_L = joint(STAND, "LeftFoot")
ANKLE_R = joint(STAND, "RightFoot")
KNEE_POLE = Vector((0.12, -1.0, 0.45))  # left; x mirrored for the right knee
LISTENER = Vector((0.0, -1.4, 1.62))  # eyes of the other agent

# --- fingers (left values; mirrored for the right hand) -------------------------
_FINGERS = ["Index", "Middle", "Ring", "Pinky"]
RELAX_F = {k: v for k, v in STAND.items() if k.startswith("LeftHand") and k != "LeftHand"}
OPEN_F = merge({  # open but soft: index straightest, pinky most curled
    "LeftHandIndex1": (-4, 4, 0),
    "LeftHandIndex2": (0, 7, 0),
    "LeftHandMiddle1": (-1, 7, 0),
    "LeftHandMiddle2": (0, 10, 0),
    "LeftHandRing1": (2, 10, 0),
    "LeftHandRing2": (0, 13, 0),
    "LeftHandPinky1": (5, 13, 0),
    "LeftHandPinky2": (0, 16, 0),
}, B.left_thumb(0.55, 0.75, 0.15, 8))
SPREAD_F = {
    "LeftHandIndex1": (-5, -1, 0),
    "LeftHandMiddle1": (-1.5, 0, 0),
    "LeftHandRing1": (2.5, 0, 0),
    "LeftHandPinky1": (6, 0, 0),
    "LeftHandThumb1": (-4, -2, 3),
}


def _fingers(open_of, spread_of, t, life):
    """Finger values for one (left-convention) hand. open_of/spread_of are
    tracks; each finger samples them a little later than the one before."""
    out = {}
    lag = {"Thumb": 2.0, "Index": 3.0, "Middle": 3.6, "Ring": 4.2, "Pinky": 4.8}
    for f in ["Thumb"] + _FINGERS:
        o = max(0.0, min(1.1, open_of(t - lag[f])))
        s = max(0.0, spread_of(t - lag[f]))
        wob = life * math.sin(2 * math.pi * (t / FRAMES) * 3 + lag[f] * 1.3)
        for seg in (1, 2):
            k = f"LeftHand{f}{seg}"
            a = RELAX_F.get(k, (0, 0, 0))
            b = OPEN_F.get(k, (0, 0, 0))
            c = SPREAD_F.get(k, (0, 0, 0))
            v = [a[i] * (1 - o) + b[i] * o + c[i] * s for i in range(3)]
            if f != "Thumb":
                v[1] += wob * (1.0 if seg == 1 else 1.3)
            out[k] = tuple(v)
    return out


# --- arm key poses (left convention, chest space; x = out to that arm's side) ---
def A(w, fwd, palm, pole=(0.4, 0.28, -0.6), sh=(0, 1.5, -3), op=1.0, sp=0.0):
    return dict(w=Vector(w), fwd=_norm(fwd), palm=_norm(palm), pole=Vector(pole), sh=sh, op=op, sp=sp)


_HANG_DIST = (_HANG_W - S_REST).length
_HANG_W2 = S_REST + (_HANG_W + Vector((0.012, -0.004, 0.0)) - S_REST).normalized() * _HANG_DIST * 0.995
_HANG_POLE2 = _HANG_POLE + Vector((0.2, 0.0, 0.0))
HANG = dict(w=_HANG_W2, fwd=_HANG_FWD, palm=_HANG_PALM, pole=_HANG_POLE2, sh=(0, 3, 0), op=0.0, sp=0.0)


def hang(dx=0.0, dy=0.0, dz=0.0, sh=(0, 3, 0), op=0.0, bend=0.0):
    """Relaxed hanging arm swung by (dx, dy, dz) metres at the wrist, arm length
    kept (so the elbow never locks straight); bend shortens it a little."""
    h = dict(HANG)
    v = (_HANG_W2 + Vector((dx, dy, dz)) - S_REST).normalized()
    h["w"] = S_REST + v * (_HANG_W2 - S_REST).length * (1.0 - bend)
    h["sh"] = sh
    h["op"] = op
    return h


RAISE = A((0.175, -0.255, 1.085), (-0.1, -0.97, 0.22), (-0.6, -0.12, 0.8))
RAISE_UP = A((0.172, -0.265, 1.11), (-0.08, -0.97, 0.26), (-0.58, -0.12, 0.8))
BEAT1 = A((0.168, -0.285, 1.06), (-0.1, -0.97, 0.04), (-0.52, -0.18, 0.83))
RAISE2 = A((0.18, -0.27, 1.085), (-0.05, -0.97, 0.18), (-0.45, -0.2, 0.87))
OUT = A((0.265, -0.235, 1.08), (0.42, -0.9, 0.12), (0.12, -0.35, 0.93), pole=(0.45, 0.25, -0.6), sh=(0, 1, -2), sp=0.6)
OUT2 = A((0.28, -0.22, 1.07), (0.48, -0.87, 0.08), (0.15, -0.33, 0.93), pole=(0.45, 0.25, -0.6), sh=(0, 1.5, -2), sp=0.7)
BOTH = A((0.152, -0.275, 1.09), (-0.12, -0.98, 0.16), (-0.66, -0.08, 0.74))
BOTH_UP = A((0.15, -0.28, 1.112), (-0.1, -0.98, 0.2), (-0.68, -0.08, 0.72))
BEAT = A((0.146, -0.298, 1.05), (-0.1, -0.98, 0.0), (-0.6, -0.12, 0.78))
BOTH2 = A((0.155, -0.285, 1.08), (-0.1, -0.98, 0.14), (-0.62, -0.1, 0.76))
BEAT2 = A((0.16, -0.293, 1.06), (-0.06, -0.98, 0.06), (-0.6, -0.14, 0.78))
SPREAD = A((0.255, -0.24, 1.07), (0.5, -0.85, 0.1), (0.06, -0.3, 0.95), pole=(0.5, 0.2, -0.6), sh=(0, 1, -2), sp=1.0)
SPREAD2 = A((0.265, -0.215, 1.045), (0.5, -0.85, 0.02), (0.08, -0.28, 0.95), pole=(0.5, 0.2, -0.6), sh=(0, 2, -1.5), sp=0.8)
DROP = A((0.26, -0.10, 0.95), (0.3, -0.55, -0.78), (-0.95, 0.05, 0.2), pole=(0.4, 0.3, -0.6), sh=(0, 2.5, -1), op=0.45, sp=0.2)
SHRUG_AT = A((0.255, -0.03, 0.905), (0.08, -0.15, -0.98), (-0.98, -0.12, 0.0), pole=_HANG_POLE2, sh=(0, 4.5, 0), op=0.15)
# Shrug: clavicles up, elbows stay tucked at the sides, forearms swing out
# (humerus external rotation) and the palms turn up.
SHRUG = A((0.338, -0.17, 1.06), (0.42, -0.87, -0.2), (0.3, -0.15, 0.94), pole=(0.3, 0.5, -0.5), sh=(0, -11, -2.5), sp=0.9)
SHRUG2 = A((0.343, -0.16, 1.05), (0.43, -0.86, -0.22), (0.32, -0.14, 0.94), pole=(0.3, 0.5, -0.5), sh=(0, -10, -2.5), sp=0.8)
SHRUG_L = A((0.32, -0.155, 1.04), (0.4, -0.87, -0.26), (0.26, -0.16, 0.95), pole=(0.3, 0.5, -0.5), sh=(0, -9, -2), sp=0.7)
SHRUG2_L = A((0.325, -0.145, 1.03), (0.41, -0.86, -0.28), (0.28, -0.15, 0.95), pole=(0.3, 0.5, -0.5), sh=(0, -8, -2), sp=0.6)
SHRUG_DROP = A((0.275, -0.09, 0.94), (0.25, -0.4, -0.88), (-0.95, 0.05, 0.2), pole=(0.4, 0.35, -0.6), sh=(0, 3, -0.5), op=0.5, sp=0.3)

ARM_KEYS = {
    -1: [  # right arm: explains first, leads the two-hand phrase
        (0, hang()),
        (6, hang(0.0, -0.012, 0.006, sh=(0, 2.4, -1))),
        (16, RAISE),
        (20, RAISE_UP),
        (25, BEAT1),
        (30, RAISE2),
        (37, OUT),
        (43, OUT2),
        (49, BOTH),
        (54, BOTH_UP),
        (59, BEAT),
        (64, BOTH2),
        (69, BEAT2),
        (76, SPREAD),
        (81, SPREAD2),
        (88, DROP),
        (95, hang(0.0, 0.018, -0.004, sh=(0, 3.5, 0))),
        (101, hang(0.002, -0.004, 0.0)),
        (107, SHRUG_AT),
        (118, SHRUG),
        (125, SHRUG2),
        (132, SHRUG_DROP),
        (138, hang(0.0, 0.01, -0.006, sh=(0, 4, 0))),
    ],
    1: [  # left arm: hangs, joins for the two-hand phrase a frame behind
        (0, hang()),
        (14, hang(-0.002, 0.006, 0.002)),
        (30, hang(0.0, -0.006, 0.004, sh=(0, 2.6, -0.5))),
        (36, hang(-0.004, -0.03, 0.02, sh=(0, 2, -1.5), op=0.3)),
        (47, BOTH),
        (55, BOTH_UP),
        (60, BEAT),
        (65, BOTH2),
        (70, BEAT2),
        (77, SPREAD),
        (83, SPREAD2),
        (91, DROP),
        (98, hang(0.0, 0.015, -0.004, sh=(0, 3.5, 0))),
        (104, hang(-0.002, -0.003, 0.0)),
        (108, SHRUG_AT),
        (119, SHRUG_L),
        (126, SHRUG2_L),
        (134, SHRUG_DROP),
        (140, hang(0.0, 0.008, -0.005, sh=(0, 3.8, 0))),
    ],
}


class ArmTracks:
    def __init__(self, keys):
        def tr(field, fn=lambda v: v):
            return Track([(f, fn(k[field])) for f, k in keys])

        self.w = tr("w", lambda w: tuple(w - S_REST))
        self.dist = Track([(f, (k["w"] - S_REST).length) for f, k in keys])
        self.fwd = tr("fwd", tuple)
        self.palm = tr("palm", tuple)
        self.pole = tr("pole", tuple)
        self.sh = tr("sh", tuple)
        self.op = tr("op")
        self.sp = tr("sp")


ARMS = {side: ArmTracks(keys) for side, keys in ARM_KEYS.items()}

# --- body tracks ----------------------------------------------------------------
# weight: + on the left leg, - on the right
T_WEIGHT = Track([(0, -0.3), (14, -0.45), (34, -0.3), (52, 0.12), (68, 0.45), (84, 0.75),
                  (98, 0.85), (112, 0.72), (124, 0.42), (136, -0.1)])
# chest pitch, + leans forward (degrees, spread over the spine)
T_LEAN = Track([(0, 0.0), (8, -0.8), (18, 1.0), (25, 2.4), (31, 1.2), (38, 0.4), (46, 0.0),
                (51, -0.6), (59, 2.8), (64, 1.5), (69, 2.2), (77, 0.8), (86, -0.4), (98, 0.8),
                (105, 1.0), (109, 0.4), (118, -1.4), (126, -1.1), (135, 0.6)])
# chest yaw, + turns toward the character's left (right shoulder forward)
T_TURN = Track([(0, 0.0), (10, 1.0), (19, 3.0), (27, 3.4), (37, -1.2), (44, -1.0), (52, 0.3),
                (60, 0.8), (76, 0.0), (92, -2.0), (108, -1.6), (120, 0.4), (134, 0.2)])
# breath, + inhale
T_BREATH = Track([(0, 0.0), (7, 1.0), (14, 0.6), (30, 0.15), (44, 0.0), (50, 0.9), (62, 0.45),
                  (78, 0.0), (86, 0.6), (100, 0.15), (115, 0.9), (123, 0.8), (133, -0.35)])
# head: nod (+ down), tilt (+ toward the left), glance (target x, m)
T_NOD = Track([(0, 0.0), (21, 0.0), (23, -1.2), (26, 6.5), (31, -1.2), (35, 0.0), (54, 0.0),
               (57, -1.5), (61, 7.0), (66, -0.8), (67, 1.5), (70, 4.0), (74, -0.4), (78, 0.0),
               (96, 0.0), (99, 4.5), (102, 0.6), (105, 3.8), (108, 0.0), (111, -1.0),
               (118, 2.0), (125, 1.6), (131, -0.8), (137, 0.0)])
T_TILT = Track([(0, 0.0), (20, -1.0), (40, 1.0), (60, 0.0), (84, 0.3), (93, 5.0), (106, 4.0),
                (112, 1.0), (118, -4.5), (126, -4.0), (134, 0.0)])
T_GLANCE = Track([(0, 0.0), (31, 0.0), (37, -0.55), (43, -0.5), (48, 0.0), (72, 0.0),
                  (78, 0.12), (86, 0.0)])


def body_pose(t):
    W = T_WEIGHT(t)
    lean = T_LEAN(t)
    turn = T_TURN(t)
    br = T_BREATH(t)
    hip_yaw = 1.2 * W - 0.25 * turn
    sp_yaw = turn - hip_yaw
    p = dict(STAND)
    p = merge(p, {
        "Hips@": (0.024 * W, 0.003 * lean, -0.0015 - 0.005 * W * W),
        "Hips": (0.25 * lean, -2.2 * W, hip_yaw),
        "Spine": (0.25 * lean + 0.2 * br, 1.3 * W, 0.3 * sp_yaw),
        "Spine1": (0.35 * lean - 0.5 * br, 1.0 * W, 0.35 * sp_yaw),
        "Spine2": (0.4 * lean - 0.7 * br, 0.6 * W, 0.35 * sp_yaw),
    })
    # legs: ankles pinned, knees forward
    p.update(leg_ik(p, 1, ANKLE_L, KNEE_POLE))
    p.update(leg_ik(p, -1, ANKLE_R, Vector((-KNEE_POLE.x, KNEE_POLE.y, KNEE_POLE.z))))
    # head: keep the eyes on the listener, then nod / tilt on top
    target = LISTENER + Vector((T_GLANCE(t), 0.0, 0.0))
    p = look_at(p, target)
    nod, tilt = T_NOD(t), T_TILT(t)
    p = merge(p, {
        "Neck": (0.4 * nod - 0.15 * lean + 0.3 * br, 0.4 * tilt, 0),
        "Head": (0.6 * nod - 0.1 * lean, 0.6 * tilt, 0),
    })
    return p, br


def arm_pose(p, side, t, br):
    tr = ARMS[side]
    pre = "Left" if side > 0 else "Right"
    r2, _ = fk(p, "Spine2")

    def m(v):  # left-convention chest vector -> this side, world
        return r2 @ Vector((v[0] * side, v[1], v[2]))

    sh = tr.sh(t + 2)  # clavicle leads
    sh = (sh[0], sh[1] - 0.8 * br, sh[2])
    shv = tuple(sh) if side > 0 else B._mirror_val("LeftShoulder", tuple(sh))
    q = dict(p)
    q[pre + "Shoulder"] = shv
    s = joint(q, pre + "Arm")
    rel = tr.w(t)
    d = Vector((rel[0] * side, rel[1], rel[2])).normalized() * tr.dist(t)
    wrist = s + r2 @ d
    pole = s + m(tr.pole(t))
    fwd = m(tr.fwd(t - 2))
    palm = m(tr.palm(t - 2))
    out = arm_ik(p, side, wrist, pole, fwd, palm, shoulder=shv, fore_twist=0.5)
    fing = _fingers(tr.op, tr.sp, t, 2.5)
    out.update(fing if side > 0 else mirror(fing))
    return out


def pose_at(t):
    p, br = body_pose(t)
    p = override(p, arm_pose(p, 1, t, br), arm_pose(p, -1, t, br))
    return p


def build(anim):
    for f in range(0, FRAMES + 1, STEP):
        anim.key(f, pose_at(f % FRAMES))
