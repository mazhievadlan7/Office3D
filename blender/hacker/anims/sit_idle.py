"""Seated idle at the workstation, working with the mouse (150 frames, cyclic).

Story (30 fps):
  0-20    eyes/head go to the LEFT monitor, the mouse follows (+x ~1.2 cm)
  28      click 1 (index finger)
  38-48   back to the centre monitor; the torso starts to sit back
  38-55   left hand leaves the desk and comes up to the chin
  55-77   leaning back, thinking: two slow strokes along the chin
  77-95   the left hand goes back down to the desk; the torso comes forward
  80-92   head to the RIGHT monitor, the mouse follows (-x ~1.2 cm)
  104     click 2
  114-125 back to the centre monitor, everything settles to frame 0

Built on _base.SIT. Every key re-solves the legs (feet planted), the gaze
(look_at), the mouse arm and the left arm against that key's own spine, so the
hands stay exactly where they are meant to be while the torso breathes, sways
and leans. The channels are smooth periodic curves sampled at the key frames.
"""

import math

from mathutils import Matrix, Quaternion, Vector

import _base
import rig
from _base import (
    MOUSE_HAND_FWD, MOUSE_PALM, MOUSE_WRIST, SIT_SPINE, _MOUSE_FINGERS_L,
    arm_ik, fk, joint, left_thumb, look_at, override, point, sit_legs,
)
from pose import merge, mirror

NAME = "SitIdle"
FRAMES = 150
CYCLIC = True

CLICKS = (28, 104)


# --- periodic curves ----------------------------------------------------------
class Curve:
    """Periodic monotone cubic through (frame, value) points (auto-clamped:
    zero slope at holds and extremes, no overshoot beyond the authored
    values; overshoots are authored explicitly)."""

    def __init__(self, pts, period=FRAMES):
        pts = sorted(pts)
        self.period = period
        self.const = pts[0][1] if len(pts) == 1 else None
        n = len(pts)
        ext = [(f - period, v) for f, v in pts[-2:]] + pts + [(f + period, v) for f, v in pts[:2]]
        self.pts = ext
        m = [0.0] * len(ext)
        for k in range(1, len(ext) - 1):
            (t0, v0), (t1, v1), (t2, v2) = ext[k - 1], ext[k], ext[k + 1]
            d0 = (v1 - v0) / (t1 - t0)
            d1 = (v2 - v1) / (t2 - t1)
            if d0 * d1 <= 0:
                m[k] = 0.0
            else:
                mk = (v2 - v0) / (t2 - t0)
                lim = 3 * min(abs(d0), abs(d1))
                m[k] = math.copysign(min(abs(mk), lim), mk)
        self.m = m
        self.n = n

    def __call__(self, t):
        if self.const is not None:
            return self.const
        t = t % self.period
        e = self.pts
        k = 0
        while not (e[k][0] <= t < e[k + 1][0]):
            k += 1
        (t0, v0), (t1, v1) = e[k], e[k + 1]
        h = t1 - t0
        s = (t - t0) / h
        h00 = 2 * s ** 3 - 3 * s ** 2 + 1
        h10 = s ** 3 - 2 * s ** 2 + s
        h01 = -2 * s ** 3 + 3 * s ** 2
        h11 = s ** 3 - s ** 2
        return h00 * v0 + h10 * h * self.m[k] + h01 * v1 + h11 * h * self.m[k + 1]

    def frames(self):
        return [f for f, _ in self.pts[2:-2]]


