"""Standing idle: the weight settles on one leg, then the other; breathing; arms
that hang and swing with follow-through; living fingers; a small head drift.

Built on STAND so crossfades from Walk stay clean: frame 0 is STAND within a
few tenths of a degree (weight centred and passing left, lungs empty, head
forward). Every layer is a periodic curve over the 120-frame loop, so frame
120 is frame 0 and the Cycles modifier gives continuous loop tangents.

Layers (w = weight shift, +1 fully on the LEFT leg):
  pelvis  slides over the stance foot, hitches the stance hip up (roll) and
          lets the free hip come forward (yaw). Its height is solved so the
          straighter knee keeps ~5 deg of flex, dipping a little while the
          weight passes over (knee unlock).
  legs    two-bone IK to the STAND ankles: feet planted, the free knee bends
          and falls inward (which also keeps the free thigh from abducting
          out through the hoodie side).
  spine   counter-roll/yaw with a wave of lag up the chain (contrapposto:
          stance hip up, stance shoulder down); breathing lifts the chest.
  head    gaze stabilisation (cancels most of the trunk motion a few frames
          late) plus an authored drift; the head leads, the neck follows.
  arms    damped pendulums driven by the real motion of the shoulder joints
          (simulated to a periodic steady state); elbow, wrist and fingers
          lag further behind (follow-through).
"""

import math

from mathutils import Vector

from _base import STAND, fk, joint, left_thumb, leg_ik, override
from pose import merge, mirror
import rig

NAME = "Idle"
FRAMES = 120
CYCLIC = True
STEP = 4  # key spacing in frames
FPS = 30.0
SIDES = ((1, "Left"), (-1, "Right"))

# STAND's thumbs sit near the A-pose thumb direction and stick straight out
# forward; a hanging hand rests the thumb along the side of the index finger.
_THUMB_L = left_thumb(0.95, 0.3, 0.15, 12)
BASE = override(STAND, _THUMB_L, mirror(_THUMB_L))


