"""Push: walking behind the archive cart, both hands on its grip bar, IN PLACE
(the app moves the root and carries the cart rigidly 1.02 m ahead of it).

HQ_CLIPS "Push" (code 8). 32 frames at 30 fps, the same foot timing as Walk
(frame 0 = left heel contact, 16 = right), so a Walk <-> Push crossfade keeps
the feet in phase. Stride 1.12 m (two 0.56 m steps) -> 1.05 m/s: a shorter,
steadier step than the free walk (1.31 m/s), the gait of someone moving a load.

Built on walk.py's machinery (IK-planted feet, solved pelvis bob), loaded as a
private copy so Walk's own constants stay untouched, then:
  * stride 1.40 -> 1.12 m, swing angles scaled down to match
  * the trunk leans into the load: pelvis +7 deg, chest +13 deg forward
  * the chest's counter-rotation drops to a third (the hands are fixed on the
    bar, so the shoulders cannot swing); pelvis yaw and sway are reduced
  * the eyes look over the cart, 8 deg below the horizon
  * both arms are solved with arm_ik every key so the palms stay locked on the
    grip bar; the elbows absorb the pelvis bob and the sway of the step, the
    fingers wrap the bar and the thumbs close underneath

Grip contract (HQ_PUSH_GRIP in src/features/hq/core/config.ts, the cart in
blender/hq/props_archive.py): the grip bar centre is 0.40 m ahead of the root
(y = -0.40, -Y is forward), 0.97 m above the floor, grips at x = +-0.20. The
cart's origin is 0.62 m ahead of its bar, so it rides 1.02 m ahead of the root.
check() measures the palms on the evaluated rig after the build and prints
them; change GRIP_* here and HQ_PUSH_GRIP together.
"""

import importlib.util
import math

from mathutils import Vector

import rig
import walk as _walk_src
from _base import arm_ik, joint, left_thumb, look_at
from pose import merge, mirror

NAME = "Push"
FRAMES = 32
CYCLIC = True

STRIDE = 1.12
LEAN_PELVIS = 7.0
LEAN_CHEST = 13.0

# the grip bar in the character's frame (-Y is forward)
GRIP_X, GRIP_Y, GRIP_Z = 0.20, -0.40, 0.97
BAR_R = 0.0175  # rubber grip radius (props_archive.BAR_R)
CART_OFFSET = 1.02  # cart origin ahead of the root (the bar is 0.62 m behind the cart origin)
PALM_DOWN = 0.068  # the bar sits this far down the hand from the wrist (under the knuckle line)
PALM_DEPTH = 0.016  # wrist axis to the palm surface
GRIP_TOLERANCE = 0.015  # metres, checked by check()

# A private copy of walk.py, retuned for pushing.
_spec = importlib.util.spec_from_file_location("_push_walk", _walk_src.__file__)
Wk = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(Wk)
Wk.STRIDE = STRIDE
Wk.V = STRIDE / Wk.FRAMES
Wk.Y0 = -0.320 * STRIDE / 1.40
Wk.SWING_THIGH = [(t, a * 0.84) for t, a in Wk.SWING_THIGH]
Wk.SWING_KNEE = [(t, k * 0.93) for t, k in Wk.SWING_KNEE]

_pelvis0, _chest0 = Wk.pelvis, Wk.chest


def _pelvis(f, z=None):
    (x, y, zz), (pp, pr, py) = _pelvis0(f, z)
    return (x * 0.8, y + 0.012, zz), (pp + LEAN_PELVIS, pr * 0.85, py * 0.7)


def _chest(f):
    cp, cr, cy = _chest0(f)
    return cp + LEAN_CHEST, cr * 0.6, cy * 0.33


Wk.pelvis, Wk.chest = _pelvis, _chest


def _head(p, f):
    r, t = Wk.fk(p, "Head")
    eye = r @ Vector((0.0, -0.085, 1.686)) + t
    p = look_at(p, Vector((0.0, -6.0, eye.z - 6.0 * math.tan(math.radians(8.0)))))
    _, cr, cy = _chest(f - 1)
    nod = 0.6 * math.cos(2 * Wk.W * (f - 4))
    return merge(p, {"Neck": (0.0, -0.4 * cr, 0.0), "Head": (nod, -0.4 * cr, 0.1 * cy)})


# overhand grip: fingers round the front of the bar, thumb underneath
_GRIP_L = merge({
    "LeftHandIndex1": (-2, 58, 0),
    "LeftHandIndex2": (0, 72, 0),
    "LeftHandMiddle1": (0, 62, 0),
    "LeftHandMiddle2": (0, 74, 0),
    "LeftHandRing1": (2, 64, 0),
    "LeftHandRing2": (0, 74, 0),
    "LeftHandPinky1": (4, 66, 0),
    "LeftHandPinky2": (0, 72, 0),
}, left_thumb(0.55, 0.2, 0.8, 38))

