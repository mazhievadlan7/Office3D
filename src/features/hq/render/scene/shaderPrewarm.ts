import {
  BackSide,
  DoubleSide,
  FrontSide,
  Group,
  HalfFloatType,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  Scene,
  VSMShadowMap,
  WebGLRenderTarget,
  type Camera,
  type Light,
  type Material,
  type Mesh,
  type Object3D,
  type Plane,
  type Side,
  type Texture,
  type WebGLRenderer,
} from "three";

/**
 * Shader programs compiled ahead of their first draw, exactly as the frame
 * will ask for them, so the driver builds them in parallel
 * (KHR_parallel_shader_compile) instead of the frame waiting on each.
 *
 * three.js keys a program by everything that changes its source. Three of
 * those inputs are easy to get wrong when compiling ahead:
 *
 * - The bound render target. The HQ draws its scene into the post chain's
 *   buffer, so every program is built for linear output. Compiled while the
 *   canvas is bound (renderer.compile outside a frame) it is the sRGB-output
 *   twin: a program nothing draws with, and the frame compiles its own anyway.
 *   Everything here compiles with a render target bound.
 * - The shadow pass. Casters are drawn with a depth material whose variant
 *   (skinned, instanced, which side, alpha/colour map) renderer.compile never
 *   sees. Each caster gets a stand-in with the same depth material the shadow
 *   pass builds (WebGLShadowMap.getDepthMaterial), compiled with that pass's
 *   scene state (no fog, no environment).
 * - Objects outside the scene graph, e.g. a pass that renders its own scene
 *   into a target (compilePassAhead).
 *
 * Nothing is drawn: compile() only creates the programs. programsReady()
 * tells, without blocking, when they are all built.
 */

const SHADOW_SIDE: Record<Side, Side> = { [FrontSide]: BackSide, [BackSide]: FrontSide, [DoubleSide]: DoubleSide };

/** The fields WebGLShadowMap copies from a caster's material onto its depth material. */
type ShadowSource = Material & {
  shadowSide: Side | null;
  map?: Texture | null;
  alphaMap?: Texture | null;
  displacementMap?: Texture | null;
  displacementScale?: number;
  displacementBias?: number;
  wireframe?: boolean;
  wireframeLinewidth?: number;
  linewidth?: number;
};

type DepthTwin = MeshDepthMaterial | MeshDistanceMaterial;

const targets = new WeakMap<WebGLRenderer, WebGLRenderTarget>();
/** Depth-pass stand-ins per source material ([depth, distance]); they live as long as the source. */
const twins = new WeakMap<Material, [DepthTwin | null, DepthTwin | null]>();

type ReadyProgram = { isReady?: () => boolean };

function isDrawable(object: Object3D): boolean {
  const o = object as Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
  return o.isMesh === true || o.isLine === true || o.isPoints === true || o.isSprite === true;
}

/**
 * A stand-in that reads everything (geometry, instancing, skinning, flags)
 * from `object` but draws with `material` and has no children, so the
 * compile sees exactly this draw and nothing below it (no lights counted twice).
 */
function standIn(object: Object3D, material: Material | Material[]): Object3D {
  const proxy = Object.create(object) as Object3D;
  // Own data properties: a class may define `material` as an accessor (troika Text).
  Object.defineProperty(proxy, "material", { value: material, writable: true, configurable: true });
  Object.defineProperty(proxy, "children", { value: [], writable: true, configurable: true });
  return proxy;
}

function holderOf(children: Object3D[]): Group {
  const holder = new Group();
  // Not add(): that would take each stand-in's parent over.
  holder.children = children;
  return holder;
}

/** Runs `compile` with a render target bound, as inside the frame. */
function withTarget(renderer: WebGLRenderer, compile: () => void): void {
  let target = targets.get(renderer);
  if (!target) {
    target = new WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
    target.texture.name = "hq-shader-prewarm";
    targets.set(renderer, target);
  }
  const previous = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace();
  const level = renderer.getActiveMipmapLevel();
  renderer.setRenderTarget(target);
  try {
    compile();
  } finally {
    renderer.setRenderTarget(previous, face, level);
  }
}

