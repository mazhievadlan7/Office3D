import { HQ_CLIPS, HQ_CLIP_INFO, type HqClipName } from "@/features/hq/core/config";

/**
 * Which animation actually plays each HqClip code.
 *
 * The character GLB is produced in parallel and may ship only some clips, so
 * a missing clip borrows the closest pose that exists instead of erroring:
 * a seated clip prefers another seated clip, Run and Push prefer Walk,
 * Present prefers Talk, and everything ends at Idle. Pure so it can be tested
 * without three.js.
 */
const CLIP_FALLBACKS: Record<HqClipName, readonly HqClipName[]> = {
  Idle: [],
  Walk: ["Idle"],
  Run: ["Walk", "Idle"],
  SitDown: ["SitIdle", "SitType", "Idle"],
  SitType: ["SitIdle", "Idle"],
  SitIdle: ["SitType", "Idle"],
  Talk: ["Idle"],
  Present: ["Talk", "Idle"],
  Push: ["Walk", "Idle"],
};

export const HQ_CLIP_COUNT = HQ_CLIPS.length;

/** AM7 is drawn slightly larger than everyone else. */
export const HQ_LEAD_SCALE = 1.04;

/** 1 per HqClip code played sitting (HQ_CLIP_INFO[...].seated). */
const SEATED = Uint8Array.from(HQ_CLIPS, (name) => (HQ_CLIP_INFO[name].seated ? 1 : 0));

/** Seated clips, used for label height, capsule height and blob size. */
export function isSeatedClip(code: number): boolean {
  return SEATED[code] === 1;
}

/** Blender exports actions as "Idle" or "Armature|Idle"; compare the last part, case-insensitively. */
function canonicalName(name: string): string {
  const bar = name.lastIndexOf("|");
  return (bar >= 0 ? name.slice(bar + 1) : name).trim().toLowerCase();
}

/**
 * For every HqClip code, the index into `available` of the clip that plays
 * it. Returns -1 for every code only when `available` is empty (the caller
 * then shows the rest pose). When not even Idle exists the first clip in the
 * file stands in for everything.
 */
export function resolveClipSources(available: readonly string[]): Int8Array {
  const out = new Int8Array(HQ_CLIP_COUNT).fill(-1);
  if (available.length === 0) return out;
  const byName = new Map<string, number>();
  available.forEach((name, index) => {
    const key = canonicalName(name);
    if (!byName.has(key)) byName.set(key, index);
  });
  const find = (name: HqClipName) => byName.get(name.toLowerCase()) ?? -1;
  for (let code = 0; code < HQ_CLIP_COUNT; code += 1) {
    const name = HQ_CLIPS[code];
    let source = find(name);
    for (const fallback of CLIP_FALLBACKS[name]) {
      if (source >= 0) break;
      source = find(fallback);
    }
    out[code] = source >= 0 ? source : 0;
  }
  return out;
}

/** Whether a clip from the file loops; unknown names loop, like Idle. */
export function isLoopingClipName(name: string): boolean {
  const key = canonicalName(name);
  const known = HQ_CLIPS.find((clip) => clip.toLowerCase() === key);
  return known ? HQ_CLIP_INFO[known].loop : true;
}
