import {
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  type Camera,
  type PerspectiveCamera,
  type OrthographicCamera,
} from "three";
import * as troika from "troika-three-text";
import { OFFICE_TEXT_FONT } from "@/components/three/sceneAssets";
import { HQ_THEME } from "@/features/hq/core/config";
import type { HqAgentFrame, HqAgentInput } from "@/features/hq/core/types";
import { StableSlots, type HqAgentLookup } from "./stableSlots";

/**
 * Pill nameplates (dark rounded pill, glowing status dot, name) for the hero
 * agents plus the hovered and selected ones. All pills are one instanced,
 * camera-facing draw; names are a small pool of troika texts whose content
 * changes only when a slot gets another agent. Positions are written
 * imperatively every frame, never through React.
 */

// troika-three-text ships no types and the repo's shim only declares the
// builder config, so the part used here is typed locally.
type TroikaText = Mesh & {
  text: string;
  font: string | null;
  fontSize: number;
  anchorX: number | "left" | "center" | "right";
  anchorY: number | "top" | "middle" | "bottom";
  letterSpacing: number;
  whiteSpace: "normal" | "nowrap";
  color: Color | string | number | null;
  fillOpacity: number;
  sdfGlyphSize: number;
  textRenderInfo: { blockBounds: ArrayLike<number> } | null;
  sync(callback?: () => void): void;
  dispose(): void;
};
const TroikaTextMesh = (troika as unknown as { Text: new () => TroikaText }).Text;

// Pill geometry in label units (a label is scaled to a steady on-screen size).
const PILL_H = 0.15;
const FONT_SIZE = 0.074;
const TEXT_LEFT = PILL_H * 0.9;
const TEXT_RIGHT = PILL_H * 0.55;
// Target pill height and the gap above the head, in CSS pixels.
const PILL_PX = 22;
const GAP_PX = 8;
const MAX_NAME = 22;

const PILL_VERTEX = /* glsl */ `
attribute vec4 aCenter;
attribute vec4 aSize;
attribute vec3 aDot;
attribute vec3 aBorder;
varying vec2 vP;
varying vec2 vHalf;
varying vec3 vDot;
varying vec3 vBorder;
varying float vAlpha;
varying float vLead;
void main() {
  vec2 local = position.xy * aSize.xy;
  vP = local;
  vHalf = aSize.xy * 0.5;
  vDot = aDot;
  vBorder = aBorder;
  vAlpha = aSize.z;
  vLead = aSize.w;
  vec4 mv = modelViewMatrix * vec4( aCenter.xyz, 1.0 );
  mv.xy += local * aCenter.w;
  gl_Position = projectionMatrix * mv;
}
`;

const PILL_FRAGMENT = /* glsl */ `
uniform vec3 uBg;
uniform float uBgAlpha;
uniform vec3 uAccent;
varying vec2 vP;
varying vec2 vHalf;
varying vec3 vDot;
varying vec3 vBorder;
varying float vAlpha;
varying float vLead;
void main() {
  float r = vHalf.y;
  vec2 q = abs( vP ) - vec2( vHalf.x - r, 0.0 );
  float d = length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - r;
  float aa = fwidth( d );
  float fill = 1.0 - smoothstep( -aa, aa, d );
  if ( fill <= 0.0 ) discard;
  float bw = r * 0.09;
  float border = 1.0 - smoothstep( bw * 0.5 - aa, bw * 0.5 + aa, abs( d + bw * 0.5 ) );
  vec3 col = uBg;
  // AM7: a red wash from the left edge.
  col += uAccent * vLead * 0.22 * ( 1.0 - smoothstep( -vHalf.x, -vHalf.x + r * 5.0, vP.x ) );
  col = mix( col, vBorder, border );
  vec2 dotCentre = vec2( -vHalf.x + r, 0.0 );
  float dd = length( vP - dotCentre );
  float dotR = r * 0.34;
  float dotMask = 1.0 - smoothstep( dotR - aa, dotR + aa, dd );
  float halo = exp( -max( dd - dotR, 0.0 ) / ( r * 0.3 ) ) * 0.55 * ( 1.0 - dotMask );
  col += vDot * halo;
  col = mix( col, vDot * 1.8, dotMask );
  float alpha = max( fill * uBgAlpha, max( border, dotMask ) ) * fill;
  gl_FragColor = vec4( col, alpha * vAlpha );
  #include <colorspace_fragment>
}
`;

type LabelSlot = {
  text: TroikaText;
  holder: Group;
  /** Name as given by the app, compared by reference each frame. */
  rawName: string;
  name: string;
  lead: boolean;
  width: number;
  ready: boolean;
  y: number;
  alpha: number;
  onSync: () => void;
};