/** The depth (or, for point lights, distance) material the shadow pass draws `material` with. */
function depthTwin(renderer: WebGLRenderer, object: Object3D, material: Material, point: boolean): Material {
  const custom = point ? object.customDistanceMaterial : object.customDepthMaterial;
  if (custom) return custom;
  let pair = twins.get(material);
  if (!pair) {
    pair = [null, null];
    twins.set(material, pair);
    const dispose = () => {
      material.removeEventListener("dispose", dispose);
      pair?.[0]?.dispose();
      pair?.[1]?.dispose();
    };
    material.addEventListener("dispose", dispose);
  }
  const slot = point ? 1 : 0;
  const twin = pair[slot] ?? (pair[slot] = point ? new MeshDistanceMaterial() : new MeshDepthMaterial());
  const src = material as ShadowSource;
  const vsm = renderer.shadowMap.type === VSMShadowMap;
  twin.side = src.shadowSide ?? (vsm ? src.side : SHADOW_SIDE[src.side]);
  twin.alphaMap = src.alphaMap ?? null;
  twin.alphaTest = src.alphaToCoverage ? 0.5 : src.alphaTest;
  twin.map = src.map ?? null;
  twin.clipShadows = src.clipShadows;
  twin.clippingPlanes = src.clippingPlanes as Plane[];
  twin.clipIntersection = src.clipIntersection;
  twin.displacementMap = src.displacementMap ?? null;
  twin.displacementScale = src.displacementScale ?? 1;
  twin.displacementBias = src.displacementBias ?? 0;
  // Set on either kind by the shadow pass (MeshDistanceMaterial just does not declare it).
  (twin as MeshDepthMaterial).wireframe = src.wireframe ?? false;
  if (!point) (twin as MeshDepthMaterial).wireframeLinewidth = src.wireframeLinewidth ?? 1;
  return twin;
}

/** Whether the scene has a light that renders a shadow map ([any non-point, any point]). */
export function shadowLights(scene: Scene, camera: Camera): [boolean, boolean] {
  let depth = false;
  let distance = false;
  scene.traverseVisible((object) => {
    const light = object as Light & { isPointLight?: boolean };
    if (!light.isLight || !light.castShadow || !light.layers.test(camera.layers)) return;
    if (light.isPointLight) distance = true;
    else depth = true;
  });
  return [depth, distance];
}

/**
 * Starts compiling every program the objects under `roots` draw with: their
 * own materials in the main pass and, for shadow casters, the shadow pass.
 * `scene` supplies the lights, fog and environment the frame will use;
 * `shadows` is shadowLights(scene, camera) when the caller already has it.
 * Returns at once; see programsReady().
 */
export function compileAhead(
  renderer: WebGLRenderer,
  roots: Iterable<Object3D>,
  camera: Camera,
  scene: Scene,
  shadows?: readonly [boolean, boolean],
): void {
  const drawn: Object3D[] = [];
  const casters: Object3D[] = [];
  const seen = new Set<Object3D>();
  for (const root of roots) {
    root.traverse((object) => {
      if (seen.has(object) || !isDrawable(object)) return;
      seen.add(object);
      const material = (object as Mesh).material;
      if (!material) return;
      drawn.push(standIn(object, material));
      if (object.castShadow) casters.push(object);
    });
  }
  if (drawn.length === 0) return;
  const [depth, distance] =
    renderer.shadowMap.enabled && casters.length > 0 ? (shadows ?? shadowLights(scene, camera)) : [false, false];
  withTarget(renderer, () => {
    renderer.compile(holderOf(drawn), camera, scene);
    if (!depth && !distance) return;
    const shadowDraws: Object3D[] = [];
    for (const object of casters) {
      const material = (object as Mesh).material;
      const list = Array.isArray(material) ? material : [material];
      for (const point of [false, true]) {
        if (point ? !distance : !depth) continue;
        const mapped = list.map((m) => depthTwin(renderer, object, m, point));
        shadowDraws.push(standIn(object, Array.isArray(material) ? mapped : mapped[0]));
      }
    }
    // The shadow pass draws with an empty scene (no fog) but the frame's lights.
    const fog = scene.fog;
    scene.fog = null;
    try {
      renderer.compile(holderOf(shadowDraws), camera, scene);
    } finally {
      scene.fog = fog;
    }
  });
}

/** Starts compiling a pass that renders its own scene into a render target. */
export function compilePassAhead(renderer: WebGLRenderer, passScene: Scene, camera: Camera): void {
  withTarget(renderer, () => {
    renderer.compile(passScene, camera);
  });
}

/** Whether every program the renderer has created is built; never waits for the driver. */
export function programsReady(renderer: WebGLRenderer): boolean {
  const programs = renderer.info.programs;
  if (!programs) return true;
  for (const program of programs) {
    const ready = (program as unknown as ReadyProgram).isReady;
    if (ready && !ready.call(program)) return false;
  }
  return true;
}

/** Programs whose uniforms and attributes three has already read. */
const touched = new WeakSet<object>();

