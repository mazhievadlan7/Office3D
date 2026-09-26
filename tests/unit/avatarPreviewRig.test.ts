import { describe, expect, it, vi } from "vitest";
import {
  AnimationClip,
  Bone,
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Texture,
  Uint16BufferAttribute,
  type Object3D,
} from "three";
import {
  HqPreviewRig,
  PREVIEW_FRAME,
  createRadialTexture,
  previewCameraDistance,
  previewPhase,
} from "@/features/agents/components/avatarPreview/previewRig";

const turn = (name: string, axis: "x" | "y") =>
  new AnimationClip(name, 1, [
    new QuaternionKeyframeTrack(
      "Head.quaternion",
      [0, 1],
      axis === "y" ? [0, 0, 0, 1, 0, 0.3827, 0, 0.9239] : [0, 0, 0, 1, 0.3827, 0, 0, 0.9239],
    ),
  ]);

/** A two-bone stand-in for the HQ character GLB, plus a helper mesh. */
function buildCharacter() {
  const scene = new Group();
  const hips = new Bone();
  hips.name = "Hips";
  const head = new Bone();
  head.name = "Head";
  head.position.y = 1;
  hips.add(head);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0.1, 0, 0], 3));
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const map = new Texture();
  const orm = new Texture();
  const material = new MeshStandardMaterial({ map, roughnessMap: orm, metalnessMap: orm });
  const mesh = new SkinnedMesh(geometry, material);
  mesh.add(hips);
  mesh.bind(new Skeleton([hips, head]));
  scene.add(mesh);
  const helper = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  scene.add(helper);
  // Blender-style names; Talk is missing and falls back to Idle, as in the HQ.
  const animations = [turn("Armature|Idle", "y"), turn("Walk", "x")];
  return { scene, mesh, geometry, material, map, orm, helper, animations };
}

function findNamed(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((node) => {
    if (!found && node.name === name) found = node;
  });
  return found;
}

describe("previewCameraDistance", () => {
  it("fits the standing figure's height in a wide viewport", () => {
    const distance = previewCameraDistance(2, 30);
    expect(distance).toBeCloseTo(PREVIEW_FRAME.halfHeight / Math.tan((15 * Math.PI) / 180), 5);
  });

  it("backs off for narrow viewports so the arms stay in frame", () => {
    const wide = previewCameraDistance(1, 30);
    const narrow = previewCameraDistance(0.3, 30);
    expect(narrow).toBeGreaterThan(wide);
    const halfWidth = narrow * Math.tan((15 * Math.PI) / 180) * 0.3;
    expect(halfWidth).toBeCloseTo(PREVIEW_FRAME.halfWidth, 5);
  });

  it("treats a missing size as square", () => {
    expect(previewCameraDistance(Number.NaN, 30)).toBe(previewCameraDistance(1, 30));
    expect(previewCameraDistance(0, 30)).toBe(previewCameraDistance(1, 30));
  });
});

describe("previewPhase", () => {
  it("is stable per seed, in [0, 1), and differs between seeds", () => {
    const a = previewPhase("agent-a");
    expect(previewPhase("agent-a")).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(previewPhase("agent-b")).not.toBe(a);
  });
});

describe("HqPreviewRig", () => {
  it("returns null when the file has no skinned mesh", () => {
    const scene = new Group();
    scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    expect(HqPreviewRig.create({ scene, animations: [] }, "seed")).toBeNull();
  });

  it("draws the cached data through private objects and leaves the source untouched", () => {
    const source = buildCharacter();
    const rig = HqPreviewRig.create(source, "seed");
    expect(rig).not.toBeNull();
    if (!rig) return;

    // The source (the HQ's cached GLTF) keeps its own objects.
    expect(source.mesh.geometry).toBe(source.geometry);
    expect(source.mesh.material).toBe(source.material);

    // Geometry: a new wrapper over the very same attributes (no copy).
    expect(rig.mesh.geometry).not.toBe(source.geometry);
    expect(rig.mesh.geometry.getAttribute("position")).toBe(source.geometry.getAttribute("position"));
    expect(rig.mesh.geometry.getAttribute("skinIndex")).toBe(source.geometry.getAttribute("skinIndex"));

    // Material: a copy whose textures are clones sharing the decoded image;
    // one clone per original even when two slots use it.
    const material = rig.mesh.material as MeshStandardMaterial;
    expect(material).not.toBe(source.material);
    expect(material.map).not.toBe(source.map);
    expect(material.map?.source).toBe(source.map.source);
    expect(material.roughnessMap).not.toBe(source.orm);
    expect(material.roughnessMap).toBe(material.metalnessMap);

    // Only the skinned body draws.
    const helper = rig.root.children.find((child) => (child as Mesh).isMesh && !(child as SkinnedMesh).isSkinnedMesh);
    expect(helper?.visible).toBe(false);
  });

  it("disposes only its own objects", () => {
    const source = buildCharacter();
    const rig = HqPreviewRig.create(source, "seed");
    if (!rig) throw new Error("no rig");
    const material = rig.mesh.material as MeshStandardMaterial;
    const cloneMap = material.map as Texture;
    const shared = [source.geometry, source.material, source.map, source.orm];
    const sharedDisposed = shared.map((object) => {
      const spy = vi.fn();
      object.addEventListener("dispose", spy);
      return spy;
    });
    const ownDisposed = vi.fn();
    cloneMap.addEventListener("dispose", ownDisposed);
    const parent = new Group();
    parent.add(rig.root);

    rig.dispose();

    for (const spy of sharedDisposed) expect(spy).not.toHaveBeenCalled();
    expect(ownDisposed).toHaveBeenCalledTimes(1);
    expect(rig.root.parent).toBeNull();
  });

  it("plays the HQ clips, falling back like the HQ when one is missing", () => {
    const source = buildCharacter();
    const rig = HqPreviewRig.create(source, "seed");
    if (!rig) throw new Error("no rig");
    const head = findNamed(rig.root, "Head");
    if (!head) throw new Error("no head");

    rig.play("Idle");
    rig.update(0.25);
    // Idle turns the head about Y.
    expect(Math.abs(head.quaternion.y)).toBeGreaterThan(0.01);
    expect(Math.abs(head.quaternion.x)).toBeLessThan(1e-6);

    // Talk is not in the file: it resolves to Idle, so nothing changes.
    const before = head.quaternion.clone();
    rig.play("Talk");
    rig.update(0);
    expect(head.quaternion.equals(before)).toBe(true);

    // Walk crossfades in and, once the fade is over, owns the pose.
    rig.play("Walk");
    rig.update(0.5);
    rig.update(0.25);
    expect(Math.abs(head.quaternion.x)).toBeGreaterThan(0.01);
    rig.dispose();
  });
});

describe("createRadialTexture", () => {
  it("is bright in the middle and dark at the edge, in the channel alpha maps read", () => {
    const size = 16;
    const texture = createRadialTexture(size);
    const data = texture.image.data as Uint8Array;
    const green = (x: number, y: number) => data[(y * size + x) * 4 + 1];
    expect(green(size / 2, size / 2)).toBeGreaterThan(200);
    expect(green(0, 0)).toBe(0);
    expect(data[3]).toBe(255);
    texture.dispose();
  });
});
