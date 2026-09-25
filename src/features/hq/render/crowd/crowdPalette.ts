import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  HalfFloatType,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from "three";

/**
 * The per-frame bone palette of the instanced crowd.
 *
 * One small render pass writes, for every drawn instance k and bone b, the
 * final skinning matrix (four texels, row k): each bone's local transform is
 * sampled from the baked clip rows (frame-interpolated), crossfaded between
 * the current and previous clip with slerp/lerp exactly like AnimationMixer,
 * and composed down the hierarchy. The crowd's vertex shader then reads four
 * matrices per vertex from row gl_InstanceID. Doing the hierarchy once per
 * (instance, bone) instead of per vertex keeps the vertex stage to 16 fetches
 * and makes crossfades match the hero rigs.
 *
 * Per-instance input is a float texture of (rowA, rowB, weightA, lead):
 * row = baked texture row + fraction toward the next row.
 */

export const PARAMS_WIDTH = 256;

const PASS_VERTEX = /* glsl */ `
uniform float uRows;
uniform float uCapacity;
void main() {
  // Cover only the rows in use.
  float y = -1.0 + ( position.y * 0.5 + 0.5 ) * 2.0 * ( uRows / uCapacity );
  gl_Position = vec4( position.x, y, 0.0, 1.0 );
}
`;

const PASS_FRAGMENT = /* glsl */ `
uniform highp sampler2D uAnim;
uniform highp sampler2D uRig;
uniform highp sampler2D uParams;

vec4 qNlerp( vec4 a, vec4 b, float t ) {
  if ( dot( a, b ) < 0.0 ) b = -b;
  return normalize( mix( a, b, t ) );
}

// Same result as three's Quaternion.slerp (used by AnimationMixer's blend).
vec4 qSlerp( vec4 a, vec4 b, float t ) {
  float c = dot( a, b );
  if ( c < 0.0 ) { b = -b; c = -c; }
  if ( c > 0.9995 ) return normalize( mix( a, b, t ) );
  float th = acos( c );
  return ( a * sin( ( 1.0 - t ) * th ) + b * sin( t * th ) ) / sin( th );
}

// Matrix4.compose( p, q, s ).
mat4 compose( vec4 q, vec3 p, vec3 s ) {
  float x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z;
  float xx = q.x * x2, xy = q.x * y2, xz = q.x * z2;
  float yy = q.y * y2, yz = q.y * z2, zz = q.z * z2;
  float wx = q.w * x2, wy = q.w * y2, wz = q.w * z2;
  return mat4(
    vec4( ( 1.0 - ( yy + zz ) ) * s.x, ( xy + wz ) * s.x, ( xz - wy ) * s.x, 0.0 ),
    vec4( ( xy - wz ) * s.y, ( 1.0 - ( xx + zz ) ) * s.y, ( yz + wx ) * s.y, 0.0 ),
    vec4( ( xz + wy ) * s.z, ( yz - wx ) * s.z, ( 1.0 - ( xx + yy ) ) * s.z, 0.0 ),
    vec4( p, 1.0 ) );
}

void sampleLocal( int row, int bone, out vec4 q, out vec3 p, out vec3 s ) {
  int x = bone * 3;
  q = texelFetch( uAnim, ivec2( x, row ), 0 );
  vec4 a = texelFetch( uAnim, ivec2( x + 1, row ), 0 );
  vec4 b = texelFetch( uAnim, ivec2( x + 2, row ), 0 );
  p = a.xyz;
  s = vec3( a.w, b.x, b.y );
}

mat4 localPose( int bone, int rowA, float tA, int rowB, float tB, float wA ) {
  vec4 q0; vec3 p0; vec3 s0;
  vec4 q1; vec3 p1; vec3 s1;
  sampleLocal( rowA, bone, q0, p0, s0 );
  sampleLocal( rowA + 1, bone, q1, p1, s1 );
  vec4 q = qNlerp( q0, q1, tA );
  vec3 p = mix( p0, p1, tA );
  vec3 s = mix( s0, s1, tA );
  if ( wA < 0.999 ) {
    sampleLocal( rowB, bone, q0, p0, s0 );
    sampleLocal( rowB + 1, bone, q1, p1, s1 );
    q = qSlerp( qNlerp( q0, q1, tB ), q, wA );
    p = mix( mix( p0, p1, tB ), p, wA );
    s = mix( mix( s0, s1, tB ), s, wA );
  }
  return compose( q, p, s );
}

mat4 rigMatrix( int row, int bone ) {
  int x = bone * 4;
  return mat4(
    texelFetch( uRig, ivec2( x, row ), 0 ),
    texelFetch( uRig, ivec2( x + 1, row ), 0 ),
    texelFetch( uRig, ivec2( x + 2, row ), 0 ),
    texelFetch( uRig, ivec2( x + 3, row ), 0 ) );
}

void main() {
  int x = int( gl_FragCoord.x );
  int k = int( gl_FragCoord.y );
  int bone = x / 4;
  int column = x - bone * 4;
  vec4 params = texelFetch( uParams, ivec2( k % ${PARAMS_WIDTH}, k / ${PARAMS_WIDTH} ), 0 );
  float rowAf = floor( params.x );
  float rowBf = floor( params.y );
  int rowA = int( rowAf );
  int rowB = int( rowBf );
  float tA = params.x - rowAf;
  float tB = params.y - rowBf;
  mat4 m = rigMatrix( 0, bone );
  int j = bone;
  for ( int depth = 0; depth < 48; depth++ ) {
    if ( j < 0 ) break;
    m = rigMatrix( 1, j ) * localPose( j, rowA, tA, rowB, tB, params.z ) * m;
    j = int( texelFetch( uRig, ivec2( j * 4, 2 ), 0 ).x );
  }
  gl_FragColor = column == 0 ? m[ 0 ] : column == 1 ? m[ 1 ] : column == 2 ? m[ 2 ] : m[ 3 ];
}
`;