/**
 * Reads the uniforms and attributes of every program that has finished
 * building and was not read yet. three does this on a program's first draw,
 * and each read is a round trip that waits for everything the GPU process
 * still has queued: inside a frame, behind that frame's first uploads and
 * draws, a first draw waited 5-30 ms for work that was not its own. Done at
 * the top of the gate's turn, the queue is short and the draw finds it done.
 */
export function readReadyPrograms(renderer: WebGLRenderer): void {
  const programs = renderer.info.programs;
  if (!programs) return;
  for (const program of programs) {
    if (touched.has(program)) continue;
    const p = program as unknown as ReadyProgram & { getUniforms?: () => unknown; getAttributes?: () => unknown };
    if (p.isReady && !p.isReady()) continue;
    p.getUniforms?.();
    p.getAttributes?.();
    touched.add(program);
  }
}

/** Frees the render target compileAhead binds (the renderer is going away). */
export function disposePrewarm(renderer: WebGLRenderer): void {
  targets.get(renderer)?.dispose();
  targets.delete(renderer);
}

// ---------------------------------------------------------------------------
// Full-screen passes (the post chain)

/** How deep the pass walk looks for materials (pass → effect → sub-pass → quad → material). */
const PASS_WALK_DEPTH = 6;

type Walkable = Record<string, unknown> & {
  isMaterial?: boolean;
  isMesh?: boolean;
  isScene?: boolean;
  isCamera?: boolean;
  isTexture?: boolean;
  isWebGLRenderer?: boolean;
  isRenderTarget?: boolean;
  isBufferGeometry?: boolean;
};

/**
 * Collects the materials a full-screen pass draws with, and the quads it
 * draws them on. Passes keep them in their own fields (the screen quad, sub-
 * passes, effects, helper quads), so the walk follows plain fields a few
 * levels deep and never enters a scene (the render pass holds the HQ scene),
 * a camera, a renderer, a texture or a render target.
 */
function collectPassDraws(
  value: unknown,
  depth: number,
  seen: Set<object>,
  meshes: Map<Material, Mesh>,
  loose: Set<Material>,
): void {
  if (!value || typeof value !== "object" || depth < 0 || seen.has(value)) return;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return;
  const v = value as Walkable;
  if (v.isScene || v.isCamera || v.isTexture || v.isWebGLRenderer || v.isRenderTarget || v.isBufferGeometry) return;
  if (v.isMaterial) {
    loose.add(value as Material);
    return;
  }
  if (v.isMesh) {
    const material = (value as Mesh).material;
    for (const m of Array.isArray(material) ? material : [material]) {
      if (m && !meshes.has(m)) meshes.set(m, value as Mesh);
    }
    return;
  }
  const children = Array.isArray(value) ? value : Object.values(v);
  for (const child of children) collectPassDraws(child, depth - 1, seen, meshes, loose);
}

/** What compilePassesAhead needs from a post-processing pass. */
export type HqFullscreenPass = { enabled: boolean; renderToScreen: boolean };

/**
 * Starts compiling the programs of full-screen passes (post-processing),
 * which live outside the scene graph. Each pass draws into its own buffers,
 * except the last one, which draws to the canvas; its materials are compiled
 * for both. Returns at once; see programsReady().
 */
export function compilePassesAhead(renderer: WebGLRenderer, passes: readonly HqFullscreenPass[], camera: Camera): void {
  const empty = new Scene();
  const draws: Object3D[] = [];
  const screenDraws: Object3D[] = [];
  const seen = new Set<object>();
  for (const pass of passes) {
    if (!pass.enabled) continue;
    const meshes = new Map<Material, Mesh>();
    const loose = new Set<Material>();
    collectPassDraws(pass, PASS_WALK_DEPTH, seen, meshes, loose);
    // A material the pass swaps onto its quad at render time is drawn on that same quad.
    const quad = meshes.values().next().value as Mesh | undefined;
    const out = pass.renderToScreen ? screenDraws : draws;
    for (const [material, mesh] of meshes) out.push(standIn(mesh, material));
    if (quad) {
      for (const material of loose) if (!meshes.has(material)) out.push(standIn(quad, material));
    }
  }
  withTarget(renderer, () => {
    if (draws.length > 0) renderer.compile(holderOf(draws), camera, empty);
    // The last pass can also write to a buffer (when the chain grows a trailing copy).
    if (screenDraws.length > 0) renderer.compile(holderOf(screenDraws), camera, empty);
  });
  if (screenDraws.length === 0) return;
  const previous = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace();
  const level = renderer.getActiveMipmapLevel();
  renderer.setRenderTarget(null);
  try {
    renderer.compile(holderOf(screenDraws), camera, empty);
  } finally {
    renderer.setRenderTarget(previous, face, level);
  }
}

