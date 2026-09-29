"""Talking with the neighbour on the right, seated (SitTurnR): SitTurnL
mirrored (pose.mirror), 144 frames, the same intro / HOLD 16-128 / outro and
the same talk (16-72) and listen (72-128) halves.

The upper body is mirrored; the legs are solved again for the mirrored
pelvis with the ordinary seated stance, so the feet do not swap places
when the app crossfades in from SitType or SitIdle. The first and last
frames are SitIdle's frame 0 itself (not mirrored).
"""

import _base as B
import _seat as S
import sit_turn_l as L
from pose import mirror

NAME = "SitTurnR"
FRAMES = L.FRAMES
CYCLIC = False
N = FRAMES
HOLD = L.HOLD
TALK = L.TALK


def pose_at(f):
    src = L.raw_pose_at(f)
    e = L.ENDS(f)
    p = mirror({k: v for k, v in src.items() if not k.endswith(("UpLeg", "Leg", "Foot", "ToeBase"))})
    p.update(B.sit_legs(p))
    if e > 0:
        p = S.lerp_pose(p, S.base_idle(), e)
    return p


def build(anim):
    for f in S.key_frames(N, 2, [int(k) for k, _ in L.LEFT.keys] + L.NOD.frames()):
        anim.key(f, S.base_idle() if f in (0, N) else pose_at(f))
