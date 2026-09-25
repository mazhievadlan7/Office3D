import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from "three";
import { HQ_THEME } from "@/features/hq/core/config";

/**
 * Floor decals under the agents, two draws in total:
 * - a soft blob shadow under every visible agent (the instanced crowd does
 *   not cast real shadows; only hero rigs do);
 * - glowing rings: bright for the selected agent, softer for the hovered one,
 *   and a faint status ring under everyone at high quality.
 * Both are instanced quads on the floor with per-instance data only, so an
 * agent costs 16-40 bytes of upload per frame.
 */

export const RING_STATUS = 0;
export const RING_HOVER = 1;
export const RING_SELECTED = 2;

const BLOB_VERTEX = /* glsl */ `
attribute vec4 aSpot;
varying vec2 vLocal;
#include <fog_pars_vertex>
void main() {
  vLocal = position.xz;
  vec4 mvPosition = modelViewMatrix * vec4( aSpot.x + position.x * aSpot.w, aSpot.y, aSpot.z + position.z * aSpot.w, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const BLOB_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vLocal;
#include <fog_pars_fragment>
void main() {
  float r = length( vLocal );
  float a = uOpacity * pow( clamp( 1.0 - r, 0.0, 1.0 ), 1.7 );
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( uColor, a );
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const RING_VERTEX = /* glsl */ `
attribute vec4 aSpot;
attribute vec4 aColor;
attribute vec2 aStyle;
varying vec2 vLocal;
varying vec4 vColor;
varying vec2 vStyle;
void main() {
  vLocal = position.xz;
  vColor = aColor;
  vStyle = aStyle;
  vec4 mvPosition = modelViewMatrix * vec4( aSpot.x + position.x * aSpot.w, aSpot.y, aSpot.z + position.z * aSpot.w, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
}
`;

const RING_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uSelectGlow;
varying vec2 vLocal;
varying vec4 vColor;
varying vec2 vStyle;
void main() {
  float r = length( vLocal );
  if ( r > 1.0 ) discard;
  float aa = fwidth( r ) * 1.25;
  float style = vStyle.x;
  bool selected = style > 1.5;
  bool emphasised = style > 0.5;
  float ringR = 0.72;
  float halfW = selected ? 0.034 : ( emphasised ? 0.026 : 0.014 );
  float d = abs( r - ringR );
  float core = 1.0 - smoothstep( halfW - aa, halfW + aa, d );
  float glow = exp( -d * ( emphasised ? 9.0 : 18.0 ) ) * ( emphasised ? 0.45 : 0.16 );
  vec3 glowColor = selected ? uSelectGlow : vColor.rgb;
  vec3 col = vColor.rgb * core + glowColor * glow;
  if ( emphasised ) {
    // Faint floor wash inside the ring.
    col += glowColor * ( 1.0 - smoothstep( 0.0, ringR, r ) ) * 0.07;
  }
  if ( selected ) {
    // Slowly turning tick marks on an outer band, and a gentle pulse.
    float turn = fract( atan( vLocal.y, vLocal.x ) / 6.2831853 * 40.0 + uTime * 0.18 );
    float tick = smoothstep( 0.2, 0.3, turn ) * ( 1.0 - smoothstep( 0.55, 0.65, turn ) );
    float band = 1.0 - smoothstep( 0.014 - aa, 0.014 + aa, abs( r - 0.9 ) );
    col += glowColor * band * tick * 1.3;
    col *= 0.86 + 0.14 * sin( uTime * 2.6 + vStyle.y );
  }
  float fade = 1.0 - smoothstep( 0.94, 1.0, r );
  if ( !emphasised ) {
    // Status rings are texture, not signal: they fade out once a ring is
    // only a few pixels across, so a zoomed-out room does not turn to confetti.
    float radiusPx = 1.0 / max( fwidth( r ), 1e-4 );
    fade *= smoothstep( 9.0, 22.0, radiusPx );
  }
  gl_FragColor = vec4( col * vColor.a * fade, 1.0 );
  #include <colorspace_fragment>
}
`;

function floorQuad(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1]), 3),
  );
  // Counter-clockwise seen from above.
  geometry.setIndex([0, 2, 1, 2, 3, 1]);
  return geometry;
}

function instanced(size: number, itemSize: number): InstancedBufferAttribute {
  const attribute = new InstancedBufferAttribute(new Float32Array(size * itemSize), itemSize);
  attribute.setUsage(DynamicDrawUsage);
  return attribute;
}