// ---------------------------------------------------------------------------
// The gate: every new drawable is compiled, then drawn once off screen, before
// the frame shows it.

/** Layer the off-screen warm-up draws on; no camera of the HQ renders it. */
const WARM_LAYER = 31;
/** Main-thread time per frame for starting compiles (ms). */
const COMPILE_BUDGET_MS = 5;
/** Vertices first drawn (uploaded) off screen per frame. */
const WARM_VERTEX_BUDGET = 200_000;
/** Texels of new textures uploaded off screen per frame. */
const WARM_TEXEL_BUDGET = 4_500_000;
/**
 * Held objects are released after this long whatever the driver does: both
 * this many milliseconds and this many frames (a background tab runs a frame
 * a second or none, and must not count as waiting).
 */
const MAX_HOLD_MS = 4000;
const MAX_HOLD_FRAMES = 240;

type TextureSlot = Texture & { isRenderTargetTexture?: boolean; image?: { width?: number; height?: number } | null };

/** Textures of `object`'s materials, including shader uniforms. */
function forEachTexture(object: Object3D, visit: (texture: TextureSlot) => void): void {
  const material = (object as Mesh).material;
  if (!material) return;
  for (const m of Array.isArray(material) ? material : [material]) {
    const fields = m as unknown as Record<string, unknown> & { uniforms?: Record<string, { value?: unknown }> };
    for (const key in fields) {
      const value = fields[key];
      if (value && (value as Texture).isTexture) visit(value as TextureSlot);
    }
    const uniforms = fields.uniforms;
    if (uniforms) {
      for (const key in uniforms) {
        const value = uniforms[key]?.value;
        if (value && (value as Texture).isTexture) visit(value as TextureSlot);
      }
    }
  }
}

/**
 * Holds every drawable that needs a new shader program out of the frame
 * until it is ready to draw without a stall, then releases the whole batch
 * at once:
 *
 * 1. Each frame it finds drawables carrying a material it has not seen on
 *    them yet and compiles their programs ahead (compileAhead), a few
 *    milliseconds of main-thread work per frame. Those that start a compile
 *    are held on a layer no camera renders.
 * 2. Once the driver has built every program, the held objects are drawn
 *    once off screen (a 1×1 target, from the frame's camera, with the
 *    frame's lights), a budget of vertices and new texels per frame: the
 *    first draw uploads geometry and textures and lets the driver finish its
 *    per-draw state, work that would otherwise land in one visible frame.
 * 3. Then they are all released together.
 *
 * Objects whose programs already exist are never held. `released` counts
 * released batches; the first is the room at load.
 */
export class HqPrewarmGate {
  released = 0;
  private known = new WeakMap<Object3D, Material | Material[]>();
  private environment: unknown = undefined;
  private readonly queue: Object3D[] = [];
  private readonly unwarmed: Object3D[] = [];
  private readonly held = new Map<Object3D, number>();
  private heldSince = 0;
  private heldFrames = 0;
  private readonly lights: Object3D[] = [];
  private readonly fresh: Object3D[] = [];
  private readonly chunk: Object3D[] = [];
  private readonly culled: boolean[] = [];
  private warmCamera: Camera | null = null;
  private warmTarget: WebGLRenderTarget | null = null;

  /** Whether anything is being held back. */
  get holding(): boolean {
    return this.held.size > 0;
  }

  /** Once per frame, after every content update and before the draw. */
  update(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    readReadyPrograms(renderer);
    this.discover(scene);
    if (this.queue.length > 0) this.compile(renderer, scene, camera);
    if (this.held.size === 0) return;
    this.heldFrames += 1;
    if (this.heldFrames > MAX_HOLD_FRAMES && performance.now() - this.heldSince > MAX_HOLD_MS) {
      this.release();
      return;
    }
    if (this.queue.length > 0 || !programsReady(renderer)) return;
    if (this.unwarmed.length > 0) {
      readReadyPrograms(renderer);
      this.warm(renderer, scene, camera);
      return;
    }
    this.release();
  }

  private discover(scene: Scene): void {
    // A new environment map changes every lit program.
    if (scene.environment !== this.environment) {
      this.environment = scene.environment;
      this.known = new WeakMap();
    }
    const known = this.known;
    const lights = this.lights;
    const fresh = this.fresh;
    lights.length = 0;
    fresh.length = 0;
    scene.traverse((object) => {
      if ((object as Light).isLight) lights.push(object);
      const material = (object as Mesh).material;
      if (!material || known.get(object) === material) return;
      known.set(object, material);
      fresh.push(object);
    });
    for (const object of fresh) this.queue.push(object);
    fresh.length = 0;
  }

