import * as THREE from "three";

// A 72 x 32 land mask of the world (equirectangular, longitude -180..180,
// latitude 84..-58 so Antarctica is cropped), one bit per cell, row 0 = north.
// Rasterised offline from world-atlas land-110m with 3x3 supersampling. The
// centre monitor draws it as a dotted map; a baked mask keeps that to one tiny
// texture instead of loading and projecting TopoJSON per desk.
export const WORLD_MASK_WIDTH = 72;
export const WORLD_MASK_HEIGHT = 32;

const WORLD_MASK_BASE64 =
  "AAD+/wAAAAAAAIDO/4AAgAMAAHgd/gCA8D8A/v///38wBAAA+P9vjuH/////OP8xAOD+//8XAP7/AOj///8IAPz/Afj///8B" +
  "APh/APj///8AAPg/ANz3/z8BAPgfAAz+/y8AAPAPAHz4/08AAOAJAPz//w8AAMABAP7//g8AAIAFAP7/nAMAAAAGAP4/iAMA" +
  "AABgAP4/CAIAAADwAfw/AAAAAADwA8AfAA0AAADwB8APAIUAAADwH8APAAABAADwH4APAEAAAADgD8AvAOABAADAD8AnAPgD" +
  "AADAB4AHAPgHAADAA4ADAPgHAADAAQABAJgDAADgAAAAAAADAABgAAAAAAACAABgAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAA";

/** One byte per cell (255 = land), row 0 = north. */
export function decodeWorldMask(): Uint8Array {
  const binary = atob(WORLD_MASK_BASE64);
  const cells = new Uint8Array(WORLD_MASK_WIDTH * WORLD_MASK_HEIGHT);
  for (let i = 0; i < cells.length; i += 1) {
    const byte = binary.charCodeAt(i >> 3);
    cells[i] = (byte >> (i & 7)) & 1 ? 255 : 0;
  }
  return cells;
}

/**
 * Texture row r holds mask row r (north first), so the shader samples it with
 * v = (rowFromTop + 0.5) / height.
 */
export function createWorldMaskTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    decodeWorldMask(),
    WORLD_MASK_WIDTH,
    WORLD_MASK_HEIGHT,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