const _statusColors = [
  new Color(HQ_THEME.statusWorking),
  new Color(HQ_THEME.statusIdle),
  new Color(HQ_THEME.statusError),
];
const _borderNormal = new Color(HQ_THEME.glassEdge);
const _borderHover = new Color(HQ_THEME.accentSoft);
const _borderSelected = new Color(HQ_THEME.statusSelected);
const _borderLead = new Color(HQ_THEME.accent).multiplyScalar(1.6);

function displayName(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return clean.length > MAX_NAME ? `${clean.slice(0, MAX_NAME - 1)}…` : clean;
}

function nameOf(agents: readonly HqAgentInput[], index: number, id: string): string {
  const direct = agents[index];
  if (direct && direct.id === id) return direct.name || id;
  for (const agent of agents) if (agent.id === id) return agent.name || id;
  return id;
}

export class HqCrowdLabels {
  readonly root = new Group();
  readonly slots: StableSlots;
  private slotOfAgent = new Int32Array(0);
  private readonly pill: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly aCenter: InstancedBufferAttribute;
  private readonly aSize: InstancedBufferAttribute;
  private readonly aDot: InstancedBufferAttribute;
  private readonly aBorder: InstancedBufferAttribute;
  private readonly textMaterial: MeshBasicMaterial;
  private readonly labels: LabelSlot[] = [];
  private readonly attributes: InstancedBufferAttribute[];

