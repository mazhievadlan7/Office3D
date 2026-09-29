"""Shared machinery for the living-workstation clips (wave 1): curves, hand
targets and the seated base poses they start from and return to.

A hand is described by a Target (wrist position, the hand's forward and palm
directions, the elbow pole, the clavicle value and a finger set) and only
turned into bone values at the very end by arm_ik, from the spine of the key
being built. Targets can be mixed (the wrist follows an arc, the hand turns
by slerp, the fingers blend), so a hand can go from the keyboard to the
mouse, or from the desk up to a gesture, along a path that is authored
rather than whatever a joint-angle crossfade would do (that is what keeps
fingers out of the desk and the monitors).

Base poses: SitType's frame 0 (both hands on the keys) and SitIdle's frame 0
(right hand on the mouse, left wrist on the desk). A clip that leaves them
starts and ends exactly on one of these, so the app's crossfades are always
between near-identical poses.
"""

import math

from mathutils import Matrix, Quaternion, Vector

import _base as B
import rig
from pose import merge, mirror


# =============================================================================
# Curves
# =============================================================================
def _pchip_slopes(ts, ys, period):
    n = len(ts)
    m = []
    for i in range(n):
        if period is None and (i == 0 or i == n - 1):
            m.append(0.0)
            continue
        t0 = ts[i - 1] - (period if i == 0 else 0)
        t2 = ts[(i + 1) % n] + (period if i == n - 1 else 0)
        t1 = ts[i]
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
    """Monotone cubic (PCHIP) through [(frame, value)], value a float, tuple or
    Vector. period=N makes it periodic (frame N is frame 0); period=None clamps
    outside the first/last key and has flat ends. Repeated values hold flat
    (zero slope), so a key pair (a, v), (b, v) is an exact hold."""

    def __init__(self, keys, period=None):
        keys = sorted(keys, key=lambda k: k[0])
        uniq = []
        for k in keys:  # a repeated frame keeps its last value
            if uniq and abs(uniq[-1][0] - k[0]) < 1e-9:
                uniq[-1] = k
            else:
                uniq.append(k)
        keys = uniq
        self.period = period
        self.ts = [float(k[0]) for k in keys]
        v0 = keys[0][1]
        self.scalar = not isinstance(v0, (tuple, list, Vector))
        vals = [(k[1],) if self.scalar else tuple(k[1]) for k in keys]
        self.dim = len(vals[0])
        self.ys = [[float(v[c]) for v in vals] for c in range(self.dim)]
        self.ms = [_pchip_slopes(self.ts, ys, period) for ys in self.ys]

    def __call__(self, t):
        ts = self.ts
        n = len(ts)
        if n == 1:
            out = [y[0] for y in self.ys]
            return out[0] if self.scalar else Vector(out)
        P = self.period
        if P is None:
            if t <= ts[0]:
                out = [y[0] for y in self.ys]
                return out[0] if self.scalar else Vector(out)
            if t >= ts[-1]:
                out = [y[-1] for y in self.ys]
                return out[0] if self.scalar else Vector(out)
            i = max(k for k in range(n - 1) if ts[k] <= t)
            j, ta, tb = i + 1, ts[i], ts[i + 1]
        else:
            t = t % P
            if t < ts[0] or t >= ts[-1]:
                i, j = n - 1, 0
                ta, tb = ts[-1], ts[0] + P
                if t < ts[0]:
                    t += P
            else:
                i = max(k for k in range(n) if ts[k] <= t)
                j, ta, tb = i + 1, ts[i], ts[i + 1]
        h = tb - ta
        s = (t - ta) / h
        h00 = 2 * s ** 3 - 3 * s ** 2 + 1
        h10 = s ** 3 - 2 * s ** 2 + s
        h01 = -2 * s ** 3 + 3 * s ** 2
        h11 = s ** 3 - s ** 2
        out = [h00 * self.ys[c][i] + h10 * h * self.ms[c][i] + h01 * self.ys[c][j] + h11 * h * self.ms[c][j]
               for c in range(self.dim)]
        return out[0] if self.scalar else Vector(out)

    def frames(self):
        return [int(round(t)) for t in self.ts]