# --- periodic curves ----------------------------------------------------------
def _curve(knots):
    """Periodic C1 curve through (frame, value) knots (Catmull-Rom tangents)."""
    ks = sorted(knots)
    ext = [(f - FRAMES, v) for f, v in ks[-2:]] + ks + [(f + FRAMES, v) for f, v in ks[:2]]

    def ev(t):
        t %= FRAMES
        i = 1
        while not (ext[i][0] <= t < ext[i + 1][0]):
            i += 1
        (fm, vm), (f0, v0), (f1, v1), (f2, v2) = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        span = f1 - f0
        m0 = (v1 - vm) / (f1 - fm) * span
        m1 = (v2 - v0) / (f2 - f0) * span
        s = (t - f0) / span
        s2, s3 = s * s, s * s * s
        return ((2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * m0
                + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * m1)

    return ev


def _sin(t, cycles, phase):
    return math.sin(2 * math.pi * cycles * t / FRAMES + phase)


# Weight: centred and moving left at frame 0, settles on the LEFT leg with a
# small overshoot (~f18), holds, transfers right (f52-f80, quicker), settles
# on the RIGHT leg, holds, and drifts back over frame 120 = 0.
W = _curve([(0, 0.0), (6, 0.45), (12, 0.85), (18, 1.03), (26, 1.0), (40, 0.97), (50, 0.92),
            (56, 0.74), (62, 0.2), (68, -0.45), (74, -0.9), (80, -1.04), (88, -1.0),
            (100, -0.96), (108, -0.84), (114, -0.45)])
# One breath per loop (15/min): inhale ~1.5 s, slower exhale.
B = _curve([(0, 0.0), (10, 0.1), (22, 0.45), (34, 0.82), (44, 1.0), (54, 0.92), (70, 0.6),
            (88, 0.26), (104, 0.06), (114, 0.0)])
# Voluntary head drift (degrees): a small look to the right while on the left
# leg, then a clearer glance left and down while resting on the right leg.
HEAD_YAW = _curve([(0, 0.0), (14, -0.6), (30, -1.6), (46, -1.2), (60, -0.2), (72, 0.3),
                   (78, 1.6), (84, 4.4), (90, 5.4), (100, 5.0), (106, 4.0), (112, 1.8),
                   (117, 0.5)])
HEAD_PITCH = _curve([(0, 0.0), (20, -0.3), (40, 0.4), (60, 0.2), (80, 1.0), (92, 2.0),
                     (104, 1.6), (114, 0.4)])
HEAD_ROLL = _curve([(0, 0.0), (30, -0.8), (55, -0.3), (80, 0.6), (95, 1.4), (110, 0.4)])

# --- pelvis / legs ---------------------------------------------------------------
SHIFT = 0.036  # pelvis slide over the stance foot (m)
ROLL = 2.5  # stance hip hitched up (deg)
YAW = 2.0  # free hip forward (deg)
FLEX_HOLD = 5.0  # knee flex of the straighter leg (deg)
FLEX_DIP = 6.0  # extra flex while the weight passes over
TOE_OUT = {1: 4.0, -1: 6.0}
ANKLE = {s: joint(STAND, p + "Foot") for s, p in SIDES}
_L1 = (rig.tail_of("LeftUpLeg") - rig.head_of("LeftUpLeg")).length
_L2 = (rig.tail_of("LeftLeg") - rig.head_of("LeftLeg")).length
_WSPEED = max(abs(W(i / 4 + 0.5) - W(i / 4 - 0.5)) for i in range(FRAMES * 4))


def _free(side, t):
    """0..1: how unweighted the leg on `side` is."""
    return max(0.0, min(1.0, -W(t) * side))


def _reach(flex_deg):
    return math.sqrt(_L1 * _L1 + _L2 * _L2 + 2 * _L1 * _L2 * math.cos(math.radians(flex_deg)))


def _hips_z(p, flex_deg):
    """Hips@ z that gives the straighter leg exactly `flex_deg` of knee flex."""
    q = dict(p)
    x, y, _ = q["Hips@"]
    q["Hips@"] = (x, y, 0.0)
    r = _reach(flex_deg)
    best = None
    for side, pre in SIDES:
        hip = joint(q, pre + "UpLeg")
        a = ANKLE[side]
        dz = math.sqrt(max(r * r - (hip.x - a.x) ** 2 - (hip.y - a.y) ** 2, 0.0))
        z = a.z + dz - hip.z
        best = z if best is None else min(best, z)
    return best


# --- body (everything but the arms' dynamics and the legs) -------------------------
def _body(t):
    w = W
    b = B
    sway = 0.003 * _sin(t, 1, 2.2) + 0.0012 * _sin(t, 2, 0.7)  # postural fore-aft sway
    p = merge(BASE, {
        "Hips": (0.0, -ROLL * w(t - 1), YAW * w(t - 2)),
        # Counter-roll/yaw travels up the spine a frame at a time; the chest ends
        # ~1 deg toward the stance side (stance shoulder lower). Inhale lifts it.
        "Spine": (-0.2 * b(t), 1.3 * w(t - 3), -0.7 * w(t - 4)),
        "Spine1": (-0.5 * b(t - 1), 1.5 * w(t - 4), -0.6 * w(t - 5)),
        "Spine2": (-0.8 * b(t - 2), 1.2 * w(t - 5), -0.5 * w(t - 6) + 0.12 * HEAD_YAW(t - 7)),
        # Head leads, neck follows; both cancel trunk tilt a few frames late.
        "Neck": (0.6 * b(t - 3) + 0.35 * HEAD_PITCH(t - 2), -0.3 * w(t - 7) + 0.35 * HEAD_ROLL(t - 2),
                 0.35 * HEAD_YAW(t - 2)),
        "Head": (0.7 * b(t - 4) + 0.65 * HEAD_PITCH(t), -0.4 * w(t - 8) + 0.65 * HEAD_ROLL(t),
                 0.65 * HEAD_YAW(t)),
        # Clavicles rise and draw back a little on the inhale.
        "LeftShoulder": (0.0, -1.1 * b(t - 3), 0.7 * b(t - 3)),
        "RightShoulder": (0.0, 1.1 * b(t - 3), -0.7 * b(t - 3)),
    })
    p["Hips@"] = (SHIFT * w(t), sway, 0.0)
    speed = abs(w(t + 2.5) - w(t + 1.5)) / _WSPEED  # the knee unlocks just before the shift
    flex = FLEX_HOLD + FLEX_DIP * (3 * speed * speed - 2 * speed ** 3)
    p["Hips@"] = (SHIFT * w(t), sway, _hips_z(p, flex))
    return p


def _legs(p, t):
    out = {}
    for side, pre in SIDES:
        hip = joint(p, pre + "UpLeg")
        free = _free(side, t)
        # Knees track over the toes; the unweighted knee falls inward (~15 deg).
        pole = hip + Vector((side * (0.08 - 0.34 * free), -1.0, -0.4))
        out.update(leg_ik(p, side, ANKLE[side], pole, TOE_OUT[side]))
        out[pre + "ToeBase"] = (0.0, 0.0, 0.0)
    return out


# --- arms: driven damped pendulums ------------------------------------------------
SUB = 4  # simulation substeps per frame
ARM_L = 0.45  # effective pendulum length (m)
OMEGA = 2 * math.pi / 1.2  # natural frequency with muscle tone (rad/s)
ZETA = 0.45  # damping ratio
GAIN = 0.8  # share of the pure-pendulum response (arms are not limp)
GRAV = 0.5  # share of trunk tilt the hanging arm cancels at equilibrium
ARM_OUT = 0.5  # deg away from the body: keeps the elbows off the hoodie while swaying


def _arm_drift(side, t):
    """Authored slow drift of each arm's equilibrium (deg, world X/Y)."""
    if side > 0:
        return 0.6 * _sin(t, 1, 0.4), 0.4 * _sin(t, 2, 1.3)
    return 0.6 * _sin(t, 1, 2.1), -0.4 * _sin(t, 2, 0.2)


def _simulate():
    """Per side: list over substeps of (theta_x, theta_y, rho_x, rho_y) in deg.
    theta = arm deflection from its STAND direction in world; rho = rotation of
    the Shoulder bone's frame from STAND (what the arm is carried by)."""
    n = FRAMES * SUB
    h = 1.0 / (FPS * SUB)
    rest = {s: fk(STAND, pre + "Shoulder")[0] for s, pre in SIDES}
    pos = {s: [] for s, _ in SIDES}
    rho = {s: [] for s, _ in SIDES}
    for i in range(n):
        p = _body(i / SUB)
        for s, pre in SIDES:
            pos[s].append(joint(p, pre + "Arm"))
            axis, ang = (fk(p, pre + "Shoulder")[0] @ rest[s].inverted()).to_axis_angle()
            rv = axis * math.degrees(ang)
            rho[s].append((rv.x, rv.y))
    out = {}
    for s, _ in SIDES:
        acc = [(pos[s][(i + 1) % n] - 2 * pos[s][i] + pos[s][i - 1]) / (h * h) for i in range(n)]
        eq = []
        for i in range(n):
            dx, dy = _arm_drift(s, i / SUB)
            eq.append(((1 - GRAV) * rho[s][i][0] + dx, (1 - GRAV) * rho[s][i][1] + dy))
        thx, thy = eq[0]
        vx = vy = 0.0
        rec = [None] * n
        for loop in range(5):  # settle into the periodic steady state
            for i in range(n):
                if loop == 4:
                    rec[i] = (thx, thy, rho[s][i][0], rho[s][i][1])
                fx = OMEGA ** 2 * (eq[i][0] - thx) - 2 * ZETA * OMEGA * vx - GAIN * math.degrees(acc[i].y / ARM_L)
                fy = OMEGA ** 2 * (eq[i][1] - thy) - 2 * ZETA * OMEGA * vy + GAIN * math.degrees(acc[i].x / ARM_L)
                vx += fx * h
                vy += fy * h
                thx += vx * h
                thy += vy * h
        out[s] = rec
    return out


def _fingers_left(t, ph, flop):
    """Left-hand finger offsets: a slow curl wave index -> pinky, a faster
    flicker, and `flop(t)` (deg) from the hand's own motion."""
    out = {}
    for i, fn in enumerate(("Index", "Middle", "Ring", "Pinky")):
        lag = 3 * i

        def curl(tt):
            return (2.2 * _sin(tt - lag, 1, ph) + 0.9 * _sin(tt - lag, 3, 1.7 * ph + 0.5 * i)
                    + flop(tt - 1 - i))

        out[f"LeftHand{fn}1"] = (0.7 * _sin(t, 2, ph + i) * (1 if i < 2 else -1), curl(t), 0.0)
        out[f"LeftHand{fn}2"] = (0.0, 1.25 * curl(t - 2), 0.0)
    out["LeftHandThumb1"] = (0.8 * _sin(t, 2, ph + 0.5), 1.6 * _sin(t, 1, ph + 1.1), 0.0)
    out["LeftHandThumb2"] = (0.0, 2.2 * _sin(t - 2, 1, ph + 1.1), 0.0)
    return out


def _arms(sim, t):
    """Arm/hand/finger offsets (added to STAND) at frame t."""
    n = FRAMES * SUB

    def th(s, tt):  # world deflection at time tt (frames)
        r = sim[s][int(round(tt * SUB)) % n]
        return r[0], r[1]

    out = {}
    for s, pre in SIDES:
        thx, thy = th(s, t)
        rhx, rhy = sim[s][int(round(t * SUB)) % n][2:]
        # Elbow and wrist trail the upper arm (double/triple pendulum).
        fx = 0.5 * (th(s, t - 3)[0] - thx)
        hx = 0.3 * (th(s, t - 5)[0] - th(s, t - 2)[0])
        hy = 0.6 * (th(s, t - 4)[1] - th(s, t - 1)[1])
        tone = _sin(t, 1, 2.0 if s > 0 else 4.3)
        out[pre + "Arm"] = (thx - rhx, thy - rhy - ARM_OUT * s, 0.0)
        out[pre + "ForeArm"] = (fx - 1.2 * tone, 0.0, 0.0)  # elbow bend is -X
        out[pre + "Hand"] = (hx, hy + 0.8 * s * _sin(t, 1, 1.0 if s > 0 else 3.6), 0.0)

    def flop(s):
        # Fingers lag the hand: world-Y lag, turned into a LEFT-hand curl value.
        def f(tt):
            v = 1.2 * (th(s, tt - 3)[1] - th(s, tt)[1])
            return v if s > 0 else -v  # mirror() flips it back for the right hand
        return f

    out.update(_fingers_left(t, 0.3, flop(1)))
    out.update(mirror(_fingers_left(t, 2.4, flop(-1))))
    return out


def pose_at(t, sim):
    p = _body(t)
    p.update(_legs(p, t))
    return merge(p, _arms(sim, t))


def _key_frames():
    """Every STEP frames, plus every 2 frames while the weight moves fast, so
    the Bezier in-betweens keep the IK-planted feet still (< 0.5 mm)."""
    frames = set(range(0, FRAMES + 1, STEP))
    for f in range(0, FRAMES, 2):
        if abs(W(f + 1) - W(f - 1)) / 2 > 0.45 * _WSPEED:
            frames.add(f)
    return sorted(frames)


def build(anim):
    sim = _simulate()
    for f in _key_frames():
        anim.key(f, pose_at(f % FRAMES, sim))
