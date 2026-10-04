import * as THREE from "three";

import { GLOW } from "@/features/hq/render/environment/palette";
import { councilSeats, COUNCIL_HEAD, COUNCIL_SCREEN_X } from "./councilLayout";
import { COUNCIL_SCREEN_H, COUNCIL_SCREEN_W } from "./councilScreenPaint";

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
  screenTexture.flipY = true;
  const screenMaterial = new THREE.MeshBasicMaterial({ map: screenTexture, toneMapped: false });
  screenMaterial.name = "council-screen-live";

  const table = findRoot(scene, "council_table");
  const chair = findRoot(scene, "council_chair");
  const headChair = findRoot(scene, "council_head_chair");
  const screen = findRoot(scene, "council_screen");

  if (table) group.add(cloneKind(table, screenMaterial, owned));
  if (headChair) {
    const head = cloneKind(headChair, screenMaterial, owned);
    head.position.set(COUNCIL_HEAD.x + 0.1, 0, COUNCIL_HEAD.z);
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

  return {
    group,
    screenCanvas,
    screenTexture,
    dispose() {
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