HAND_FWD = Vector((-0.1, -0.84, -0.53)).normalized()  # left hand; x mirrored
PALM = Vector((0.0, 0.5, -0.86))  # palm on the bar: down and a little back


def grip_wrist(side):
    """Wrist (Hand head) that puts the palm round the bar: the bar sits ~7 cm down
    the hand (under the knuckle line) and one grip radius + half a hand below it."""
    f = Vector((HAND_FWD.x * side, HAND_FWD.y, HAND_FWD.z))
    n = (PALM - f * PALM.dot(f)).normalized()
    bar = Vector((GRIP_X * side, GRIP_Y, GRIP_Z))
    return bar - f * PALM_DOWN - n * (BAR_R + PALM_DEPTH), f, n


def arm(p, f, side):
    pre = "Left" if side > 0 else "Right"
    sh = (0.0, 2.5 * side, -7.0 * side)  # clavicles a little forward (reaching)
    q = dict(p)
    q[pre + "Shoulder"] = sh
    s = joint(q, pre + "Arm")
    w, fwd, n = grip_wrist(side)
    pole = s + Vector((0.34 * side, 0.3, -0.42))  # elbows out, back and down
    out = arm_ik(q, side, w, pole=pole, hand_fwd=fwd, palm=n, shoulder=sh)
    # the grip tightens a touch as each step pushes off
    k = 0.5 + 0.5 * math.cos(2 * Wk.W * (f - 14))
    g = merge(_GRIP_L, {"LeftHandIndex1": (0, 3 * k, 0), "LeftHandMiddle1": (0, 3 * k, 0),
                        "LeftHandRing1": (0, 2 * k, 0), "LeftHandPinky1": (0, 2 * k, 0)})
    out.update(g if side > 0 else mirror(g))
    return out


def pose_at(f):
    p = Wk.body(f)
    p.update(Wk.legs(p, f))
    p = _head(p, f)
    p.update(arm(p, f, 1))
    p.update(arm(p, f, -1))
    return p


def build(anim):
    for f in range(0, FRAMES + 1, 2):
        anim.key(f, pose_at(f))


def _palm(arm_obj, side):
    """Palm centre and the grip-bar centre it closes round, from the evaluated rig."""
    pre = "Left" if side > 0 else "Right"
    pb = arm_obj.pose.bones[pre + "Hand"]
    m = arm_obj.matrix_world @ pb.matrix
    r = m.to_3x3().normalized() @ pb.bone.matrix_local.to_3x3().normalized().inverted()
    wrist = m.translation
    f = (m.to_3x3().col[1]).normalized()  # bone Y = down the hand
    n = (r @ rig._palm_normal(side)).normalized()
    palm = wrist + f * PALM_DOWN + n * PALM_DEPTH
    return palm, palm + n * BAR_R


def check(scene, arm_obj, action):
    """Print the palm positions over the cycle (every half frame, as the app samples the
    clip) and how far the bar they hold is from the grip contract. Returns the worst error."""
    arm_obj.animation_data.action = action
    frame0 = scene.frame_current
    worst = 0.0
    rows = []
    for k in range(FRAMES * 2):
        f, sub = k // 2, 0.5 * (k % 2)
        scene.frame_set(f, subframe=sub)
        row = []
        for side in (1, -1):
            palm, bar = _palm(arm_obj, side)
            err = (bar - Vector((GRIP_X * side, GRIP_Y, GRIP_Z))).length
            worst = max(worst, err)
            row.append((palm, bar, err))
        rows.append((f + sub, row))
    scene.frame_set(frame0)
    print("[push] palm centres and the bar they hold (Blender: -Y forward; reach = -y, height = z, halfSpan = |x|)")
    for t, row in rows[::4]:
        cells = []
        for (palm, bar, err), s in zip(row, "LR"):
            cells.append(f"{s} palm ({palm.x:+.3f},{palm.y:+.3f},{palm.z:+.3f}) bar ({bar.x:+.3f},{bar.y:+.3f},"
                         f"{bar.z:+.3f}) err {err * 100:.2f} cm")
        print(f"[push] f{t:05.1f} " + " | ".join(cells))
    bars = [b for _, row in rows for _, b, _ in row]
    reach = sum(-b.y for b in bars) / len(bars)
    height = sum(b.z for b in bars) / len(bars)
    span = sum(abs(b.x) for b in bars) / len(bars)
    ok = worst <= GRIP_TOLERANCE
    print(f"[push] grip mean: reach {reach:.4f} height {height:.4f} halfSpan {span:.4f}"
          f" (contract {-GRIP_Y:.2f} / {GRIP_Z:.2f} / {GRIP_X:.2f}); worst error {worst * 100:.2f} cm"
          f" -> {'OK' if ok else 'FAIL'} (tolerance {GRIP_TOLERANCE * 100:.1f} cm)")
    return worst
