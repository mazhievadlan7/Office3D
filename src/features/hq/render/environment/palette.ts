import * as THREE from "three";

/** Room shell dimensions (metres). */
export const WALL_THICKNESS = 0.25;
export const CURB_HEIGHT = 0.25;
export const ENTRANCE_WIDTH = 3.2;
export const FLOOR_TILE = 1.2;

/**
 * The emissive lines along the tall walls (and the video wall's case): the
 * top line's centre this far under the top, the skirt line's this high, each
 * this tall.
 */
export const WALL_LINE = { belowTop: 0.13, skirt: 0.11, height: 0.025 } as const;

/**
 * Emissive multipliers in linear space. Bloom only picks up values well above
 * 1, and saturated red carries a fifth of white's luminance, so red light has to be
 * pushed much harder than a white light would be.
 */
export const GLOW = {
  line: 6,
  curb: 3.2,
  faint: 1.6,
  led: 7,
  warm: 2.4,
  screen: 1.6,
  /** Minimum emissiveIntensity for emissive materials coming from props.glb. */
  emissiveFloor: 5,
} as const;

/** A theme colour in the linear working space, optionally pushed above 1. */
export function themeColor(hex: string, intensity = 1): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(intensity);
}