# --- channels -----------------------------------------------------------------
# Gaze target on the monitor plane (y = -0.95): x (+ = character's left), z.
# Side monitors are centred at x = +-0.58; the head undershoots a little, the
# rest would be done by the eyes.
GAZE_X = Curve([
    (0, 0.0), (6, 0.012),
    (15, 0.535), (19, 0.51), (26, 0.5), (34, 0.485), (38, 0.48),   # left monitor
    (47, -0.012), (51, 0.004), (62, 0.03), (72, -0.01),             # centre, thinking
    (80, -0.025), (89, -0.54), (93, -0.515), (104, -0.5), (112, -0.49),  # right monitor
    (122, 0.012), (127, -0.004), (140, 0.008),
])
GAZE_Z = Curve([
    (0, 1.08), (15, 1.125), (26, 1.105), (36, 1.06), (47, 1.095), (60, 1.13),
    (72, 1.12), (89, 1.07), (104, 1.03), (112, 1.04), (123, 1.085), (140, 1.075),
])

# Torso lean in degrees on top of SIT (+ = further forward, - = sit back).
LEAN = Curve([
    (0, 0.0), (12, 0.25), (30, 0.3), (38, -0.2), (48, -2.8), (58, -4.2), (70, -4.5),
    (79, -3.9), (88, -1.8), (98, 1.3), (107, 2.3), (115, 2.4), (127, 1.1), (140, 0.25),
])
# One slow breath per loop: inhale while sitting back, long exhale after.
BREATH = Curve([(40, -1.0), (76, 1.0)])

# Mouse (right wrist) offset in metres: +x = character's left.
MOUSE_DX = Curve([
    (0, 0.0), (7, 0.0), (13, 0.0075), (18, 0.0122), (21, 0.0127), (23, 0.0112),
    (26, 0.0114), (35, 0.011), (40, 0.0092), (46, 0.0022), (49, 0.0016), (60, 0.0022),
    (64, 0.0042), (68, 0.0036), (81, 0.003), (85, -0.0005), (90, -0.0104), (93, -0.0124),
    (96, -0.0111), (99, -0.0119), (110, -0.0114), (116, -0.0088), (124, -0.0018),
    (130, 0.0006), (140, 0.0),
])
MOUSE_DY = Curve([
    (0, 0.0), (7, 0.0), (18, 0.0028), (35, 0.0026), (46, -0.0008), (64, 0.001),
    (81, 0.0), (93, -0.0036), (110, -0.0038), (124, 0.0), (140, 0.0),
])


def _click(c, lift=-6.0, press=6.0):
    return [(c - 6, 0.0), (c - 3, lift), (c, press), (c + 2, press * 0.8), (c + 5, -1.5), (c + 8, 0.0)]


# Index finger curl offset (left-authored, degrees, + = press down).
CLICK = Curve(sum((_click(c) for c in CLICKS), []))

# Left hand: 0 = resting on the desk, 1 = at the chin.
CHIN = Curve([
    (0, 0.0), (38, 0.0), (45, 0.42), (51, 0.9), (55, 1.0),
    (77, 1.0), (81, 0.9), (87, 0.42), (93, 0.03), (96, 0.0),
])
# Chin strokes: the fingertip slides down along the chin (metres, + = down) and
# the fingers close a little on the down stroke.
RUB = Curve([(0, 0.0), (55, 0.0), (59, -0.004), (64, 0.006), (69, -0.003), (74, 0.006), (78, 0.0)])
RUB_CURL = Curve([(0, 0.0), (55, 0.0), (59, -4.0), (64, 6.0), (69, -3.0), (74, 6.0), (78, 0.0)])

# Slow finger life (degrees, left-authored curl).
DRIFT_A = Curve([(0, 0.0), (37, 1.6), (75, -0.8), (112, 1.2)])
DRIFT_B = Curve([(0, 0.0), (25, -1.2), (70, 1.4), (118, -0.6)])


# --- fixed hand shapes (left-authored) ------------------------------------------
_DESK_FINGERS_L = merge({
    "LeftHandIndex1": (-2, 20, 0),
    "LeftHandIndex2": (0, 26, 0),
    "LeftHandMiddle1": (0, 22, 0),
    "LeftHandMiddle2": (0, 28, 0),
    "LeftHandRing1": (2, 25, 0),
    "LeftHandRing2": (0, 29, 0),
    "LeftHandPinky1": (4, 27, 0),
    "LeftHandPinky2": (0, 29, 0),
}, left_thumb(0.55, 0.6, 0.4, 12))

