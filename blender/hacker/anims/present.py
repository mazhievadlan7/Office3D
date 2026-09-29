"""Presenting the video wall behind him (AM7 at the briefing podium), in place.

The root faces the rows (-Y) the whole time and the video wall is behind him
(+Y): the half turn is in the clip, the feet never move. He turns to his
right, presents a point on the wall with his right hand, turns back and
explains to the rows. Beats (30 fps, 168 frames):
  0-13    relaxed stand facing the rows, weight a little on the right leg; a
          breath in while the weight rocks toward the left leg and the chest
          turns a touch left (wind-up)
  13-40   the eyes and head lead a half turn to the right, the chest follows
          (~68 deg), the pelvis last (~24 deg) as the weight rolls onto the
          right leg. The right clavicle lifts first; the hand scoops up past
          the hip, palm up, and the arm sweeps out and up toward the wall, the
          elbow unfolding, arriving just after the chest with a small overshoot
  40-86   presents WALL (behind him to his right: ~121 deg from straight
          ahead, ~18 deg up): open hand, palm turned up, fingers together, the
          index a little ahead, the head looking along the arm. A beat at
          ~53-57 (the hand draws back and cocks, then presses toward the wall
          with a nod), then a hold while the eyes and hand drift a little
          along the wall
  86-110  turns back to the rows, head first, then chest and pelvis; the arm
          lets go a few frames after the head, drops, the elbow folds and the
          hand swings round to the front, palm up
  110-142 explains: an open-palm beat with a nod (~120), then both hands open
          out (the left joins late and leaves early) with a smaller nod
  142-168 the arms fall back to hang with follow-through, the weight settles
          on the right leg: back to the start pose

Built on _base.STAND, like Talk: frame 0 is within ~2 deg of Talk's frame 0
on every bone, so the two crossfade cleanly. Feet are solved with leg_ik
every key so they never slide; the pelvis height is solved so the straighter
knee keeps a little flex and dips while the weight moves. Arms are solved
with arm_ik from targets in chest space, so the gestures ride the turn; the
presenting keys are aimed at WALL from the body pose of their own frame.
Each channel is a periodic monotone spline; the clavicle leads the wrist,
the hand orientation trails it and the fingers trail further with an
index-to-pinky cascade. Palm-up supination is shared between the upper arm
(tw), the forearm and the wrist so no one joint wrings the sleeve.
"""

import math

from mathutils import Matrix, Vector

import _base as B
import rig
from _base import STAND, arm_ik, fk, joint, leg_ik, look_at, override
from pose import merge, mirror

NAME = "Present"
FRAMES = 168
CYCLIC = True
STEP = 1  # key every frame: the turn is fast and the feet are IK-planted
SIDES = ((1, "Left"), (-1, "Right"))

# What he presents, in the character's frame (+X = his left, +Y = behind him):
# a point on the video wall behind him, to his right and above head height
# (from the eyes: 121.5 deg round to the right from straight ahead, 18 deg up).
WALL = Vector((-5.2, 3.1, 3.67))
AUDIENCE = Vector((0.0, -6.0, 1.55))  # the rows


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


# --- gaze ---------------------------------------------------------------------
def _angles(target):
    """(azimuth, elevation) in degrees of a point seen from the rest eyes;
    azimuth + turns toward the character's left, 0 = straight ahead."""
    d = (Vector(target) - B.EYE_REST).normalized()
    return math.degrees(math.atan2(d.x, -d.y)), math.degrees(math.asin(d.z))


def _gaze_point(az, el, dist=6.0):
    a, e = math.radians(az), math.radians(el)
    return B.EYE_REST + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist


AZ_W, EL_W = _angles(WALL)  # -121.5 / +18: 58.5 deg right of straight back
AZ_A, EL_A = _angles(AUDIENCE)

# --- body tracks ----------------------------------------------------------------
# weight: + on the left leg, - on the right
T_WEIGHT = Track([(0, -0.3), (6, -0.2), (12, -0.04), (17, -0.12), (23, -0.52), (29, -0.84),
                  (35, -0.93), (42, -0.87), (52, -0.88), (57, -0.93), (66, -0.86), (86, -0.85),
                  (92, -0.72), (98, -0.42), (104, -0.1), (110, 0.08), (120, 0.16), (132, 0.12),
                  (144, -0.04), (153, -0.22), (161, -0.29)])
