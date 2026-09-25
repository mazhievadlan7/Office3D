"""Shared base poses. See pose.py for the axis conventions."""

import math

from mathutils import Euler, Matrix, Quaternion, Vector

import rig
from pose import merge, mirror

# Relaxed standing pose, left side; the right side is mirrored.
_STAND_LEFT = {
    "LeftShoulder": (0, 3, 0),
    "LeftArm": (2, 26, 0),
    "LeftForeArm": (-12, 5, 0),
    "LeftHand": (0, 4, 0),
    "LeftHandIndex1": (0, 10, 0),
    "LeftHandIndex2": (0, 14, 0),
    "LeftHandMiddle1": (0, 13, 0),
    "LeftHandMiddle2": (0, 17, 0),
    "LeftHandRing1": (0, 16, 0),
    "LeftHandRing2": (0, 19, 0),
    "LeftHandPinky1": (0, 19, 0),
    "LeftHandPinky2": (0, 21, 0),
    "LeftHandThumb1": (0, 6, 0),
    "LeftHandThumb2": (0, 8, 0),
    "LeftUpLeg": (0, -1.5, 0),
    "LeftFoot": (0, 1.5, 0),
}

STAND = merge(
    _STAND_LEFT,
    mirror(_STAND_LEFT),
    {"Spine": (-1, 0, 0), "Spine1": (1, 0, 0), "Spine2": (1.5, 0, 0), "Neck": (2, 0, 0), "Head": (-2, 0, 0)},
)

# Finger curl for a loose fist / resting hand, left side.
_CURL_LEFT = {
    "LeftHandIndex1": (0, 22, 0),
    "LeftHandIndex2": (0, 30, 0),
    "LeftHandMiddle1": (0, 26, 0),
    "LeftHandMiddle2": (0, 32, 0),
    "LeftHandRing1": (0, 30, 0),
    "LeftHandRing2": (0, 34, 0),
    "LeftHandPinky1": (0, 33, 0),
    "LeftHandPinky2": (0, 36, 0),
}
CURL = merge(_CURL_LEFT, mirror(_CURL_LEFT))


# =============================================================================
# Seated poses
# =============================================================================
# Workstation contract (build.py docstring). Character root = chair centre on
# the floor, facing -Y; +X is the character's LEFT.
#
# Use in a seated clip, per key:
#   p = sit_pose(spine)           # legs, gaze and thigh-rest hands solved for `spine`
#   p = override(p, type_arms(p)) # or thigh_arms(p) / mouse_arm(p): hands planted
#   anim.key(f, merge(p, small_offsets))
# Arm/hand sets (SIT_TYPE_ARMS, type_arms(), ...) hold ABSOLUTE values: put them
# on a pose with override(), never merge() (merge adds angles). Re-solving the
# arms/legs from the clip's own spine keeps hands and feet exactly planted.
SEAT_TOP_Z = 0.47
DESK_TOP_Z = 0.75
DESK_EDGE_Y = -0.36
KEYBOARD = Vector((0.0, -0.50, 0.765))
MOUSE = Vector((-0.30, -0.50, 0.765))
MONITOR = Vector((0.0, -0.95, 1.08))  # centre monitor

# Rest-pose point between the eyes and the rest face direction (Head bone).
EYE_REST = Vector((0.0, -0.085, 1.686))
FACE_REST = Vector((0.0, -1.0, 0.0))


# --- forward kinematics (same maths as pose.Animator.apply) -------------------
def _rest(name):
    _, head, tail, parent, _ = rig.BONE[name]
    return head, tail, parent


def _quat(name, val):
    """Armature-space rotation of a pose value (see pose.local_quat)."""
    q = Euler(tuple(math.radians(a) for a in val[:3]), "XYZ").to_quaternion()
    if len(val) > 3 and val[3]:
        head, tail, _ = _rest(name)
        q = q @ Quaternion((tail - head).normalized(), math.radians(val[3]))
    return q


def fk(p, name):
    """Posed transform of bone `name` in pose dict `p` as (R, t): a rest-pose
    point x attached to the bone ends up at R @ x + t (armature space)."""
    head, _, parent = _rest(name)
    q = _quat(name, p.get(name, (0, 0, 0)))
    if parent is None:  # Hips: rotation about its head, then the Hips@ offset
        return q, head + Vector(p.get("Hips@", (0, 0, 0))) - q @ head
    rp, tp = fk(p, parent)
    return rp @ q, rp @ (head - q @ head) + tp