_CHIN_FINGERS_L = merge({
    "LeftHandIndex1": (-4, 30, 0),
    "LeftHandIndex2": (0, 38, 0),
    "LeftHandMiddle1": (-1, 36, 0),
    "LeftHandMiddle2": (0, 40, 0),
    "LeftHandRing1": (2, 55, 0),
    "LeftHandRing2": (0, 50, 0),
    "LeftHandPinky1": (5, 62, 0),
    "LeftHandPinky2": (0, 55, 0),
}, left_thumb(0.55, 0.95, 0.15, 6))

# Left wrist resting on the desk left of the keyboard (sleeve cuff on the desk).
DESK_WRIST = Vector((0.32, -0.40, 0.797))
DESK_FWD = Vector((-0.26, -0.96, 0.03))
DESK_PALM = Vector((-0.45, 0.0, -1.0))  # semi-pronated: thumb side up

# Chin: the tips of the curled middle/index fingers rest on the chin front, the
# hand tilted back in front of it (the hoodie chest is further forward than the
# robot's chin, so the wrist has to stay well in front of the collar).
# Everything in the Head bone's REST space (the head faces -Y there); the wrist
# is solved from the contact, so the fingertip stays on the chin while the head
# moves and the hand strokes.
CHIN_CONTACT = Vector((0.015, -0.078, 1.598))
CHIN_NORMAL = Vector((0.1, -0.85, -0.5)).normalized()
CHIN_STROKE = Vector((0.0, 0.456, -0.89))  # down along the chin surface
CHIN_PALM = Vector((-0.05, 0.87, -0.45))
CHIN_FWD = Vector((-0.2, 0.45, 0.87))
CONTACT_BONE = "LeftHandMiddle2"
PAD = 0.006  # fingertip cap: the bone tail sits this far off the surface


def _lerp_pose(a, b, t):
    out = {}
    for k in set(a) | set(b):
        va = tuple(a.get(k, (0, 0, 0))) + (0,) * (4 - len(a.get(k, (0, 0, 0))))
        vb = tuple(b.get(k, (0, 0, 0))) + (0,) * (4 - len(b.get(k, (0, 0, 0))))
        out[k] = tuple(x * (1 - t) + y * t for x, y in zip(va, vb))
    return out


def _frame_quat(fwd, palm):
    f = Vector(fwd).normalized()
    n = Vector(palm)
    n = (n - f * n.dot(f)).normalized()
    m = Matrix((f, n.cross(f), n)).transposed()
    return m.to_quaternion()


def _bezier(p0, p1, p2, p3, s):
    u = 1 - s
    return p0 * u ** 3 + p1 * 3 * u * u * s + p2 * 3 * u * s * s + p3 * s ** 3


# --- pose assembly --------------------------------------------------------------
def spine_at(f):
    lean = LEAN(f)
    br = BREATH(f)
    br2 = BREATH(f - 5)  # upper chest and shoulders trail the diaphragm
    # Chest follows the gaze a little, a few frames late (follow-through).
    yaw = math.degrees(math.atan2(GAZE_X(f - 5), 0.95)) * 0.11
    return merge(SIT_SPINE, {
        "Hips@": (0.0, -0.0014 * lean, 0.0),
        "Hips": (0.45 * lean, 0, 0.15 * yaw),
        "Spine": (0.2 * lean + 0.25 * br, 0, 0.25 * yaw),
        "Spine1": (0.18 * lean - 0.5 * br, 0, 0.3 * yaw),
        "Spine2": (0.17 * lean - 0.7 * br2, 0, 0.3 * yaw),
    }), br2


def gaze_at(f):
    return Vector((GAZE_X(f), -0.95, GAZE_Z(f)))