  constructor(size: number) {
    this.root.name = "hq-crowd-labels";
    this.slots = new StableSlots(size);
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]), 3),
    );
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    const attr = (itemSize: number) => {
      const a = new InstancedBufferAttribute(new Float32Array(size * itemSize), itemSize);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    this.aCenter = attr(4);
    this.aSize = attr(4);
    this.aDot = attr(3);
    this.aBorder = attr(3);
    geometry.setAttribute("aCenter", this.aCenter);
    geometry.setAttribute("aSize", this.aSize);
    geometry.setAttribute("aDot", this.aDot);
    geometry.setAttribute("aBorder", this.aBorder);
    this.attributes = [this.aCenter, this.aSize, this.aDot, this.aBorder];
    geometry.instanceCount = 0;
    const material = new ShaderMaterial({
      uniforms: {
        uBg: { value: new Color(HQ_THEME.background) },
        uBgAlpha: { value: 0.84 },
        uAccent: { value: new Color(HQ_THEME.accent) },
      },
      vertexShader: PILL_VERTEX,
      fragmentShader: PILL_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    material.name = "hq-crowd-label-pill";
    this.pill = new Mesh(geometry, material);
    this.pill.name = "hq-crowd-label-pills";
    this.pill.frustumCulled = false;
    this.pill.renderOrder = 20;
    this.pill.matrixAutoUpdate = false;
    this.pill.raycast = () => {};
    this.root.add(this.pill);

    this.textMaterial = new MeshBasicMaterial({
      color: HQ_THEME.statusSelected,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.textMaterial.name = "hq-crowd-label-text";
    for (let s = 0; s < size; s += 1) {
      const text = new TroikaTextMesh();
      text.font = OFFICE_TEXT_FONT;
      text.fontSize = FONT_SIZE;
      text.anchorX = "left";
      text.anchorY = "middle";
      text.letterSpacing = 0.02;
      text.whiteSpace = "nowrap";
      text.sdfGlyphSize = 64;
      text.material = this.textMaterial;
      text.renderOrder = 21;
      text.raycast = () => {};
      text.text = "";
      const holder = new Group();
      holder.visible = false;
      holder.add(text);
      this.root.add(holder);
      const slot: LabelSlot = {
        text,
        holder,
        rawName: "",
        name: "",
        lead: false,
        width: 0,
        ready: false,
        y: 0,
        alpha: 0,
        onSync: () => {
          const bounds = text.textRenderInfo?.blockBounds;
          slot.width = bounds ? Math.max(0, bounds[2] - bounds[0]) : 0;
          slot.ready = true;
        },
      };
      this.labels.push(slot);
    }
  }

  /**
   * `want` lists the labelled agents; `headY(i)` returns the head height of
   * agent i. Hidden labels cost nothing but their slot.
   */
  update(
    frame: HqAgentFrame,
    want: Int32Array,
    wantCount: number,
    lookup: HqAgentLookup,
    agents: readonly HqAgentInput[],
    visible: Uint8Array,
    headY: (index: number) => number,
    selected: number,
    hovered: number,
    camera: Camera,
    viewportHeight: number,
    dt: number,
  ): void {
    const count = frame.count;
    if (this.slotOfAgent.length < count) this.slotOfAgent = new Int32Array(Math.max(count, 64) * 2);
    this.slots.sync(want, wantCount, this.slots.size, frame.ids, count, lookup, this.slotOfAgent);

    const centers = this.aCenter.array as Float32Array;
    const sizes = this.aSize.array as Float32Array;
    const dots = this.aDot.array as Float32Array;
    const borders = this.aBorder.array as Float32Array;
    const camPos = camera.matrixWorld.elements;
    const persp = (camera as PerspectiveCamera).isPerspectiveCamera ? (camera as PerspectiveCamera) : null;
    const ortho = (camera as OrthographicCamera).isOrthographicCamera ? (camera as OrthographicCamera) : null;
    const tanHalf = persp ? Math.tan(((persp.fov * Math.PI) / 180) * 0.5) / Math.max(persp.zoom, 1e-3) : 0;
    const orthoSpan = ortho ? (ortho.top - ortho.bottom) / Math.max(ortho.zoom, 1e-3) : 0;
    const px = Math.max(viewportHeight, 1);
    const ease = 1 - Math.exp(-dt * 12);
    let drawn = 0;

    for (let s = 0; s < this.labels.length; s += 1) {
      const label = this.labels[s];
      const i = this.slots.agentIndex[s];
      if (i < 0 || visible[i] === 0) {
        label.holder.visible = false;
        if (i < 0) label.alpha = 0;
        continue;
      }
      const id = frame.ids[i];
      const lead = frame.lead[i] === 1;
      const rawName = nameOf(agents, i, id);
      if (rawName !== label.rawName) {
        label.rawName = rawName;
        const name = displayName(rawName);
        if (name !== label.name) {
          label.name = name;
          label.ready = false;
          label.text.text = name;
          label.text.sync(label.onSync);
        }
      }
      if (this.slots.fresh[s] === 1) label.alpha = 0;
      if (lead !== label.lead) {
        label.lead = lead;
        label.text.color = lead ? HQ_THEME.accentSoft : null;
      }
      if (!label.ready) {
        label.holder.visible = false;
        continue;
      }

      const x = frame.x[i];
      const z = frame.z[i];
      const top = headY(i) + 0.3;
      const dx = x - camPos[12];
      const dy = top - camPos[13];
      const dz = z - camPos[14];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const worldPerPx = persp ? (2 * dist * tanHalf) / px : orthoSpan / px;
      const scale = Math.min(Math.max((worldPerPx * PILL_PX) / PILL_H, 0.25), 40);
      const targetY = top + worldPerPx * GAP_PX + PILL_H * scale * 0.5;
      label.y = this.slots.fresh[s] === 1 || label.alpha === 0 ? targetY : label.y + (targetY - label.y) * ease;
      label.alpha += (1 - label.alpha) * ease;

      const width = label.width + TEXT_LEFT + TEXT_RIGHT;
      const k = drawn++;
      centers[k * 4] = x;
      centers[k * 4 + 1] = label.y;
      centers[k * 4 + 2] = z;
      centers[k * 4 + 3] = scale;
      sizes[k * 4] = width;
      sizes[k * 4 + 1] = PILL_H;
      sizes[k * 4 + 2] = label.alpha;
      sizes[k * 4 + 3] = lead ? 1 : 0;
      const status = _statusColors[frame.status[i]] ?? _statusColors[1];
      dots[k * 3] = status.r;
      dots[k * 3 + 1] = status.g;
      dots[k * 3 + 2] = status.b;
      const border = lead ? _borderLead : i === selected ? _borderSelected : i === hovered ? _borderHover : _borderNormal;
      borders[k * 3] = border.r;
      borders[k * 3 + 1] = border.g;
      borders[k * 3 + 2] = border.b;

      // The text rides in a camera-facing holder at the pill centre.
      label.holder.visible = true;
      label.holder.position.set(x, label.y, z);
      label.holder.quaternion.copy(camera.quaternion);
      label.holder.scale.setScalar(scale);
      label.text.position.set(-width * 0.5 + TEXT_LEFT, 0, 0.001);
      label.text.fillOpacity = label.alpha;
    }

    const geometry = this.pill.geometry;
    geometry.instanceCount = drawn;
    this.pill.visible = drawn > 0;
    for (const attribute of this.attributes) {
      attribute.clearUpdateRanges();
      if (drawn > 0) {
        attribute.addUpdateRange(0, drawn * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
  }

  hide(): void {
    this.pill.visible = false;
    for (const label of this.labels) label.holder.visible = false;
  }

  dispose(): void {
    this.pill.geometry.dispose();
    this.pill.material.dispose();
    for (const label of this.labels) label.text.dispose();
    this.textMaterial.dispose();
  }
}
