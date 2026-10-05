import * as THREE from "three";

import {
  HQ_COUNCIL_EMBLEM_URL,
  HQ_COUNCIL_MOTTO_URL,
  HQ_COUNCIL_PORTRAIT_PLACEHOLDER_URL,
  HQ_COUNCIL_PORTRAIT_URL,
  HQ_THEME,
} from "@/features/hq/core/config";
import { COUNCIL_SCREEN_X } from "./councilLayout";

/**
 * Floor 27 back-wall art, mounted точь-в-точь from the reference artwork rather
 * than modelled: the МА emblem (герб) to the LEFT of the screen, MECHTATEL's
 * portrait to the RIGHT, and the motto panel above it. Each is a premium framed
 * panel — a dark beveled metal frame with a red emissive rim and slight depth —
 * carrying its art as a high-res texture on a flat, unlit (emissive-looking)
 * quad. The герб and motto ship in the repo; the portrait uses the owner's
 * likeness, so it loads from a .gitignored path and falls back to a neutral
 * placeholder when that file is absent.
 *
 * Built in the X–Z plane facing +Z; the whole group is turned to face +X (down
 * the table toward the seats), flush on the back wall behind the screen.
 */

export type CouncilWallArt = { group: THREE.Group; dispose(): void };

const BACK_WALL_X = COUNCIL_SCREEN_X - 1.1; // flush on the back wall, proud of it

type Panel = {
  mesh: THREE.Group;
  dispose(): void;
};

/** A framed, beveled, emissive art panel (facing +Z), its art set when it loads. */
function buildPanel(
  width: number,
  height: number,
  textures: readonly string[],
  owned: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[]; textures: THREE.Texture[] },
): Panel {
  const group = new THREE.Group();
  const frameMargin = 0.11;
  const depth = 0.16;

  const frameGeo = new THREE.BoxGeometry(width + 2 * frameMargin, height + 2 * frameMargin, depth);
  const frameMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(HQ_THEME.metal).multiplyScalar(0.5),
    roughness: 0.32,
    metalness: 0.85,
  });
  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.position.z = -depth / 2; // front face at z = 0
  frame.castShadow = false;
  frame.receiveShadow = true;

  // Red emissive rim peeking around the art, in bloom range (toneMapped off).
  const glowGeo = new THREE.PlaneGeometry(width + 0.09, height + 0.09);
  const glowMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(HQ_THEME.accent).multiplyScalar(1.6),
    toneMapped: false,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.position.z = 0.002;

  // The art itself: flat and unlit so the reference reads exactly, bright but
  // not blown out (kept tone-mapped so it never bloom-clips the room).
  const artGeo = new THREE.PlaneGeometry(width, height);
  const artMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1e });
  const art = new THREE.Mesh(artGeo, artMat);
  art.position.z = 0.006;

  group.add(frame, glow, art);

  owned.geometries.push(frameGeo, glowGeo, artGeo);
  owned.materials.push(frameMat, glowMat, artMat);

  // Load the art: the first url is the one to show; a second url (the private
  // portrait) replaces it once it loads, and a missing one is simply ignored.
  const loader = new THREE.TextureLoader();
  const apply = (texture: THREE.Texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const previous = artMat.map;
    artMat.map = texture;
    artMat.color.set(0xffffff);
    artMat.needsUpdate = true;
    owned.textures.push(texture);
    if (previous && previous !== texture) previous.dispose();
  };
  if (textures[0]) loader.load(textures[0], apply, undefined, () => {});
  if (textures[1]) loader.load(textures[1], apply, undefined, () => {});

  return {
    mesh: group,
    dispose() {
      group.clear();
    },
  };
}

export function buildCouncilWallArt(): CouncilWallArt {
  const group = new THREE.Group();
  group.name = "council-wall-art";
  const owned = {
    geometries: [] as THREE.BufferGeometry[],
    materials: [] as THREE.Material[],
    textures: [] as THREE.Texture[],
  };
  const panels: Panel[] = [];
  const HALF_PI = Math.PI / 2;

  const mount = (panel: Panel, y: number, z: number): void => {
    panel.mesh.position.set(BACK_WALL_X, y, z);
    panel.mesh.rotation.y = HALF_PI; // face +X, down the table
    group.add(panel.mesh);
    panels.push(panel);
  };

  // Viewer at the table faces −X: their LEFT is +Z, RIGHT is −Z.
  // герб — LEFT of the screen (reference aspect ≈ 0.875).
  mount(buildPanel(2.0, 2.3, [HQ_COUNCIL_EMBLEM_URL], owned), 2.0, 4.3);
  // MECHTATEL portrait — RIGHT of the screen (placeholder first, real likeness
  // from the .gitignored path if present). Aspect ≈ 0.766.
  mount(buildPanel(1.92, 2.5, [HQ_COUNCIL_PORTRAIT_PLACEHOLDER_URL, HQ_COUNCIL_PORTRAIT_URL], owned), 2.0, -4.3);
  // Motto — above the screen (reference aspect ≈ 1.51).
  mount(buildPanel(2.34, 1.55, [HQ_COUNCIL_MOTTO_URL], owned), 4.05, 0);

  return {
    group,
    dispose() {
      for (const panel of panels) panel.dispose();
      for (const g of owned.geometries) g.dispose();
      for (const m of owned.materials) m.dispose();
      for (const t of owned.textures) t.dispose();
      group.clear();
    },
  };
}