export class HqPalettePass {
  readonly params: DataTexture;
  readonly paramData: Float32Array;
  private target: WebGLRenderTarget;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: ShaderMaterial;
  private readonly quad: Mesh;
  readonly capacity: number;

  constructor(anim: Texture, rig: Texture, boneCount: number, capacity: number, floatTargets: boolean) {
    this.capacity = capacity;
    const paramRows = Math.ceil(capacity / PARAMS_WIDTH);
    this.paramData = new Float32Array(PARAMS_WIDTH * paramRows * 4);
    this.params = new DataTexture(this.paramData, PARAMS_WIDTH, paramRows, RGBAFormat, FloatType);
    this.params.magFilter = NearestFilter;
    this.params.minFilter = NearestFilter;
    this.params.generateMipmaps = false;
    this.params.name = "hq-crowd-params";
    this.target = new WebGLRenderTarget(boneCount * 4, capacity, {
      type: floatTargets ? FloatType : HalfFloatType,
      format: RGBAFormat,
      magFilter: NearestFilter,
      minFilter: NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.target.texture.name = "hq-crowd-palette";
    this.material = new ShaderMaterial({
      uniforms: {
        uAnim: { value: anim },
        uRig: { value: rig },
        uParams: { value: this.params },
        uRows: { value: 0 },
        uCapacity: { value: capacity },
      },
      vertexShader: PASS_VERTEX,
      fragmentShader: PASS_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.material.name = "hq-crowd-palette-pass";
    const geometry = new BufferGeometry();
    // One triangle pair covering clip space; the vertex shader trims the height.
    geometry.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    this.quad = new Mesh(geometry, this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get palette(): Texture {
    return this.target.texture;
  }

  setInstance(k: number, rowA: number, rowB: number, weightA: number, lead: number): void {
    const o = k * 4;
    const d = this.paramData;
    d[o] = rowA;
    d[o + 1] = rowB;
    d[o + 2] = weightA;
    d[o + 3] = lead;
  }

  /** Writes the palette for instances [0, count). Restores the renderer's target. */
  render(renderer: WebGLRenderer, count: number): void {
    if (count <= 0) return;
    this.params.needsUpdate = true;
    this.material.uniforms.uRows.value = Math.min(count, this.capacity);
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const xr = renderer.xr.enabled;
    renderer.autoClear = false;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
    renderer.xr.enabled = xr;
  }

  dispose(): void {
    this.target.dispose();
    this.params.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
