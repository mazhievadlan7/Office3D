"""Posing and keyframing helpers.

Poses are written as rotations about the ARMATURE axes of the rest pose,
applied in each bone's own (parent-relative) frame. Axes, with the character
facing -Y:

  X (points to the character's left)  pitch
      +X leans an upward bone forward (spine bows, head nods down) and swings
      a downward bone BACKWARD (thigh back, arm back). Knee bend is +X,
      elbow bend is -X, toes down is +X.
  Y (points backward)                  roll
      +Y tilts an upward bone toward the character's left. For a hanging
      LEFT arm +Y moves it toward the body; for the RIGHT arm -Y does.
  Z (points up)                        yaw
      +Z turns the bone toward the character's left.

A value is (rx, ry, rz) or (rx, ry, rz, twist) in degrees; twist spins the
bone about its own length axis. "Hips@" is the hips offset in metres
(x = left, y = back, z = up).
"""

import math

from mathutils import Euler, Quaternion, Vector

try:
    from bpy_extras import anim_utils
except ImportError:  # pragma: no cover
    anim_utils = None


def local_quat(pb, value):
    rx, ry, rz = value[0], value[1], value[2]
    twist = value[3] if len(value) > 3 else 0.0
    bq = pb.bone.matrix_local.to_quaternion()
    q = Euler((math.radians(rx), math.radians(ry), math.radians(rz)), "XYZ").to_quaternion()
    if twist:
        axis = (pb.bone.matrix_local.to_3x3() @ Vector((0, 1, 0))).normalized()
        q = q @ Quaternion(axis, math.radians(twist))
    return bq.inverted() @ q @ bq


def mirror(pose):
    """Swap Left/Right and mirror the rotations across the YZ plane."""
    out = {}
    for name, val in pose.items():
        if name == "Hips@":
            out[name] = (-val[0], val[1], val[2])
            continue
        if name.startswith("Left"):
            other = "Right" + name[4:]
        elif name.startswith("Right"):
            other = "Left" + name[5:]
        else:
            other = name
        rx, ry, rz = val[0], val[1], val[2]
        tw = val[3] if len(val) > 3 else 0.0
        out[other] = (rx, -ry, -rz, -tw)
    return out


def blend(a, b, t):
    keys = set(a) | set(b)
    out = {}
    for k in keys:
        va = a.get(k, (0, 0, 0, 0))
        vb = b.get(k, (0, 0, 0, 0))
        va = tuple(va) + (0,) * (4 - len(va)) if k != "Hips@" else tuple(va)
        vb = tuple(vb) + (0,) * (4 - len(vb)) if k != "Hips@" else tuple(vb)
        out[k] = tuple(x * (1 - t) + y * t for x, y in zip(va, vb))
    return out


def merge(*poses):
    """Later poses add to earlier ones (component-wise sum)."""
    out = {}
    for p in poses:
        for k, v in p.items():
            if k in out:
                cur = out[k]
                n = max(len(cur), len(v))
                cur = tuple(cur) + (0,) * (n - len(cur))
                vv = tuple(v) + (0,) * (n - len(v))
                out[k] = tuple(x + y for x, y in zip(cur, vv))
            else:
                out[k] = tuple(v)
    return out


class Animator:
    def __init__(self, arm_obj):
        self.arm = arm_obj
        self._last = {}

    def begin(self, name, frames, cyclic=True):
        import bpy

        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        if self.arm.animation_data is None:
            self.arm.animation_data_create()
        self.arm.animation_data.action = act
        act.use_frame_range = True
        act.frame_start = 0
        act.frame_end = frames
        try:
            act.use_cyclic = cyclic
        except AttributeError:
            pass
        self.action = act
        self.frames = frames
        self.cyclic = cyclic
        self._last = {}
        return act

    def apply(self, pose):
        for pb in self.arm.pose.bones:
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = (1, 0, 0, 0)
            pb.location = (0, 0, 0)
        for name, val in pose.items():
            if name == "Hips@":
                pb = self.arm.pose.bones["Hips"]
                bq = pb.bone.matrix_local.to_quaternion()
                pb.location = bq.inverted() @ Vector(val)
                continue
            pb = self.arm.pose.bones.get(name)
            if pb is None:
                raise KeyError(f"unknown bone {name}")
            pb.rotation_quaternion = local_quat(pb, val)

    def key(self, frame, pose):
        self.apply(pose)
        for pb in self.arm.pose.bones:
            q = pb.rotation_quaternion.copy()
            last = self._last.get(pb.name)
            if last is not None and last.dot(q) < 0:
                q.negate()
                pb.rotation_quaternion = q
            self._last[pb.name] = q.copy()
            pb.keyframe_insert("rotation_quaternion", frame=frame, group=pb.name)
        self.arm.pose.bones["Hips"].keyframe_insert("location", frame=frame, group="Hips")

    def fcurves(self):
        act = self.action
        if hasattr(act, "fcurves") and len(getattr(act, "layers", [])) == 0:
            return list(act.fcurves)
        slot = self.arm.animation_data.action_slot
        cb = anim_utils.action_get_channelbag_for_slot(act, slot)
        return list(cb.fcurves) if cb else []

    def finish(self):
        for fc in self.fcurves():
            if self.cyclic:
                fc.modifiers.new("CYCLES")
            for kp in fc.keyframe_points:
                kp.interpolation = "BEZIER"
                kp.handle_left_type = "AUTO_CLAMPED"
                kp.handle_right_type = "AUTO_CLAMPED"
            fc.update()


def cyc(frames):
    """Helper for cyclic key times: returns fn(phase 0..1) -> frame."""
    return lambda ph: round((ph % 1.0) * frames) if ph % 1.0 else 0