# chest yaw relative to the feet, + toward the character's left (degrees)
T_TURN = Track([(0, 0.0), (6, 0.5), (11, 1.4), (15, -0.8), (20, -12.0), (25, -32.0), (30, -52.0),
                (35, -64.0), (39, -69.5), (44, -67.8), (52, -67.0), (57, -69.0), (63, -67.6),
                (75, -66.2), (86, -66.6), (90, -62.0), (95, -44.0), (100, -20.0), (105, -3.0),
                (109, 2.2), (114, 1.2), (127, -2.5), (137, -1.0), (148, 0.8), (158, 0.2)])
# chest pitch, + leans forward (degrees, spread over the spine)
T_LEAN = Track([(0, 0.0), (8, -0.8), (16, 0.4), (26, -1.5), (36, -2.8), (44, -2.2), (52, -2.5),
                (57, -0.6), (61, -1.2), (71, -2.4), (86, -2.2), (94, -0.8), (102, 0.8), (110, 1.6),
                (121, 2.6), (126, 1.4), (133, 2.2), (140, 1.0), (150, 0.2), (160, 0.0)])
# chest side bend, + toward the character's left (degrees)
T_SIDE = Track([(0, 0.0), (20, 0.0), (36, 1.4), (57, 1.8), (86, 1.2), (100, 0.0)])
# breath, + inhale
T_BREATH = Track([(0, 0.0), (6, 0.5), (12, 1.0), (22, 0.8), (34, 0.5), (44, 0.4), (51, 0.85),
                  (57, 0.3), (69, 0.2), (80, 0.45), (90, 0.9), (102, 0.7), (112, 0.35), (120, 0.1),
                  (128, 0.3), (136, 0.05), (148, -0.2), (158, -0.1)])
# extra knee flex (degrees): the knees unlock while the weight moves
T_DIP = Track([(0, 0.0), (14, 0.0), (22, 3.5), (29, 4.5), (38, 2.0), (46, 1.0), (86, 1.0),
               (94, 3.5), (102, 3.0), (110, 1.0), (122, 0.5), (142, 0.0)])
# gaze, degrees (see _angles): the eyes lead the turn out and the turn back
G_AZ = Track([(0, AZ_A), (10, AZ_A), (14, AZ_A - 1.5), (18, -13.0), (22, -36.0), (26, -62.0),
              (30, -88.0), (34, -107.0), (38, AZ_W - 1.5), (43, AZ_W + 0.5), (50, AZ_W), (57, AZ_W - 1.0),
              (65, AZ_W + 2.5), (73, AZ_W + 5.5), (80, AZ_W + 3.0), (87, AZ_W + 0.5),
              (90, AZ_W + 5.0), (94, -95.0), (98, -60.0), (102, -26.0), (106, AZ_A - 4.0),
              (110, AZ_A + 2.0), (118, AZ_A + 1.0), (128, AZ_A - 4.0), (138, AZ_A + 2.0),
              (150, AZ_A + 0.6)])
G_EL = Track([(0, EL_A), (12, EL_A), (20, EL_A + 4.0), (28, EL_W - 5.0), (35, EL_W + 1.5),
              (40, EL_W + 0.5), (50, EL_W), (57, EL_W - 1.0), (67, EL_W + 3.0), (79, EL_W + 1.0),
              (88, EL_W), (95, EL_W - 8.0), (102, EL_A + 1.5), (108, EL_A - 1.0), (118, EL_A - 2.0),
              (132, EL_A), (152, EL_A)])
# head: nod (+ down), tilt (+ toward the left)
T_NOD = Track([(0, 0.0), (49, 0.0), (53, -1.5), (56, 4.5), (60, 0.8), (63, 0.0), (112, 0.0),
               (117, -1.2), (120, 5.5), (124, 0.5), (130, 0.0), (133, 3.0), (137, -0.5), (142, 0.0)])
T_TILT = Track([(0, 0.0), (20, -1.0), (34, -2.5), (44, -3.0), (71, -1.5), (86, -2.0), (100, 1.2),
                (112, 2.5), (126, 1.0), (142, 0.0)])

# --- legs ---------------------------------------------------------------------------
ANKLE = {s: joint(STAND, p + "Foot") for s, p in SIDES}
FLEX = 5.0  # knee flex of the straighter leg (deg)
_L1 = (rig.tail_of("LeftUpLeg") - rig.head_of("LeftUpLeg")).length
_L2 = (rig.tail_of("LeftLeg") - rig.head_of("LeftLeg")).length


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