def point(p, name, rest_point):
    """Where a rest-pose point rigidly attached to bone `name` is in pose p."""
    r, t = fk(p, name)
    return r @ Vector(rest_point) + t


def joint(p, name):
    """Posed head position of a bone (what build.py --report prints)."""
    return point(p, name, rig.head_of(name))


def _val(q):
    e = q.normalized().to_euler("XYZ")
    return tuple(round(math.degrees(a), 2) for a in e)


def _twist_angle(q, axis):
    """Signed twist of q about `axis` (swing-twist decomposition), radians."""
    proj = Vector((q.x, q.y, q.z)).dot(axis)
    return 2.0 * math.atan2(proj, q.w)


def _two_bone(root, target, l1, l2, pole):
    v = target - root
    dist = max(min(v.length, l1 + l2 - 1e-4), abs(l1 - l2) + 1e-4)
    u = v.normalized()
    target = root + u * dist
    a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    pv = Vector(pole) - root
    pv = pv - u * pv.dot(u)
    pv = pv.normalized() if pv.length > 1e-6 else Vector((0, 0, -1))
    return root + u * a + pv * h, target


def _frame_rot(src, dst):
    """Rotation taking the orthonormal frame src (3 column vectors) to dst."""
    ms = Matrix(src).transposed()
    md = Matrix(dst).transposed()
    return (md @ ms.transposed()).to_quaternion()


# --- inverse kinematics -------------------------------------------------------
def arm_ik(p, side, wrist, pole, hand_fwd, palm, shoulder=None, fore_twist=0.35, arm_twist=0.0):
    """Arm values that put the wrist (Hand head) at `wrist`, with the elbow in the
    plane towards the `pole` point, the hand pointing along `hand_fwd` and the palm
    facing `palm` (all armature space). Uses the spine/shoulder values of pose p,
    so call it with the final spine pose to keep the hand planted.

    side: +1 left, -1 right. `shoulder` overrides p's Shoulder value.
    fore_twist: share of the forearm pronation carried by the ForeArm bone (the
    rest is absorbed at the wrist, which the sleeve cuff hides).
    Returns {bone: (rx, ry, rz)} for Shoulder, Arm, ForeArm and Hand.
    """
    pre = "Left" if side > 0 else "Right"
    out = {}
    sh = shoulder if shoulder is not None else p.get(pre + "Shoulder", (0, 0, 0))
    q2 = dict(p)
    q2[pre + "Shoulder"] = sh
    out[pre + "Shoulder"] = tuple(sh)
    r_sh, t_sh = fk(q2, pre + "Shoulder")
    s = r_sh @ rig.head_of(pre + "Arm") + t_sh
    d0 = (rig.tail_of(pre + "Arm") - rig.head_of(pre + "Arm")).normalized()  # arm/forearm/hand rest axis
    elbow, w = _two_bone(s, Vector(wrist), rig.UPPER_ARM, rig.FOREARM, pole)

    r_arm = (r_sh @ d0).rotation_difference((elbow - s).normalized()) @ r_sh
    if arm_twist:
        r_arm = Quaternion((elbow - s).normalized(), math.radians(arm_twist * side)) @ r_arm
    r_fore = (r_arm @ d0).rotation_difference((w - elbow).normalized()) @ r_arm

    f = Vector(hand_fwd).normalized()
    n = Vector(palm)
    n = (n - f * n.dot(f)).normalized()
    n0 = rig._palm_normal(side)
    r_hand = _frame_rot((d0, n0.cross(d0), n0), (f, n.cross(f), n))

    tw = _twist_angle(r_fore.inverted() @ r_hand, d0)
    r_fore = r_fore @ Quaternion(d0, tw * fore_twist)
    out[pre + "Arm"] = _val(r_sh.inverted() @ r_arm)
    out[pre + "ForeArm"] = _val(r_arm.inverted() @ r_fore)
    out[pre + "Hand"] = _val(r_fore.inverted() @ r_hand)
    return out