def ease(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def pulse(f, a, b, ramp):
    """0 outside [a, b], 1 inside, eased ramps of `ramp` frames at both ends."""
    if f <= a or f >= b:
        return 0.0
    return min(ease((f - a) / ramp), ease((b - f) / ramp))


def tap(dt):
    """Key tap profile around the key-down frame (dt = 0): -1 = finger fully
    lifted, +1 = fully pressed (sit_type._tap)."""
    if dt <= -5 or dt >= 5:
        return 0.0
    if dt <= -2:
        return -ease((dt + 5) / 3)
    if dt <= 0:
        return -1 + 2 * ease((dt + 2) / 2)
    if dt <= 2:
        return 1 - 1.12 * ease(dt / 2)
    return -0.12 * (1 - ease((dt - 2) / 3))


def lerp_pose(a, b, t):
    """Component-wise blend of two value dicts (small differences only)."""
    out = {}
    for k in set(a) | set(b):
        va = tuple(a.get(k, (0, 0, 0)))
        vb = tuple(b.get(k, (0, 0, 0)))
        n = max(len(va), len(vb))
        va += (0,) * (n - len(va))
        vb += (0,) * (n - len(vb))
        out[k] = tuple(x * (1 - t) + y * t for x, y in zip(va, vb))
    return out


# =============================================================================
# Finger sets (left-authored; mirror() gives the right hand)
# =============================================================================
TYPE_F = B._TYPE_FINGERS_L
MOUSE_F = B._MOUSE_FINGERS_L
THIGH_F = B._THIGH_FINGERS_L
DESK_F = merge({
    "LeftHandIndex1": (-2, 20, 0),
    "LeftHandIndex2": (0, 26, 0),
    "LeftHandMiddle1": (0, 22, 0),
    "LeftHandMiddle2": (0, 28, 0),
    "LeftHandRing1": (2, 25, 0),
    "LeftHandRing2": (0, 29, 0),
    "LeftHandPinky1": (4, 27, 0),
    "LeftHandPinky2": (0, 29, 0),
}, B.left_thumb(0.55, 0.6, 0.4, 12))
# Relaxed, half open (a hand in the air while talking).
SOFT_F = merge({
    "LeftHandIndex1": (-3, 10, 0),
    "LeftHandIndex2": (0, 14, 0),
    "LeftHandMiddle1": (-1, 14, 0),
    "LeftHandMiddle2": (0, 18, 0),
    "LeftHandRing1": (2, 18, 0),
    "LeftHandRing2": (0, 22, 0),
    "LeftHandPinky1": (5, 22, 0),
    "LeftHandPinky2": (0, 26, 0),
}, B.left_thumb(0.55, 0.75, 0.2, 8))
# Open, fingers loosely together, palm flat (explaining, showing).
OPEN_F = merge({
    "LeftHandIndex1": (-4, 4, 0),
    "LeftHandIndex2": (0, 7, 0),
    "LeftHandMiddle1": (-1, 7, 0),
    "LeftHandMiddle2": (0, 10, 0),
    "LeftHandRing1": (2, 10, 0),
    "LeftHandRing2": (0, 13, 0),
    "LeftHandPinky1": (5, 13, 0),
    "LeftHandPinky2": (0, 16, 0),
}, B.left_thumb(0.55, 0.75, 0.15, 8))
# Pointing: index straight, the rest curled, thumb over the middle finger.
POINT_F = merge({
    "LeftHandIndex1": (-2, 2, 0),
    "LeftHandIndex2": (0, 3, 0),
    "LeftHandMiddle1": (0, 62, 0),
    "LeftHandMiddle2": (0, 78, 0),
    "LeftHandRing1": (2, 68, 0),
    "LeftHandRing2": (0, 80, 0),
    "LeftHandPinky1": (4, 72, 0),
    "LeftHandPinky2": (0, 78, 0),
}, B.left_thumb(0.5, 0.9, 0.55, 30))
# Fist, loosely closed (resting a cheek or the chin on it).
FIST_F = merge({
    "LeftHandIndex1": (-2, 55, 0),
    "LeftHandIndex2": (0, 70, 0),
    "LeftHandMiddle1": (0, 60, 0),
    "LeftHandMiddle2": (0, 74, 0),
    "LeftHandRing1": (2, 64, 0),
    "LeftHandRing2": (0, 76, 0),
    "LeftHandPinky1": (4, 66, 0),
    "LeftHandPinky2": (0, 74, 0),
}, B.left_thumb(0.6, 0.75, 0.5, 30))
# Interlaced behind the head / clasped: fingers curled round the other hand.
CLASP_F = merge({
    "LeftHandIndex1": (-3, 38, 0),
    "LeftHandIndex2": (0, 42, 0),
    "LeftHandMiddle1": (-1, 42, 0),
    "LeftHandMiddle2": (0, 46, 0),
    "LeftHandRing1": (1, 44, 0),
    "LeftHandRing2": (0, 48, 0),
    "LeftHandPinky1": (4, 46, 0),
    "LeftHandPinky2": (0, 50, 0),
}, B.left_thumb(0.7, 0.55, 0.35, 16))


def fingers(fset, side):
    return dict(fset) if side > 0 else mirror(fset)


# =============================================================================
# Hand targets
# =============================================================================
def _norm(v):
    return Vector(v).normalized()


def frame_quat(fwd, palm):
    f = _norm(fwd)
    n = Vector(palm)
    n = (n - f * n.dot(f)).normalized()
    return Matrix((f, n.cross(f), n)).transposed().to_quaternion()


class Tgt:
    """One hand: wrist (world), hand forward and palm normal (world), pole
    offset from the shoulder joint (world), clavicle value (left-authored)
    and fingers (left-authored)."""

    __slots__ = ("w", "fwd", "palm", "pole", "sh", "fing")

    def __init__(self, w, fwd, palm, pole, sh, fing):
        self.w = Vector(w)
        self.fwd = _norm(fwd)
        self.palm = Vector(palm)
        self.pole = Vector(pole)
        self.sh = tuple(sh)
        self.fing = fing

    def moved(self, dw=(0, 0, 0)):
        return Tgt(self.w + Vector(dw), self.fwd, self.palm, self.pole, self.sh, self.fing)

    def turned(self, q):
        """Orientation rotated by quaternion q (world)."""
        return Tgt(self.w, q @ self.fwd, q @ self.palm, self.pole, self.sh, self.fing)


def mix(a, b, s, lift=(0, 0, 0), s_rot=None, s_fing=None):
    """Target between a (s=0) and b (s=1): the wrist on a quadratic arc bulging
    by `lift` at mid-way, the hand turning by slerp (at s_rot), the fingers
    blending (at s_fing)."""
    s_rot = s if s_rot is None else s_rot
    s_fing = s if s_fing is None else s_fing
    if s <= 0 and s_rot <= 0 and s_fing <= 0:
        return a
    if s >= 1 and s_rot >= 1 and s_fing >= 1:
        return b
    w = a.w.lerp(b.w, s) + Vector(lift) * (4 * s * (1 - s))
    qa, qb = frame_quat(a.fwd, a.palm), frame_quat(b.fwd, b.palm)
    q = qa.slerp(qb, min(max(s_rot, 0.0), 1.0))
    fwd, palm = q @ Vector((1, 0, 0)), q @ Vector((0, 0, 1))
    pole = a.pole.lerp(b.pole, s)
    sh = tuple(x * (1 - s) + y * s for x, y in zip(a.sh, b.sh))
    fing = lerp_pose(a.fing, b.fing, min(max(s_fing, 0.0), 1.0))
    return Tgt(w, fwd, palm, pole, sh, fing)


class Path:
    """A hand through keyed targets [(frame, Tgt | fn(p, f) -> Tgt)]: the wrist,
    pole and clavicle on PCHIP curves through the keys (repeat a key to hold),
    the hand turning by eased slerp and the fingers blending from key to key.
    Callable keys are evaluated on the current pose, so a key can be a hand on
    the keyboard or on the brow that follows the body. rot_lag / fing_lag
    (frames) let the hand orientation and the fingers trail the wrist."""

    def __init__(self, keys, period=None, rot_lag=0.0, fing_lag=0.0):
        self.keys = sorted(keys, key=lambda k: k[0])
        self.period = period
        self.rot_lag = rot_lag
        self.fing_lag = fing_lag

    def _seg(self, f):
        ts = [k[0] for k in self.keys]
        n = len(ts)
        if self.period is not None:
            f = f % self.period
            if f < ts[0] or f >= ts[-1]:
                t0, t1 = ts[-1], ts[0] + self.period
                ff = f + self.period if f < ts[0] else f
                return n - 1, 0, ease((ff - t0) / (t1 - t0))
        if f <= ts[0]:
            return 0, 0, 0.0
        if f >= ts[-1]:
            return n - 1, n - 1, 0.0
        i = max(k for k in range(n - 1) if ts[k] <= f)
        return i, i + 1, ease((f - ts[i]) / (ts[i + 1] - ts[i]))

    def __call__(self, p, f):
        tg = [k(p, f) if callable(k) else k for _, k in self.keys]
        fr = [k[0] for k in self.keys]
        w = Track(list(zip(fr, [g.w for g in tg])), self.period)(f)
        pole = Track(list(zip(fr, [g.pole for g in tg])), self.period)(f)
        sh = tuple(Track(list(zip(fr, [g.sh for g in tg])), self.period)(f))
        i, j, s = self._seg(f - self.rot_lag)
        q = frame_quat(tg[i].fwd, tg[i].palm).slerp(frame_quat(tg[j].fwd, tg[j].palm), s)
        i, j, s = self._seg(f - self.fing_lag)
        fing = lerp_pose(tg[i].fing, tg[j].fing, s)
        return Tgt(w, q @ Vector((1, 0, 0)), q @ Vector((0, 0, 1)), pole, sh, fing)


def solve(p, side, t, fore_twist=0.35):
    """Bone values (arm, hand, fingers) for target t, solved on pose p's spine."""
    pre = "Left" if side > 0 else "Right"
    shv = t.sh if side > 0 else B._mirror_val("LeftShoulder", t.sh)
    q = dict(p)
    q[pre + "Shoulder"] = shv
    s = B.joint(q, pre + "Arm")
    out = B.arm_ik(q, side, t.w, pole=s + t.pole, hand_fwd=t.fwd, palm=t.palm, shoulder=shv,
                   fore_twist=fore_twist)
    out.update(fingers(t.fing, side))
    return out


def shoulder_joint(p, side, sh_left):
    pre = "Left" if side > 0 else "Right"
    q = dict(p)
    q[pre + "Shoulder"] = sh_left if side > 0 else B._mirror_val("LeftShoulder", sh_left)
    return B.joint(q, pre + "Arm")


# --- the hand sources the seated clips share -------------------------------------
def type_tgt(side, dw=(0, 0, 0), pitch=0.0, sh=(0.0, 0.0, 0.0), fing=None):
    """Hand on the keyboard (sit_type._arm): wrist offset dw, hand yaw from the
    lateral reach, pitch lifts the fingers, sh adds to the clavicle."""
    dw = Vector(dw)
    wrist = Vector((B.TYPE_WRIST.x * side, B.TYPE_WRIST.y, B.TYPE_WRIST.z)) + dw
    fwd = Vector((B.TYPE_HAND_FWD.x * side, B.TYPE_HAND_FWD.y, B.TYPE_HAND_FWD.z)).normalized()
    palm = Vector((B.TYPE_PALM.x * side, B.TYPE_PALM.y, B.TYPE_PALM.z)).normalized()
    if pitch:
        q = Quaternion(palm.cross(fwd).normalized(), math.radians(pitch))
        fwd, palm = q @ fwd, q @ palm
    yaw = 200.0 * dw.x
    if yaw:
        q = Quaternion((0, 0, 1), math.radians(yaw))
        fwd, palm = q @ fwd, q @ palm
    shv = tuple(a + b for a, b in zip(B.TYPE_SHOULDER, sh))
    return Tgt(wrist, fwd, palm, (0.22 * side, 0.02, -0.5), shv, fing if fing is not None else TYPE_F)


def mouse_tgt(dx=0.0, dy=0.0, sh=(0.0, 0.0, 0.0), fing=None):
    """Right hand on the mouse (sit_idle.mouse_solve): small cursor moves are a
    yaw of the hand over the mouse plus a few millimetres of travel."""
    q = Quaternion(Vector((0, 0, 1)), math.radians(dx * 200.0))
    pivot = B.MOUSE_WRIST + B.MOUSE_HAND_FWD.normalized() * 0.045
    wrist = pivot + q @ (B.MOUSE_WRIST - pivot) + Vector((0.35 * dx, dy, 0.0))
    shv = tuple(a + b for a, b in zip((0, 1, -3), sh))
    return Tgt(wrist, q @ B.MOUSE_HAND_FWD, q @ B.MOUSE_PALM, (-0.25, 0.05, -0.5), shv,
               fing if fing is not None else MOUSE_F)


# Left wrist resting on the desk left of the keyboard (sit_idle.DESK_WRIST).
DESK_WRIST = Vector((0.32, -0.40, 0.797))
DESK_FWD = Vector((-0.26, -0.96, 0.03))
DESK_PALM = Vector((-0.45, 0.0, -1.0))
DESK_POLE = Vector((0.30, 0.02, -0.5))


def desk_tgt(dw=(0, 0, 0), sh=(0.0, 0.0, 0.0), fing=None):
    shv = tuple(a + b for a, b in zip((0, 2, -3), sh))
    return Tgt(DESK_WRIST + Vector(dw), DESK_FWD, DESK_PALM, DESK_POLE, shv, fing if fing is not None else DESK_F)


def thigh_tgt(side, dw=(0, 0, 0), sh=(0, 2, 0)):
    return Tgt(Vector((B.THIGH_WRIST.x * side, B.THIGH_WRIST.y, B.THIGH_WRIST.z)) + Vector(dw),
               (-0.55 * side, -0.8, -0.2), (-0.2 * side, 0.05, -1.0), (0.22 * side, 0.2, -0.4), sh, THIGH_F)


def contact_tgt(p, side, tip_bone, target, fwd, palm, pole, sh, fing):
    """Target whose fingertip (tail of `tip_bone`, left-named) lands on `target`
    (world) with the hand along fwd/palm: solve once at a guess to measure the
    wrist-to-tip offset for this orientation and curl, then place the wrist."""
    pre = "Left" if side > 0 else "Right"
    bone = pre + tip_bone[4:] if tip_bone.startswith("Left") else tip_bone
    t0 = Tgt(Vector(target) - _norm(fwd) * 0.12, fwd, palm, pole, sh, fing)
    q = dict(p)
    q.update(solve(p, side, t0))
    off = B.point(q, bone, rig.tail_of(bone)) - B.joint(q, pre + "Hand")
    return Tgt(Vector(target) - off, fwd, palm, pole, sh, fing)


def head_space(p, v):
    """Head-bone REST-space point (the head faces -Y there) to world, pose p."""
    r, t = B.fk(p, "Head")
    return r @ Vector(v) + t


def head_dir(p, v):
    r, _ = B.fk(p, "Head")
    return r @ Vector(v)


def chest_frame(p):
    """(R, t) of the Spine2 bone: chest space for gestures that ride the torso."""
    return B.fk(p, "Spine2")


def seated(spine_add, legs=True):
    """SIT_SPINE plus additive spine values, legs solved."""
    p = merge(B.SIT_SPINE, spine_add)
    if legs:
        p.update(B.sit_legs(p))
    return p


# =============================================================================
# Base poses (evaluated lazily: the clip modules import each other)
# =============================================================================
_BASE = {}


def base_type():
    """SitType frame 0 (both hands on the keys)."""
    if "type" not in _BASE:
        import sit_type
        _BASE["type"] = sit_type.pose_at(0)
    return _BASE["type"]


def base_idle():
    """SitIdle frame 0 (right hand on the mouse, left wrist on the desk)."""
    if "idle" not in _BASE:
        import sit_idle
        _BASE["idle"] = sit_idle.pose_at(0)
    return _BASE["idle"]


def key_frames(n, step=2, extra=(), dense=()):
    """Every `step` frames, plus extra frames, plus every frame inside the
    (a, b) ranges in `dense`; always 0 and n."""
    ks = set(range(0, n + 1, step))
    ks.update(int(round(f)) % (n + 1) for f in extra)
    for a, b in dense:
        ks.update(range(max(0, a), min(n, b) + 1))
    ks.add(0)
    ks.add(n)
    return sorted(k for k in ks if 0 <= k <= n)