def _legs(p, w, hip_yaw):
    """Both legs to the STAND ankles, feet flat. The knees are carried round a
    little by the pelvis; the unweighted knee falls in."""
    out = {}
    rot = Matrix.Rotation(math.radians(0.7 * hip_yaw), 3, "Z")
    for side, pre in SIDES:
        hip = joint(p, pre + "UpLeg")
        free = max(0.0, min(1.0, -w * side))
        pole = hip + rot @ Vector((side * (0.03 - 0.25 * free), -1.0, -0.48))
        out.update(leg_ik(p, side, ANKLE[side], pole))
    return out


def body_pose(t):
    w = T_WEIGHT(t)
    lean = T_LEAN(t)
    br = T_BREATH(t)
    bend = T_SIDE(t)
    # The turn runs up the chain from the eyes: chest first, pelvis last.
    hip_yaw = 0.34 * T_TURN(t - 3) + 1.2 * w
    p = merge(dict(STAND), {
        "Hips@": (0.026 * w, 0.003 * lean, 0.0),
        "Hips": (0.25 * lean, -2.2 * w, hip_yaw),
        "Spine": (0.25 * lean + 0.2 * br, 1.3 * w + 0.3 * bend, 0.20 * T_TURN(t - 2) - 0.4 * w),
        "Spine1": (0.35 * lean - 0.5 * br, 1.0 * w + 0.35 * bend, 0.22 * T_TURN(t - 1) - 0.4 * w),
        "Spine2": (0.4 * lean - 0.7 * br, 0.6 * w + 0.35 * bend, 0.24 * T_TURN(t) - 0.4 * w),
    })
    x, y, _ = p["Hips@"]
    p["Hips@"] = (x, y, _hips_z(p, FLEX + T_DIP(t)))
    p.update(_legs(p, w, hip_yaw))
    # head: eyes on the gaze point, then nod / tilt on top
    p = look_at(p, _gaze_point(G_AZ(t), G_EL(t)))
    nod, tilt = T_NOD(t), T_TILT(t)
    p = merge(p, {
        "Neck": (0.4 * nod - 0.15 * lean + 0.3 * br, 0.4 * tilt, 0),
        "Head": (0.6 * nod - 0.1 * lean, 0.6 * tilt, 0),
    })
    return p, br


# --- reference data from STAND (chest space = Spine2 rest frame) ----------------
_R2, _T2 = fk(STAND, "Spine2")
_R2I = _R2.inverted()


def _to_chest(p_world):
    return _R2I @ (Vector(p_world) - _T2)


_D0 = (rig.tail_of("LeftArm") - rig.head_of("LeftArm")).normalized()
_N0 = rig._palm_normal(1)
S_REST = _to_chest(joint(STAND, "LeftArm"))  # left shoulder joint, chest space
_HANG_W = _to_chest(joint(STAND, "LeftHand"))
_HANG_E = _to_chest(joint(STAND, "LeftForeArm"))
_rh, _ = fk(STAND, "LeftHand")
_HANG_FWD = _R2I @ (_rh @ _D0)
_HANG_PALM = _R2I @ (_rh @ _N0)
# Pole: push the elbow away from the shoulder-wrist line (back and out).
_mid = S_REST + (_HANG_W - S_REST) * ((_HANG_E - S_REST).dot(_HANG_W - S_REST) / (_HANG_W - S_REST).length_squared)
_HANG_POLE = (_HANG_E + (_HANG_E - _mid).normalized() * 0.4) - S_REST

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
PRESENT_F = merge({  # presenting: long and together, the index a little ahead
    "LeftHandIndex1": (1.0, 1.5, 0),
    "LeftHandIndex2": (0, 3, 0),
    "LeftHandMiddle1": (0.0, 4, 0),
    "LeftHandMiddle2": (0, 5, 0),
    "LeftHandRing1": (-1.0, 6.5, 0),
    "LeftHandRing2": (0, 8, 0),
    "LeftHandPinky1": (-2.0, 9.5, 0),
    "LeftHandPinky2": (0, 11, 0),
}, B.left_thumb(0.95, 0.2, 0.2, 8))
SPREAD_F = {
    "LeftHandIndex1": (-5, -1, 0),
    "LeftHandMiddle1": (-1.5, 0, 0),
    "LeftHandRing1": (2.5, 0, 0),
    "LeftHandPinky1": (6, 0, 0),
    "LeftHandThumb1": (-4, -2, 3),
}