def leg_ik(p, side, ankle, pole, toe_out=0.0, shin_twist=0.5):
    """Leg values putting the ankle (Foot head) at `ankle` with the knee towards
    `pole` and the foot flat on the floor, turned out by `toe_out` degrees."""
    pre = "Left" if side > 0 else "Right"
    r_h, t_h = fk(p, "Hips")
    hip = r_h @ rig.head_of(pre + "UpLeg") + t_h
    t0 = (rig.tail_of(pre + "UpLeg") - rig.head_of(pre + "UpLeg")).normalized()
    s0 = (rig.tail_of(pre + "Leg") - rig.head_of(pre + "Leg")).normalized()
    l1 = (rig.tail_of(pre + "UpLeg") - rig.head_of(pre + "UpLeg")).length
    l2 = (rig.tail_of(pre + "Leg") - rig.head_of(pre + "Leg")).length
    knee, a = _two_bone(hip, Vector(ankle), l1, l2, pole)
    r_thigh = (r_h @ t0).rotation_difference((knee - hip).normalized()) @ r_h
    r_shin = (r_thigh @ s0).rotation_difference((a - knee).normalized()) @ r_thigh
    r_foot = Quaternion(Vector((0, 0, 1)), math.radians(toe_out * side))
    tw = _twist_angle(r_shin.inverted() @ r_foot, s0)
    r_shin = r_shin @ Quaternion(s0, tw * shin_twist)
    return {
        pre + "UpLeg": _val(r_h.inverted() @ r_thigh),
        pre + "Leg": _val(r_thigh.inverted() @ r_shin),
        pre + "Foot": _val(r_shin.inverted() @ r_foot),
    }


def look_at(p, target, neck_share=0.4, iters=4):
    """Return p with Neck/Head adjusted (added to) so the eyes aim at `target`."""
    p = dict(p)
    target = Vector(target)
    for _ in range(iters):
        r, t = fk(p, "Head")
        eye = r @ EYE_REST + t
        fwd = r @ FACE_REST
        want = (target - eye).normalized()
        d_pitch = math.degrees(math.asin(max(-1, min(1, fwd.z))) - math.asin(max(-1, min(1, want.z))))
        d_yaw = math.degrees(math.atan2(want.x, -want.y) - math.atan2(fwd.x, -fwd.y))
        p = merge(p, {"Neck": (d_pitch * neck_share, 0, d_yaw * neck_share),
                      "Head": (d_pitch * (1 - neck_share), 0, d_yaw * (1 - neck_share))})
    return p


def override(base, *parts):
    """Replace (not add) bone values: later dicts win. Use this, not merge(),
    to put SIT_TYPE_ARMS or other absolute arm sets onto SIT."""
    out = dict(base)
    for part in parts:
        out.update(part)
    return out


def _mirror_val(bone, val):
    return mirror({bone: val})[("Right" + bone[4:]) if bone.startswith("Left") else bone]


def left_thumb(fwd, inward, down, bend):
    """LeftHandThumb1/2 values from a direction in hand coordinates (along the
    hand, towards the thumb side, towards the palm) plus a Thumb2 bend towards
    the palm in degrees. mirror() gives the right thumb."""
    d0 = rig._arm_dir(1)
    n0 = rig._palm_normal(1)
    t0 = (rig.tail_of("LeftHandThumb1") - rig.head_of("LeftHandThumb1")).normalized()
    want = (d0 * fwd + Vector((0, -1, 0)) * inward + n0 * down).normalized()
    q1 = t0.rotation_difference(want)
    axis = t0.cross(q1.inverted() @ n0).normalized()
    return {"LeftHandThumb1": _val(q1), "LeftHandThumb2": _val(Quaternion(axis, math.radians(bend)))}


# --- SIT: body --------------------------------------------------------------
# Pelvis on the seat, hips joint slightly behind the seat centre (y +0.02).
SIT_HIPS = (0.0, 0.035, -0.39)  # Hips@ -> Hips joint at (0, 0.035, 0.57)
# Ankles (Foot heads), feet flat. Slightly asymmetric so the pose does not look
# mirrored: the right foot a little further forward and turned out more.
SIT_ANKLE_L = Vector((0.115, -0.29, 0.09))
SIT_ANKLE_R = Vector((-0.12, -0.32, 0.09))
SIT_TOE_OUT_L = 6.0
SIT_TOE_OUT_R = 9.0
SIT_KNEE_POLE = Vector((0.16, -1.0, 0.55))  # knees forward, slightly apart (left; x mirrored)