def head_solve(p, f):
    # The neck leads the head by ~2 frames; the head finishes the aim.
    lead = look_at(p, gaze_at(f + 2))
    p = dict(p)
    p["Neck"] = lead["Neck"]
    p = look_at(p, gaze_at(f), neck_share=0.0)
    # Arcs: the head dips slightly mid-turn and rolls a touch into the turn.
    speed = (GAZE_X(f + 1) - GAZE_X(f - 1)) * 0.5  # m/frame on the monitor
    yaw = math.degrees(math.atan2(GAZE_X(f), 0.95))
    dip = min(abs(speed) * 60.0, 2.5)
    p = merge(p, {"Head": (dip, 0.07 * yaw, 0), "Neck": (0, 0.04 * yaw, 0)})
    return p


def mouse_solve(p, f, br2):
    dx, dy = MOUSE_DX(f), MOUSE_DY(f)
    # Small cursor moves: mostly a yaw of the hand about the palm (over the
    # mouse), plus a few millimetres of travel.
    q = Quaternion(Vector((0, 0, 1)), math.radians(dx * 200.0))
    pivot = MOUSE_WRIST + MOUSE_HAND_FWD.normalized() * 0.045
    wrist = pivot + q @ (MOUSE_WRIST - pivot) + Vector((0.35 * dx, dy, 0.0))
    s = joint(p, "RightArm")
    out = arm_ik(
        p, -1, wrist,
        pole=s + Vector((-0.25, 0.05, -0.5)),
        hand_fwd=q @ MOUSE_HAND_FWD,
        palm=q @ MOUSE_PALM,
        shoulder=_base._mirror_val("LeftShoulder", (0, 1 - 0.6 * br2, -3)),
    )
    c = CLICK(f)
    a, b = DRIFT_A(f), DRIFT_B(f)
    fingers = merge(_MOUSE_FINGERS_L, {
        "LeftHandIndex1": (0, c, 0),
        "LeftHandIndex2": (0, 0.4 * c, 0),
        "LeftHandMiddle1": (0, 0.15 * c + 0.4 * a, 0),
        # Moving left, ring and pinky ride up the side of the mouse.
        "LeftHandRing1": (0, 0.8 * b - 250 * max(dx, 0.0), 0),
        "LeftHandPinky1": (0, 1.0 * b + 0.5 * a - 400 * max(dx, 0.0), 0),
        "LeftHandPinky2": (0, -150 * max(dx, 0.0), 0),
    })
    out.update(mirror(fingers))
    return out


def _left_fingers(f, s_fin):
    fing = _lerp_pose(_DESK_FINGERS_L, _CHIN_FINGERS_L, s_fin)
    rc = RUB_CURL(f) * s_fin
    a, b = DRIFT_A(f + 40), DRIFT_B(f + 20)
    return merge(fing, {
        "LeftHandIndex1": (0, 0.6 * rc + a, 0),
        "LeftHandMiddle1": (0, rc + 0.6 * b, 0),
        "LeftHandMiddle2": (0, 0.5 * rc, 0),
        "LeftHandRing1": (0, 0.8 * rc + b, 0),
        "LeftHandPinky1": (0, 0.6 * rc - 0.8 * a, 0),
    })


def _chin_wrist(p, f, shoulder):
    """World wrist/fwd/palm that put the contact fingertip on the chin."""
    rh, th = fk(p, "Head")
    contact = CHIN_CONTACT + CHIN_STROKE * RUB(f)
    target = rh @ (contact + CHIN_NORMAL * PAD) + th
    fwd, palm = rh @ CHIN_FWD, rh @ CHIN_PALM
    # Fingertip offset from the wrist for this hand orientation and curl
    # (independent of where the wrist is): solve once, then place the wrist.
    sh = joint(p, "LeftArm")
    guess = target - fwd.normalized() * 0.12
    q = dict(p)
    q.update(arm_ik(p, 1, guess, pole=sh + CHIN_POLE, hand_fwd=fwd, palm=palm, shoulder=shoulder))
    q.update(_left_fingers(f, 1.0))
    off = point(q, CONTACT_BONE, rig.tail_of(CONTACT_BONE)) - joint(q, "LeftHand")
    return target - off, fwd, palm