def _fingers(tr, t, life):
    """Finger values for one (left-convention) hand from its open / present /
    spread tracks; each finger samples them a little later than the one
    before, and a held presenting hand barely moves."""
    out = {}
    lag = {"Thumb": 2.0, "Index": 3.0, "Middle": 3.6, "Ring": 4.2, "Pinky": 4.8}
    for f in ["Thumb"] + _FINGERS:
        tt = t - lag[f]
        o = max(0.0, min(1.1, tr.op(tt)))
        pr = max(0.0, min(1.0, tr.pr(tt)))
        s = max(0.0, tr.sp(tt))
        wob = life * (1.0 - 0.7 * pr) * math.sin(2 * math.pi * (t / FRAMES) * 3 + lag[f] * 1.3)
        for seg in (1, 2):
            k = f"LeftHand{f}{seg}"
            a = RELAX_F.get(k, (0, 0, 0))
            b = OPEN_F.get(k, (0, 0, 0))
            c = PRESENT_F.get(k, (0, 0, 0))
            d = SPREAD_F.get(k, (0, 0, 0))
            v = [a[i] * (1 - o) + (b[i] * (1 - pr) + c[i] * pr) * o + d[i] * s for i in range(3)]
            if f != "Thumb":
                v[1] += wob * (1.0 if seg == 1 else 1.3)
            out[k] = tuple(v)
    return out


# --- arm key poses (left convention, chest space; x = out to that arm's side) ---
def A(w, fwd, palm, pole=(0.4, 0.28, -0.6), sh=(0, 1.5, -3), op=1.0, sp=0.0, pr=0.0, tw=0.0):
    """w wrist, fwd hand direction, palm normal, pole (from the shoulder), sh
    clavicle, op/sp/pr finger open/spread/present, tw upper-arm twist (deg,
    - = external rotation)."""
    return dict(w=Vector(w), fwd=_norm(fwd), palm=_norm(palm), pole=Vector(pole), sh=sh, op=op, sp=sp,
                pr=pr, tw=tw)


_HANG_DIST = (_HANG_W - S_REST).length
_HANG_W2 = S_REST + (_HANG_W + Vector((0.012, -0.004, 0.0)) - S_REST).normalized() * _HANG_DIST * 0.995
_HANG_POLE2 = _HANG_POLE + Vector((0.2, 0.0, 0.0))
HANG = dict(w=_HANG_W2, fwd=_HANG_FWD, palm=_HANG_PALM, pole=_HANG_POLE2, sh=(0, 3, 0), op=0.0, sp=0.0,
            pr=0.0, tw=0.0)


def hang(dx=0.0, dy=0.0, dz=0.0, sh=(0, 3, 0), op=0.0, bend=0.0):
    """Relaxed hanging arm swung by (dx, dy, dz) metres at the wrist, arm length
    kept (so the elbow never locks straight); bend shortens it a little."""
    h = dict(HANG)
    v = (_HANG_W2 + Vector((dx, dy, dz)) - S_REST).normalized()
    h["w"] = S_REST + v * (_HANG_W2 - S_REST).length * (1.0 - bend)
    h["sh"] = sh
    h["op"] = op
    return h


def aim(frame, dist=0.505, lift=2.0, up=0.6, sh=(0, -10, -3), pole=(0.2, 0.32, -0.6), tw=-28.0,
        target=WALL, op=1.0):
    """Right-arm key with the wrist on the line from the shoulder to `target`
    (a point on the wall), for the body pose at `frame`. `lift` bends the
    hand up off that line (wrist extension); `up` is how far the palm turns
    up (0 = toward the chest's front, 1 = toward the ceiling)."""
    p, _ = body_pose(frame)
    r2i = fk(p, "Spine2")[0].inverted()
    q = dict(p)
    q["RightShoulder"] = B._mirror_val("LeftShoulder", sh)
    s = joint(q, "RightArm")

    def left(v):  # world -> chest space, mirrored to the left convention
        c = r2i @ v
        return Vector((-c.x, c.y, c.z))

    d = left((Vector(target) - s).normalized())
    upc = left(Vector((0.0, 0.0, 1.0)))
    u = (upc - d * upc.dot(d)).normalized()
    fwd = d * math.cos(math.radians(lift)) + u * math.sin(math.radians(lift))
    palm = upc * up + Vector((0.0, -1.0, 0.0)) * (1.0 - up)
    return A(S_REST + d * dist, fwd, palm, pole=pole, sh=sh, op=op, pr=1.0, tw=tw)