SIT_SPINE = {
    "Hips@": SIT_HIPS,
    # Leaning in to the desk happens mostly at the hip joint (the pelvis rolls
    # forward on the seat); the spine adds a gentle curve. Chest ~12 deg forward.
    "Hips": (3, 0, 0),
    "Spine": (2.5, 0, 0),
    "Spine1": (3, 0, 0),
    "Spine2": (3.5, 0, 0),
    # Neck/Head are then re-aimed at the centre monitor by look_at().
    "Neck": (3, 0, 0),
    "Head": (2, 0, 0),
}


def sit_legs(p):
    """Both legs for the seated feet, solved for the Hips of pose p."""
    legs = leg_ik(p, 1, SIT_ANKLE_L, SIT_KNEE_POLE, SIT_TOE_OUT_L)
    pole_r = Vector((-SIT_KNEE_POLE.x, SIT_KNEE_POLE.y, SIT_KNEE_POLE.z))
    legs.update(leg_ik(p, -1, SIT_ANKLE_R, pole_r, SIT_TOE_OUT_R))
    legs.update({"LeftToeBase": (0, 0, 0), "RightToeBase": (0, 0, 0)})
    return legs


# Hands resting on the thighs: forearms lie along the outer top of the thighs,
# the hands angle inward and the relaxed fingers drape over the inner curve.
THIGH_WRIST = Vector((0.148, -0.2, 0.64))  # left wrist; right is mirrored
_THIGH_FINGERS_L = merge({
    "LeftHandIndex1": (-2, 16, 0),
    "LeftHandIndex2": (0, 20, 0),
    "LeftHandMiddle1": (0, 18, 0),
    "LeftHandMiddle2": (0, 22, 0),
    "LeftHandRing1": (2, 20, 0),
    "LeftHandRing2": (0, 24, 0),
    "LeftHandPinky1": (4, 23, 0),
    "LeftHandPinky2": (0, 26, 0),
}, left_thumb(0.5, 0.6, 0.45, 15))


def thigh_arm(p, side, shoulder=(0, 2, 0), dw=(0, 0, 0)):
    """One arm (side +1 left / -1 right) with the hand resting on its thigh,
    solved for the spine of pose p. `shoulder` is given as a LEFT value and
    mirrored for the right arm; dw offsets the wrist (metres)."""
    pre = "Left" if side > 0 else "Right"
    s = joint(p, pre + "Arm")
    out = arm_ik(
        p, side, Vector((THIGH_WRIST.x * side, THIGH_WRIST.y, THIGH_WRIST.z)) + Vector(dw),
        pole=s + Vector((0.22 * side, 0.2, -0.4)),
        hand_fwd=(-0.55 * side, -0.8, -0.2),
        palm=(-0.2 * side, 0.05, -1.0),
        shoulder=shoulder if side > 0 else _mirror_val("LeftShoulder", shoulder),
    )
    out.update(_THIGH_FINGERS_L if side > 0 else mirror(_THIGH_FINGERS_L))
    return out


def thigh_arms(p, shoulder=(0, 2, 0)):
    """Both arms with the hands resting on the thighs (absolute values)."""
    return override(thigh_arm(p, 1, shoulder), thigh_arm(p, -1, shoulder))


# --- typing arms ------------------------------------------------------------
# Wrists float 5 cm above the desk just in front of the keyboard; the hand is
# arched (knuckles a little higher) and the fingers curve down onto the keys:
# palm centre y~-0.43, knuckles y~-0.46, fingertips y~-0.52..-0.53, z~0.775.
TYPE_WRIST = Vector((0.125, -0.385, 0.80))  # left wrist; right is mirrored
TYPE_HAND_FWD = Vector((-0.2, -1.0, 0.12))  # slight inward angle, knuckles up
TYPE_PALM = Vector((-0.22, 0.0, -1.0))  # palm down, thumb side a bit higher
TYPE_SHOULDER = (0, 1, -4)  # left clavicle slightly forward (mirrored)
_TYPE_FINGERS_L = merge({
    "LeftHandIndex1": (-3, 20, 0),
    "LeftHandIndex2": (0, 26, 0),
    "LeftHandMiddle1": (0, 22, 0),
    "LeftHandMiddle2": (0, 28, 0),
    "LeftHandRing1": (2, 23, 0),
    "LeftHandRing2": (0, 26, 0),
    "LeftHandPinky1": (5, 24, 0),
    "LeftHandPinky2": (0, 26, 0),
}, left_thumb(0.6, 0.55, 0.3, 12))


