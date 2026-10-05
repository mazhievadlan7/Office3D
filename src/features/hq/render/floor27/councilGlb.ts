import * as THREE from "three";

import { GLOW } from "@/features/hq/render/environment/palette";
import {
  councilSeats,
  COUNCIL_HEAD,
  COUNCIL_ROOM_EAST_X,
  COUNCIL_SCREEN_X,
} from "./councilLayout";
import { COUNCIL_SCREEN_H, COUNCIL_SCREEN_W } from "./councilScreenPaint";
import { buildCouncilWallArt } from "./councilWallArt";

/**
 * Builds the Floor 27 cabinet furniture from council.glb (blender/hq/council.py):
 * the long table at the origin, AM7's head chair, the 26 council chairs around
 * the table (one geometry instanced per seat), and the screen wall whose
 * "screen" surface is a live CanvasTexture the council paints per speaker.
 *
 * Plain surfaces are clamped to a satin finish (no white hotspots under the key
 * light) and the red emissive lines are pushed into bloom range, exactly as the
 * HQ props are treated (render/environment/props/propBatches.ts).
 */

export type CouncilFurniture = {
  group: THREE.Group;
  /** The canvas the screen samples; redraw it and set `texture.needsUpdate`. */
  screenCanvas: HTMLCanvasElement;
  screenTexture: THREE.CanvasTexture;
  dispose(): void;
};

function normalise(name: string): string {
  return name.toLowerCase().replace(/[\s-]+/g, "_").replace(/[._]\d{3}$/, "");
}

function findRoot(scene: THREE.Object3D, kind: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  scene.traverse((node) => {
    if (!found && normalise(node.name) === kind) found = node;
  });
  return found;
}

function treatMaterial(material: THREE.Material): THREE.Material {
  const m = material as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial) return material;
  const name = m.name.toLowerCase();
  const clone = m.clone();
  if (name.includes("emissive") || name.includes("led")) {
    if (clone.emissive && clone.emissive.getHex() !== 0) {
      clone.emissiveIntensity = Math.max(clone.emissiveIntensity ?? 1, GLOW.emissiveFloor);
    }
    clone.toneMapped = false;
  } else {
    clone.roughness = Math.max(clone.roughness, 0.55);
    clone.metalness = Math.min(clone.metalness, 0.6);
    clone.envMapIntensity = Math.min(clone.envMapIntensity ?? 1, 0.4);
  }
  return clone;
}

/** Clones a kind's node subtree, applying the material treatment, parented at origin. */
function cloneKind(root: THREE.Object3D, screenMaterial: THREE.Material, owned: THREE.Material[]): THREE.Object3D {
  const clone = root.clone(true);
  clone.position.set(0, 0, 0);
  clone.rotation.set(0, 0, 0);
  clone.scale.set(1, 1, 1);
  clone.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map((mat) => {
      const name = (mat?.name ?? "").toLowerCase();
      if (name.includes("screen")) return screenMaterial;
      const treated = treatMaterial(mat);
      if (treated !== mat) owned.push(treated);
      return treated;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
  return clone;
}

export function buildCouncilFurniture(scene: THREE.Object3D): CouncilFurniture {
  const group = new THREE.Group();
  group.name = "council-furniture";
  const owned: THREE.Material[] = [];

  // Live screen canvas + texture.
  const screenCanvas = document.createElement("canvas");
  screenCanvas.width = COUNCIL_SCREEN_W;
  screenCanvas.height = COUNCIL_SCREEN_H;
  const screenTexture = new THREE.CanvasTexture(screenCanvas);
  screenTexture.colorSpace = THREE.SRGBColorSpace;
  // GLB-exported UVs (council.py: v=0 at the bottom of the viewer) follow the
  // same convention as every other CanvasTexture mapped onto hall geometry
  // (skinBake, floorGlow, mapRig, HqArchive): flipY off, so the painted canvas
  // reads right-side up on the screen wall instead of upside down.
  screenTexture.flipY = false;
  const screenMaterial = new THREE.MeshBasicMaterial({ map: screenTexture, toneMapped: false });
  screenMaterial.name = "council-screen-live";

  const table = findRoot(scene, "council_table");
  const chair = findRoot(scene, "council_chair");
  const headChair = findRoot(scene, "council_head_chair");
  const screen = findRoot(scene, "council_screen");

  if (table) group.add(cloneKind(table, screenMaterial, owned));
  if (headChair) {
    const head = cloneKind(headChair, screenMaterial, owned);
    // Seat contract: the throne's origin is the seated root, so it sits exactly
    // at COUNCIL_HEAD — where AM7 sits — like every council chair at its seat.
    head.position.set(COUNCIL_HEAD.x, 0, COUNCIL_HEAD.z);
    head.rotation.y = COUNCIL_HEAD.rotY;
    group.add(head);
  }
  if (chair) {
    for (const seat of councilSeats()) {
      const c = cloneKind(chair, screenMaterial, owned);
      c.position.set(seat.x, 0, seat.z);
      c.rotation.y = seat.rotY;
      group.add(c);
    }
  }
  if (screen) {
    const wall = cloneKind(screen, screenMaterial, owned);
    wall.position.set(COUNCIL_SCREEN_X, 0, 0);
    wall.rotation.y = Math.PI / 2; // face +X, down the table toward the seats
    group.add(wall);
  }

  // Premium interior, placed deliberately. The formal back wall reads
  // [ герб ] [ screen ] [ portrait ], with the motto above; a tidy lounge sits
  // in the east corner (a sofa + two chairs round a low table facing a wall TV);
  // plants frame the formal wall and anchor the lounge, clear of the walkways.
  // Each piece is a named root in the GLB, cloned and placed; the TV's "screen"
  // surface mirrors the live council feed.
  const place = (kind: string, x: number, y: number, z: number, rotY: number): void => {
    const root = findRoot(scene, kind);
    if (!root) return;
    const node = cloneKind(root, screenMaterial, owned);
    node.position.set(x, y, z);
    node.rotation.y = rotY;
    group.add(node);
  };
  const HALF_PI = Math.PI / 2;
  // Back wall (behind the screen): the герб, MECHTATEL's portrait and the motto
  // are textured art panels (councilWallArt), mounted [ герб ][ screen ][ portrait ]
  // with the motto above — added to the furniture group so they share its lifetime.
  const wallArt = buildCouncilWallArt();
  group.add(wallArt.group);
  // Lounge in the east corner, a conversation group facing the wall TV.
  place("council_tv", COUNCIL_ROOM_EAST_X - 0.06, 0, 4.8, -HALF_PI); // on the east wall, facing −X
  place("council_sofa", 7.2, 0, 4.8, HALF_PI); // faces +X, toward the TV
  place("council_lounge_table", 8.3, 0, 4.8, 0);
  place("council_lounge_chair", 8.0, 0, 3.2, HALF_PI + 0.22);
  place("council_lounge_chair", 8.0, 0, 6.4, HALF_PI - 0.22);
  // Plants: two framing the formal wall in its back corners, one by the lounge.
  const backCornerX = COUNCIL_SCREEN_X - 0.5;
  place("council_plant", backCornerX, 0, 6.2, 0);
  place("council_plant", backCornerX, 0, -6.2, 0);
  place("council_plant", 6.3, 0, 6.6, 0);

  return {
    group,
    screenCanvas,
    screenTexture,
    dispose() {
      wallArt.dispose();
      screenTexture.dispose();
      screenMaterial.dispose();
      for (const m of owned) m.dispose();
      group.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry?.dispose();
      });
    },
  };
}