# Right hand: scoop up past the hip, sweep out and up to the wall, present,
# come round to the front and explain.
SCOOP = A((0.275, -0.13, 0.965), (0.1, -0.8, -0.55), (-0.8, -0.1, 0.6), pole=(0.3, 0.4, -0.6),
          sh=(0, 1.5, -1.5), op=0.3, tw=-4.0)
SCOOP2 = A((0.345, -0.285, 1.15), (0.35, -0.9, 0.2), (-0.35, -0.1, 0.93), pole=(0.35, 0.4, -0.6),
           sh=(0, -3.0, -3.0), op=0.75, pr=0.3, tw=-12.0)
RELEASE = A((0.53, -0.3, 1.5), (0.6, -0.72, 0.32), (-0.1, -0.5, 0.86), pole=(0.25, 0.33, -0.6),
            sh=(0, -7.0, -3.0), op=1.0, pr=0.85, tw=-24.0)
LOWER = A((0.46, -0.33, 1.29), (0.45, -0.87, 0.12), (-0.25, -0.35, 0.9), pole=(0.35, 0.35, -0.6),
          sh=(0, -3.5, -2.5), op=0.95, pr=0.55, tw=-15.0)
LOWER2 = A((0.34, -0.34, 1.15), (0.18, -0.98, 0.08), (-0.45, -0.2, 0.87), pole=(0.4, 0.3, -0.6),
           sh=(0, 0.0, -2.5), op=0.95, pr=0.2, tw=-8.0)
EXPLAIN_IN = A((0.265, -0.33, 1.1), (0.08, -0.98, 0.15), (-0.55, -0.15, 0.82), sh=(0, 0.5, -3.0), tw=-6.0)
EXPLAIN_OVER = A((0.262, -0.34, 1.072), (0.08, -0.98, 0.05), (-0.55, -0.18, 0.8), sh=(0, 1.0, -3.0), tw=-6.0)
EXPLAIN = A((0.268, -0.33, 1.11), (0.06, -0.98, 0.18), (-0.58, -0.14, 0.8), sh=(0, 0.5, -3.0), tw=-6.0)
BEAT_UP = A((0.265, -0.34, 1.135), (0.06, -0.97, 0.24), (-0.56, -0.14, 0.81), sh=(0, 0.0, -3.0), tw=-6.0)
BEAT = A((0.26, -0.355, 1.075), (0.06, -0.98, 0.02), (-0.52, -0.2, 0.83), sh=(0, 1.0, -3.0), tw=-6.0)
EXPLAIN2 = A((0.28, -0.33, 1.105), (0.12, -0.98, 0.15), (-0.5, -0.16, 0.85), sh=(0, 0.5, -3.0), tw=-6.0)
OPEN = A((0.35, -0.28, 1.1), (0.5, -0.85, 0.12), (0.1, -0.35, 0.93), pole=(0.45, 0.25, -0.6),
         sh=(0, 0.5, -2.0), sp=0.6, tw=-10.0)
OPEN2 = A((0.36, -0.26, 1.08), (0.52, -0.85, 0.06), (0.12, -0.33, 0.93), pole=(0.45, 0.25, -0.6),
          sh=(0, 1.0, -2.0), sp=0.5, tw=-10.0)
DROP = A((0.27, -0.11, 0.955), (0.3, -0.55, -0.78), (-0.95, 0.05, 0.2), pole=(0.4, 0.3, -0.6),
         sh=(0, 2.5, -1.0), op=0.45, sp=0.2)
# Left hand: joins the explanation briefly, a smaller open palm.
L_JOIN = A((0.205, -0.21, 1.0), (-0.1, -0.9, 0.35), (-0.8, -0.1, 0.55), pole=(0.35, 0.35, -0.6),
           sh=(0, 2.0, -1.5), op=0.6)
L_OPEN = A((0.255, -0.2, 1.0), (0.35, -0.9, 0.2), (0.0, -0.35, 0.93), pole=(0.45, 0.3, -0.6),
           sh=(0, 2.0, -1.5), op=0.85, sp=0.4)