def type_arm(p, side, dw=(0, 0, 0)):
    """One arm (side +1 left / -1 right) with the hand on the keyboard, solved
    for the spine of pose p; dw offsets the wrist in metres (reaching for a
    key). Includes that hand's fingers."""
    wrist = Vector((TYPE_WRIST.x * side, TYPE_WRIST.y, TYPE_WRIST.z)) + Vector(dw)
    pre = "Left" if side > 0 else "Right"
    s = joint(p, pre + "Arm")
    out = arm_ik(
        p, side, wrist,
        pole=s + Vector((0.22 * side, 0.02, -0.5)),
        hand_fwd=(TYPE_HAND_FWD.x * side, TYPE_HAND_FWD.y, TYPE_HAND_FWD.z),
        palm=(TYPE_PALM.x * side, TYPE_PALM.y, TYPE_PALM.z),
        shoulder=TYPE_SHOULDER if side > 0 else _mirror_val("LeftShoulder", TYPE_SHOULDER),
    )
    out.update(_TYPE_FINGERS_L if side > 0 else mirror(_TYPE_FINGERS_L))
    return out


def type_arms(p, dl=(0, 0, 0), dr=(0, 0, 0)):
    """Both arms/hands/fingers on the keyboard (absolute values; apply with
    override()). Recompute per key with the clip's spine so the hands stay
    planted while the body breathes or sways."""
    return override(type_arm(p, 1, dl), type_arm(p, -1, dr))


# --- mouse arm (starting point for mouse clips) ------------------------------
# Right palm resting on the mouse (-0.30,-0.50,0.765; 6 x 10 x 3 cm), index and
# middle finger on the buttons, thumb along its inner side.
MOUSE_WRIST = Vector((-0.315, -0.41, 0.802))
MOUSE_HAND_FWD = Vector((0.03, -1.0, 0.0))
MOUSE_PALM = Vector((0.25, 0.0, -1.0))  # thumb side up ~14 deg
_MOUSE_FINGERS_L = merge({  # authored as left, mirrored onto the right hand
    "LeftHandIndex1": (-1, 6, 0),
    "LeftHandIndex2": (0, 10, 0),
    "LeftHandMiddle1": (0, 8, 0),
    "LeftHandMiddle2": (0, 12, 0),
    "LeftHandRing1": (2, 12, 0),
    "LeftHandRing2": (0, 15, 0),
    "LeftHandPinky1": (6, 20, 0),
    "LeftHandPinky2": (0, 26, 0),
}, left_thumb(0.9, 0.25, 0.35, 8))


def mouse_arm(p, dw=(0, 0, 0)):
    """Right arm/hand/fingers with the hand on the mouse, solved for the spine
    of pose p; dw moves the wrist (and so the mouse) in metres."""
    s = joint(p, "RightArm")
    out = arm_ik(
        p, -1, MOUSE_WRIST + Vector(dw),
        pole=s + Vector((-0.25, 0.05, -0.5)),
        hand_fwd=MOUSE_HAND_FWD,
        palm=MOUSE_PALM,
        shoulder=_mirror_val("LeftShoulder", (0, 1, -3)),
    )
    out.update(mirror(_MOUSE_FINGERS_L))
    return out


# --- assemble -----------------------------------------------------------------
def sit_pose(spine=None):
    """Full seated pose (legs solved, eyes on the centre monitor, hands on the
    thighs) for a spine dict, default SIT_SPINE. Clips that animate the spine
    should rebuild with this (or re-solve the parts) each key so the feet and
    hands stay planted."""
    p = dict(spine if spine is not None else SIT_SPINE)
    p.update(sit_legs(p))
    p = look_at(p, MONITOR)
    p.update(thigh_arms(p))
    return p


# SIT: complete seated base pose, hands on the thighs.
SIT = sit_pose()
# SIT_TYPE_ARMS: ABSOLUTE arm/hand/finger values for both hands on the keyboard.
# Put them on a seated pose with override(), not merge() (merge would add them
# to the thigh-rest arm angles). SIT_TYPE is the ready-made result.
SIT_TYPE_ARMS = type_arms(SIT)
SIT_TYPE = override(SIT, SIT_TYPE_ARMS)
# Right hand on the mouse (absolute values, use override()).
SIT_MOUSE_ARM = mouse_arm(SIT)
