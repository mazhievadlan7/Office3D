"""Skeleton for the Office3D hacker character.

Blender space: Z up, the character faces -Y, its left side is +X. Units are
metres and the origin is on the floor between the feet. Bone names follow the
Mixamo convention so motion-capture clips can be retargeted onto the rig later.

The rest pose is an A-pose (arms 50 degrees below horizontal, palms facing down
and in), which deforms better at the shoulders than a T-pose.
"""

import math

import bpy
from mathutils import Vector

ARM_DOWN_DEG = 50.0
UPPER_ARM = 0.28
FOREARM = 0.25
HAND = 0.085


def _arm_dir(side):
    a = math.radians(ARM_DOWN_DEG)
    return Vector((side * math.cos(a), 0.0, -math.sin(a)))


def _palm_normal(side):
    # Perpendicular to the arm inside the XZ plane, pointing down and inward.
    d = _arm_dir(side)
    n = Vector((-d.z * side, 0.0, d.x * side))
    if n.z > 0:
        n = -n
    return n.normalized()


def bone_table():
    """Return [(name, head, tail, parent, connect)] in parent-first order."""
    t = [
        ("Hips", (0, 0, 0.96), (0, 0, 1.06), None, False),
        ("Spine", (0, 0, 1.06), (0, 0, 1.18), "Hips", True),
        ("Spine1", (0, 0, 1.18), (0, 0, 1.30), "Spine", True),
        ("Spine2", (0, 0, 1.30), (0, 0.005, 1.445), "Spine1", True),
        ("Neck", (0, 0.005, 1.455), (0, 0.0, 1.565), "Spine2", False),
        ("Head", (0, 0.0, 1.565), (0, 0.0, 1.78), "Neck", True),
    ]
    for side, pre in ((1, "Left"), (-1, "Right")):
        d = _arm_dir(side)
        n = _palm_normal(side)
        sh_head = Vector((0.025 * side, 0.0, 1.41))
        sh_tail = Vector((0.165 * side, 0.01, 1.425))
        arm_tail = sh_tail + d * UPPER_ARM
        fore_tail = arm_tail + d * FOREARM
        hand_tail = fore_tail + d * HAND
        t += [
            (f"{pre}Shoulder", sh_head, sh_tail, "Spine2", False),
            (f"{pre}Arm", sh_tail, arm_tail, f"{pre}Shoulder", True),
            (f"{pre}ForeArm", arm_tail, fore_tail, f"{pre}Arm", True),
            (f"{pre}Hand", fore_tail, hand_tail, f"{pre}ForeArm", True),
        ]
        # Fingers spread along Y (index at the front, pinky at the back).
        for fname, off, l1, l2 in (
            ("Index", -0.027, 0.042, 0.034),
            ("Middle", -0.009, 0.046, 0.036),
            ("Ring", 0.009, 0.043, 0.033),
            ("Pinky", 0.026, 0.034, 0.027),
        ):
            base = hand_tail + Vector((0, off, 0)) - d * 0.004
            j1 = base + d * l1
            j2 = j1 + d * l2
            t += [
                (f"{pre}Hand{fname}1", base, j1, f"{pre}Hand", False),
                (f"{pre}Hand{fname}2", j1, j2, f"{pre}Hand{fname}1", True),
            ]
        tdir = (d * 0.45 + Vector((0, -0.8, 0)) + n * 0.35).normalized()
        tb = fore_tail + d * 0.022 + Vector((0, -0.028, 0)) + n * 0.012
        t1 = tb + tdir * 0.042
        t2 = t1 + tdir * 0.034
        t += [
            (f"{pre}HandThumb1", tb, t1, f"{pre}Hand", False),
            (f"{pre}HandThumb2", t1, t2, f"{pre}HandThumb1", True),
        ]
        x = 0.095 * side
        t += [
            (f"{pre}UpLeg", (x, 0, 0.93), (x, 0.0, 0.51), "Hips", False),
            (f"{pre}Leg", (x, 0, 0.51), (x, 0.025, 0.09), f"{pre}UpLeg", True),
            (f"{pre}Foot", (x, 0.025, 0.09), (x, -0.095, 0.03), f"{pre}Leg", True),
            (f"{pre}ToeBase", (x, -0.095, 0.03), (x, -0.165, 0.03), f"{pre}Foot", True),
        ]
    return [(n, Vector(h), Vector(tl), p, c) for n, h, tl, p, c in t]


BONES = bone_table()
BONE = {b[0]: b for b in BONES}


def head_of(name):
    return BONE[name][1].copy()


def tail_of(name):
    return BONE[name][2].copy()


def build_armature(name="HackerRig"):
    data = bpy.data.armatures.new(name)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for bname, head, tail, parent, connect in BONES:
        eb = data.edit_bones.new(bname)
        eb.head = head
        eb.tail = tail
        # A stable roll: bone Z axis points toward the character's front.
        eb.align_roll(Vector((0, -1, 0)) if abs((tail - head).normalized().y) < 0.9 else Vector((0, 0, 1)))
        if parent:
            eb.parent = data.edit_bones[parent]
            eb.use_connect = connect
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in obj.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return obj