function upload(attribute: InstancedBufferAttribute, count: number): void {
  attribute.clearUpdateRanges();
  if (count > 0) {
    attribute.addUpdateRange(0, count * attribute.itemSize);
    attribute.needsUpdate = true;
  }
}

export class HqCrowdDecals {
  readonly blobs: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly rings: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private capacity = 0;
  private blobSpot!: InstancedBufferAttribute;
  private ringSpot!: InstancedBufferAttribute;
  private ringColor!: InstancedBufferAttribute;
  private ringStyle!: InstancedBufferAttribute;
  private blobCount = 0;
  private ringCount = 0;

  constructor(capacity: number) {
    const blobMaterial = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        { uColor: { value: new Color(HQ_THEME.background) }, uOpacity: { value: 0.62 } },
      ]),
      vertexShader: BLOB_VERTEX,
      fragmentShader: BLOB_FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    blobMaterial.name = "hq-crowd-blob";
    const ringMaterial = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSelectGlow: { value: new Color(HQ_THEME.accent) },
      },
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    ringMaterial.name = "hq-crowd-ring";
    this.blobs = new Mesh(floorQuad(), blobMaterial);
    this.rings = new Mesh(floorQuad(), ringMaterial);
    for (const mesh of [this.blobs, this.rings]) {
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      mesh.matrixAutoUpdate = false;
    }
    this.blobs.name = "hq-crowd-blobs";
    this.rings.name = "hq-crowd-rings";
    this.blobs.renderOrder = 1;
    this.rings.renderOrder = 2;
    this.ensure(capacity);
  }

  /** Grows the per-instance buffers (rare; replaces the geometries). */
  ensure(agents: number): void {
    if (agents <= this.capacity) return;
    const size = Math.max(64, 1 << Math.ceil(Math.log2(agents)));
    this.capacity = size;
    const blobGeometry = floorQuad();
    this.blobSpot = instanced(size, 4);
    blobGeometry.setAttribute("aSpot", this.blobSpot);
    const ringGeometry = floorQuad();
    // Status rings for everyone plus the selected and hovered highlights.
    this.ringSpot = instanced(size + 4, 4);
    this.ringColor = instanced(size + 4, 4);
    this.ringStyle = instanced(size + 4, 2);
    ringGeometry.setAttribute("aSpot", this.ringSpot);
    ringGeometry.setAttribute("aColor", this.ringColor);
    ringGeometry.setAttribute("aStyle", this.ringStyle);
    this.blobs.geometry.dispose();
    this.rings.geometry.dispose();
    this.blobs.geometry = blobGeometry;
    this.rings.geometry = ringGeometry;
  }

  begin(): void {
    this.blobCount = 0;
    this.ringCount = 0;
  }

  pushBlob(x: number, y: number, z: number, radius: number): void {
    if (this.blobCount >= this.capacity) return;
    const a = this.blobSpot.array as Float32Array;
    const o = this.blobCount++ * 4;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = z;
    a[o + 3] = radius;
  }

  /** `color` is linear; `intensity` scales it (above 1 reaches the bloom). */
  pushRing(x: number, y: number, z: number, radius: number, color: Color, intensity: number, style: number, phase: number): void {
    if (this.ringCount >= this.capacity + 4) return;
    const k = this.ringCount++;
    const spot = this.ringSpot.array as Float32Array;
    const col = this.ringColor.array as Float32Array;
    const sty = this.ringStyle.array as Float32Array;
    spot[k * 4] = x;
    spot[k * 4 + 1] = y;
    spot[k * 4 + 2] = z;
    spot[k * 4 + 3] = radius;
    col[k * 4] = color.r;
    col[k * 4 + 1] = color.g;
    col[k * 4 + 2] = color.b;
    col[k * 4 + 3] = intensity;
    sty[k * 2] = style;
    sty[k * 2 + 1] = phase;
  }

  end(time: number): void {
    this.blobs.geometry.instanceCount = this.blobCount;
    this.rings.geometry.instanceCount = this.ringCount;
    this.blobs.visible = this.blobCount > 0;
    this.rings.visible = this.ringCount > 0;
    upload(this.blobSpot, this.blobCount);
    upload(this.ringSpot, this.ringCount);
    upload(this.ringColor, this.ringCount);
    upload(this.ringStyle, this.ringCount);
    this.rings.material.uniforms.uTime.value = time;
  }

  dispose(): void {
    this.blobs.geometry.dispose();
    this.rings.geometry.dispose();
    this.blobs.material.dispose();
    this.rings.material.dispose();
  }
}