ARM_KEYS = {
    -1: [  # right arm: presents, then explains
        (0, hang()),
        (7, hang(0.0, -0.004, 0.003, sh=(0, 2.4, -0.8))),
        (13, hang(0.004, 0.014, -0.002, sh=(0, 2.0, -1.2), op=0.05)),
        (20, SCOOP),
        (27, SCOOP2),
        (39, aim(39, dist=0.515, lift=-1.0, sh=(0, -11.5, -3))),
        (44, aim(44)),
        (49, aim(49, dist=0.503, target=WALL + Vector((0.0, 0.0, -0.1)))),
        (53, aim(53, dist=0.49, lift=10.0)),
        (57, aim(57, dist=0.518, lift=-2.0, sh=(0, -9, -3.5))),
        (62, aim(62, dist=0.503)),
        (73, aim(73, lift=3.0, target=WALL + Vector((-0.65, 0.0, 0.35)))),
        (85, aim(85, dist=0.5, lift=2.0, target=WALL + Vector((-0.2, 0.0, 0.1)))),
        (91, RELEASE),
        (96, LOWER),
        (101, LOWER2),
        (106, EXPLAIN_IN),
        (110, EXPLAIN_OVER),
        (114, EXPLAIN),
        (118, BEAT_UP),
        (122, BEAT),
        (127, EXPLAIN2),
        (132, OPEN),
        (138, OPEN2),
        (145, DROP),
        (151, hang(0.0, 0.018, -0.004, sh=(0, 3.5, 0))),
        (157, hang(0.002, -0.006, 0.0)),
        (163, hang(0.0, 0.002, 0.0)),
    ],
    1: [  # left arm: hangs and swings with the turn, joins the explanation
        (0, hang()),
        (12, hang(-0.002, 0.004, 0.002)),
        (22, hang(0.002, 0.022, 0.004)),
        (28, hang(0.004, 0.035, 0.006)),
        (36, hang(0.002, 0.012, 0.0)),
        (42, hang(0.0, -0.022, 0.006)),
        (50, hang(0.0, -0.004, 0.0)),
        (60, hang()),
        (86, hang(0.0, 0.002, 0.0)),
        (92, hang(0.0, -0.02, 0.004)),
        (98, hang(0.002, -0.034, 0.008)),
        (105, hang()),
        (110, hang(0.0, 0.02, 0.0)),
        (115, hang(0.004, -0.02, 0.03, bend=0.08, op=0.25)),
        (126, L_JOIN),
        (134, L_OPEN),
        (142, hang(-0.004, -0.02, 0.01, op=0.3)),
        (150, hang(0.0, 0.012, -0.002)),
        (157, hang(0.0, -0.004, 0.0)),
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
        self.pr = tr("pr")
        self.tw = tr("tw")


ARMS = {side: ArmTracks(keys) for side, keys in ARM_KEYS.items()}


def arm_pose(p, side, t, br):
    tr = ARMS[side]
    pre = "Left" if side > 0 else "Right"
    r2, _ = fk(p, "Spine2")

    def m(v):  # left-convention chest vector -> this side, world
        return r2 @ Vector((v[0] * side, v[1], v[2]))

    sh = tr.sh(t + 3)  # clavicle leads
    sh = (sh[0], sh[1] - 0.8 * br, sh[2])
    shv = tuple(sh) if side > 0 else B._mirror_val("LeftShoulder", tuple(sh))
    q = dict(p)
    q[pre + "Shoulder"] = shv
    s = joint(q, pre + "Arm")
    rel = tr.w(t)
    d = Vector((rel[0] * side, rel[1], rel[2])).normalized() * tr.dist(t)
    wrist = s + r2 @ d
    pole = s + m(tr.pole(t))
    fwd = m(tr.fwd(t - 2))  # the hand trails the wrist
    palm = m(tr.palm(t - 2))
    out = arm_ik(p, side, wrist, pole, fwd, palm, shoulder=shv, fore_twist=0.55, arm_twist=tr.tw(t - 1))
    fing = _fingers(tr, t, 2.5)
    out.update(fing if side > 0 else mirror(fing))
    return out


def pose_at(t):
    p, br = body_pose(t)
    p = override(p, arm_pose(p, 1, t, br), arm_pose(p, -1, t, br))
    return p


def build(anim):
    for f in range(0, FRAMES + 1, STEP):
        anim.key(f, pose_at(f % FRAMES))