  private compile(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    const shadows = shadowLights(scene, camera);
    const programs = renderer.info.programs;
    const t0 = performance.now();
    let n = 0;
    while (n < this.queue.length && (n === 0 || performance.now() - t0 < COMPILE_BUDGET_MS)) {
      const object = this.queue[n];
      n += 1;
      const before = programs ? programs.length : 0;
      compileAhead(renderer, [object], camera, scene, shadows);
      const started = (programs ? programs.length : 0) !== before;
      if (this.held.has(object)) {
        this.unwarmed.push(object);
      } else if (started || !programsReady(renderer)) {
        this.hold(object);
        this.unwarmed.push(object);
      }
    }
    this.queue.splice(0, n);
    // What did not fit this frame waits, held, for the next one.
    for (const object of this.queue) this.hold(object);
  }

  private hold(object: Object3D): void {
    if (this.held.has(object)) return;
    if (this.held.size === 0) {
      this.heldSince = performance.now();
      this.heldFrames = 0;
    }
    this.held.set(object, object.layers.mask);
    object.layers.mask = 0;
  }

  private release(): void {
    for (const [object, mask] of this.held) object.layers.mask = mask;
    this.held.clear();
    this.queue.length = 0;
    this.unwarmed.length = 0;
    this.released += 1;
  }

  /** Draws the next budget of held objects once, off screen. */
  private warm(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    const chunk = this.chunk;
    const culled = this.culled;
    chunk.length = 0;
    culled.length = 0;
    const properties = renderer.properties;
    const counted = new Set<Texture>();
    let vertices = 0;
    let texels = 0;
    while (this.unwarmed.length > 0) {
      const object = this.unwarmed[0];
      const geometry = (object as Mesh).geometry;
      const v = geometry?.attributes?.position?.count ?? 0;
      let t = 0;
      forEachTexture(object, (texture) => {
        if (counted.has(texture) || texture.isRenderTargetTexture) return;
        counted.add(texture);
        // three's own record of the version it last uploaded.
        if ((properties.get(texture) as { __version?: number }).__version === texture.version) return;
        t += (texture.image?.width ?? 0) * (texture.image?.height ?? 0);
      });
      if (chunk.length > 0 && (vertices + v > WARM_VERTEX_BUDGET || texels + t > WARM_TEXEL_BUDGET)) break;
      this.unwarmed.shift();
      vertices += v;
      texels += t;
      chunk.push(object);
    }
    if (chunk.length === 0) return;

    let target = this.warmTarget;
    if (!target) {
      // Same kind of buffer the post chain draws the scene into.
      target = this.warmTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: true, stencilBuffer: false });
      target.texture.name = "hq-shader-warm";
    }
    const warmCamera = (this.warmCamera ??= camera.clone());
    warmCamera.copy(camera, false);
    warmCamera.layers.set(WARM_LAYER);
    // The frame's lights must light the warm draw (they keep their own layers too).
    for (const light of this.lights) light.layers.enable(WARM_LAYER);
    for (const object of chunk) {
      object.layers.set(WARM_LAYER);
      culled.push(object.frustumCulled);
      // Everything held gets its first draw, on screen or not.
      object.frustumCulled = false;
    }
    const shadowMap = renderer.shadowMap;
    const autoUpdate = shadowMap.autoUpdate;
    const needsUpdate = shadowMap.needsUpdate;
    // The shadow map keeps what the frame drew into it.
    shadowMap.autoUpdate = false;
    shadowMap.needsUpdate = false;
    const previous = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace();
    const level = renderer.getActiveMipmapLevel();
    try {
      renderer.setRenderTarget(target);
      // The post chain turns autoClear off; start from an empty buffer.
      renderer.clear(true, true, false);
      renderer.render(scene, warmCamera);
    } finally {
      renderer.setRenderTarget(previous, face, level);
      shadowMap.autoUpdate = autoUpdate;
      shadowMap.needsUpdate = needsUpdate;
      for (let i = 0; i < chunk.length; i += 1) {
        chunk[i].layers.mask = 0;
        chunk[i].frustumCulled = culled[i];
      }
    }
  }

  /** Puts back everything held (the scene is going away). */
  dispose(): void {
    for (const [object, mask] of this.held) object.layers.mask = mask;
    this.held.clear();
    this.queue.length = 0;
    this.unwarmed.length = 0;
    this.warmTarget?.dispose();
    this.warmTarget = null;
  }
}