DESK_POLE = Vector((0.30, 0.02, -0.5))
CHIN_POLE = Vector((0.24, -0.34, -0.42))


def left_solve(p, f, br2):
    s_pos = CHIN(f)
    going_up = 30 <= (f % FRAMES) < 66
    # Going up the hand orientation trails the wrist (drag) and the fingers
    # trail the hand; coming down the hand turns palm-down early.
    s_rot = CHIN(f - 2.5) if going_up else CHIN(f + 2)
    s_fin = CHIN(f - 4) if going_up else CHIN(f + 1)
    shoulder = (0, 2 - 5 * s_pos - 0.6 * br2, -3 - 3 * s_pos)

    chin_w, chin_fwd, chin_palm = _chin_wrist(p, f, shoulder)
    if going_up:
        c1 = DESK_WRIST + Vector((0.0, 0.03, 0.15))
        c2 = chin_w + Vector((0.08, -0.1, -0.12))
    else:
        c1 = DESK_WRIST + Vector((0.04, -0.03, 0.13))
        c2 = chin_w + Vector((0.1, -0.08, -0.1))
    wrist = _bezier(DESK_WRIST, c1, c2, chin_w, s_pos)

    q0 = _frame_quat(DESK_FWD, DESK_PALM)
    q1 = _frame_quat(chin_fwd, chin_palm)
    q = q0.slerp(q1, s_rot) if s_pos < 0.999 else q1
    # Drag: the hand droops while the forearm rises, lifts while it drops.
    vel = CHIN(f + 1) - CHIN(f - 1)
    lat = q @ Vector((0, 1, 0))
    drag = -vel * (55.0 if going_up else 25.0)
    q = Quaternion(lat, math.radians(max(-14.0, min(14.0, drag)))) @ q
    fwd = q @ Vector((1, 0, 0))
    palm = q @ Vector((0, 0, 1))

    sh = joint(p, "LeftArm")
    pole = sh + DESK_POLE.lerp(CHIN_POLE, s_pos)
    out = arm_ik(p, 1, wrist, pole=pole, hand_fwd=fwd, palm=palm, shoulder=shoulder)
    out.update(_left_fingers(f, s_fin if s_pos < 0.999 else 1.0))
    return out


def pose_at(f):
    spine, br2 = spine_at(f)
    p = dict(spine)
    p.update(sit_legs(p))
    p = head_solve(p, f)
    p = override(p, mouse_solve(p, f, br2))
    p = override(p, left_solve(p, f, br2))
    return p


def key_frames():
    """Keys on the authored waypoints that matter (clicks, hand contacts, head
    turns), at least 2 frames apart, with the gaps filled to <= 6 frames."""
    req = []
    for prio, c in ((0, CLICK), (1, CHIN), (1, RUB), (2, GAZE_X)):
        req += [(int(round(x)) % FRAMES, prio) for x in c.frames()]
    req.sort()
    keys = []
    for fr, prio in req:
        if keys and fr - keys[-1][0] < 2:
            if prio < keys[-1][1]:
                keys[-1] = (fr, prio)
            continue
        keys.append((fr, prio))
    fs = [k[0] for k in keys]
    if fs[0] != 0:
        fs.insert(0, 0)
    fs.append(FRAMES)
    out = []
    for a, b in zip(fs, fs[1:]):
        out.append(a)
        n = math.ceil((b - a) / 6.0)
        for i in range(1, n):
            out.append(round(a + (b - a) * i / n))
    out.append(FRAMES)
    return sorted(set(out))


def build(anim):
    for f in key_frames():
        anim.key(f, pose_at(f))  # curves are periodic: frame FRAMES == frame 0
