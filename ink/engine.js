(() => {
'use strict';

/* ════════════════════════════════════════════════
   墨流し — GPU流体シミュレーション
   速度場: Stable Fluids (advect → vorticity → project)
   染料場: 吸光度(absorption)として蓄積し、
           表示時に 紙色 × exp(-A) で減法混色する
   ════════════════════════════════════════════════ */

const config = {
  SIM_RES: 256,            // 速度場の解像度
  DYE_RES: 1280,           // 染料場の解像度(長辺)
  PRESSURE_ITER: 28,
  VEL_DISSIPATION: 0.16,   // 速度の減衰
  DYE_DISSIPATION: 0.07,   // 墨の褪せ(小さいほど残る)
  CURL: 14,                // 渦の強さ
  SPLAT_RADIUS: 0.0026,
  SPLAT_FORCE: 5200,
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── インク定義(表示色 → 吸光ベクトル) ── */
const INKS = {
  sumi:    new THREE.Color('#1a1a1f'),
  ai:      new THREE.Color('#16407a'),
  shu:     new THREE.Color('#c8372d'),
  matsuba: new THREE.Color('#2e6e52'),
};
INKS.jade=new THREE.Color('#367f87'); INKS.pink=new THREE.Color('#d58da3');
const INK_KEYS = ['sumi','ai','shu','matsuba'];
const PAPER = new THREE.Color('#efeae0');

// 表示色cのインクを、吸光度ベクトルへ(濃いほど exp(-A) がcに近づく)
function inkAbsorption(c, strength) {
  const e = 0.012;
  return new THREE.Vector3(
    -Math.log(Math.max(c.r, e)) * strength,
    -Math.log(Math.max(c.g, e)) * strength,
    -Math.log(Math.max(c.b, e)) * strength
  );
}

/* ── レンダラ ── */
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true, premultipliedAlpha: false, depth: false, stencil: false });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.autoClear = false;
document.body.appendChild(renderer.domElement);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const scene = new THREE.Scene();
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
scene.add(quad);

/* ── FBO ── */
function makeRT(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
}
function makeDoubleFBO(w, h) {
  return {
    read: makeRT(w, h), write: makeRT(w, h),
    texel: new THREE.Vector2(1 / w, 1 / h),
    swap() { const t = this.read; this.read = this.write; this.write = t; },
    resize(nw, nh) {
      this.read.setSize(nw, nh); this.write.setSize(nw, nh);
      this.texel.set(1 / nw, 1 / nh);
    },
  };
}

function simSizes() {
  const aspect = innerWidth / innerHeight;
  const sim = config.SIM_RES, dye = Math.min(config.DYE_RES, Math.max(innerWidth, innerHeight));
  return aspect >= 1
    ? { sw: Math.round(sim * aspect), sh: sim, dw: dye, dh: Math.round(dye / aspect) }
    : { sw: sim, sh: Math.round(sim / aspect), dw: Math.round(dye * aspect), dh: dye };
}

let S = simSizes();
const velocity   = makeDoubleFBO(S.sw, S.sh);
const dye        = makeDoubleFBO(S.dw, S.dh);
const pressure   = makeDoubleFBO(S.sw, S.sh);
const curlRT     = makeRT(S.sw, S.sh);
const divergeRT  = makeRT(S.sw, S.sh);

/* ── シェーダ ── */
const VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function prog(frag, uniforms) {
  return new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
}

const advectMat = prog(/* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uVelocity, uSource;
  uniform vec2 uTexel;
  uniform float uDt, uDissipation;
  void main(){
    vec2 coord = vUv - uDt * texture2D(uVelocity, vUv).xy * uTexel;
    vec4 result = texture2D(uSource, coord);
    gl_FragColor = result / (1.0 + uDissipation * uDt);
  }
`, {
  uVelocity: { value: null }, uSource: { value: null },
  uTexel: { value: new THREE.Vector2() }, uDt: { value: 0 }, uDissipation: { value: 0 },
});

const splatMat = prog(/* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float uAspect, uRadius;
  uniform vec2 uPoint;
  uniform vec3 uColor;
  void main(){
    vec2 p = vUv - uPoint;
    p.x *= uAspect;
    vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
    gl_FragColor = vec4(texture2D(uTarget, vUv).rgb + splat, 1.0);
  }
`, {
  uTarget: { value: null }, uAspect: { value: 1 }, uRadius: { value: 0.001 },
  uPoint: { value: new THREE.Vector2() }, uColor: { value: new THREE.Vector3() },
});

const curlMat = prog(/* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform vec2 uTexel;
  void main(){
    float L = texture2D(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
    float R = texture2D(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
    float B = texture2D(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
    float T = texture2D(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
    gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
  }
`, { uVelocity: { value: null }, uTexel: { value: new THREE.Vector2() } });

const vorticityMat = prog(/* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uVelocity, uCurl;
  uniform vec2 uTexel;
  uniform float uCurlStrength, uDt;
  void main(){
    float L = texture2D(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture2D(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
    float B = texture2D(uCurl, vUv - vec2(0.0, uTexel.y)).x;
    float T = texture2D(uCurl, vUv + vec2(0.0, uTexel.y)).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= uCurlStrength * C;
    force.y *= -1.0;
    vec2 vel = texture2D(uVelocity, vUv).xy + force * uDt;
    gl_FragColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
  }
`, {
  uVelocity: { value: null }, uCurl: { value: null },
  uTexel: { value: new THREE.Vector2() }, uCurlStrength: { value: 0 }, uDt: { value: 0 },
});

const divergeMat = prog(/* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform vec2 uTexel;
  void main(){
    float L = texture2D(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture2D(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
    float B = texture2D(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
    float T = texture2D(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
    vec2 C = texture2D(uVelocity, vUv).xy;
    if (vUv.x - uTexel.x < 0.0) L = -C.x;
    if (vUv.x + uTexel.x > 1.0) R = -C.x;
    if (vUv.y - uTexel.y < 0.0) B = -C.y;
    if (vUv.y + uTexel.y > 1.0) T = -C.y;
    gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
  }
`, { uVelocity: { value: null }, uTexel: { value: new THREE.Vector2() } });

const pressureMat = prog(/* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uPressure, uDivergence;
  uniform vec2 uTexel;
  void main(){
    float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
    float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
    float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
    float div = texture2D(uDivergence, vUv).x;
    gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
  }
`, { uPressure: { value: null }, uDivergence: { value: null }, uTexel: { value: new THREE.Vector2() } });

const gradientMat = prog(/* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uPressure, uVelocity;
  uniform vec2 uTexel;
  void main(){
    float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
    float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
    float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
    vec2 vel = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
    gl_FragColor = vec4(vel, 0.0, 1.0);
  }
`, { uPressure: { value: null }, uVelocity: { value: null }, uTexel: { value: new THREE.Vector2() } });

const clearMat = prog(/* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uValue;
  void main(){ gl_FragColor = uValue * texture2D(uTexture, vUv); }
`, { uTexture: { value: null }, uValue: { value: 0.8 } });

/* ── 表示: 和紙テクスチャ + 減法混色 ── */
const displayMat = prog(/* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uDye;
  uniform vec2 uTexel;
  uniform vec3 uPaper;
  uniform float uTime;
  uniform float uTransparent;

  float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p){
    vec2 i=floor(p), f=fract(p);
    f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
               mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
  }

  void main(){
    // 和紙の繊維ノイズ
    float fiber = noise(vUv * 420.0) * 0.028
                + noise(vUv * 180.0) * 0.022
                + noise(vUv * 60.0)  * 0.018;

    // 吸光度 A を取得
    vec3 A = texture2D(uDye, vUv).rgb;

    // 減法混色: paper × exp(-A) + fiber
    vec3 col = uPaper * exp(-A) + fiber;

    // 端の暗み(和紙の縁)
    vec2 uv2 = vUv * (1.0 - vUv.yx);
    float vign = pow(uv2.x * uv2.y * 15.0, 0.18);
    col *= 0.92 + 0.08 * vign;

    vec3 transmittance = exp(-max(A, vec3(0.0)));
    float opacity = 1.0 - min(min(transmittance.r, transmittance.g), transmittance.b);
    vec3 pigment = (transmittance - vec3(1.0-opacity)) / max(opacity, 0.00001);
    gl_FragColor = uTransparent > 0.5 ? vec4(clamp(pigment,0.0,1.0),opacity) : vec4(clamp(col,0.0,1.0),1.0);
  }
`, {
  uDye: { value: null }, uTexel: { value: new THREE.Vector2() },
  uPaper: { value: new THREE.Vector3(PAPER.r, PAPER.g, PAPER.b) },
  uTime: { value: 0 }, uTransparent: {value:0},
});

/* ── blit ── */
function blit(mat, target) {
  quad.material = mat;
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
}

/* ── スプラット ── */
function splatVelocity(x, y, fx, fy, radiusMul) {
  splatMat.uniforms.uTarget.value = velocity.read.texture;
  splatMat.uniforms.uAspect.value = innerWidth / innerHeight;
  splatMat.uniforms.uPoint.value.set(x, y);
  splatMat.uniforms.uRadius.value = config.SPLAT_RADIUS * (radiusMul || 1);
  splatMat.uniforms.uColor.value.set(fx, fy, 0);
  blit(splatMat, velocity.write);
  velocity.swap();
}
function splatDye(x, y, absorption, radiusMul) {
  splatMat.uniforms.uTarget.value = dye.read.texture;
  splatMat.uniforms.uAspect.value = innerWidth / innerHeight;
  splatMat.uniforms.uPoint.value.set(x, y);
  splatMat.uniforms.uRadius.value = config.SPLAT_RADIUS * (radiusMul || 1);
  splatMat.uniforms.uColor.value.copy(absorption);
  blit(splatMat, dye.write);
  dye.swap();
}

/* ── 一滴落とす ── */
function dropInk(x, y, color, strength) {
  const abs = inkAbsorption(color, strength * 0.22);
  splatDye(x, y, abs, 1.0);
  const angle = Math.random() * Math.PI * 2;
  const speed = 60 + Math.random() * 80;
  splatVelocity(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, 1.2);
}

/* ── インクモード ── */
let inkMode = 'cycle';
let inkCycleIdx = 0;
function currentInkColor(advance) {
  if (inkMode === 'cycle') {
    const c = INKS[INK_KEYS[inkCycleIdx % INK_KEYS.length]];
    if (advance) inkCycleIdx++;
    return c;
  }
  return INKS[inkMode] || INKS.sumi;
}

/* ── ポインタ ── */
const pointer = { down: false, moved: false, x: 0, y: 0, px: 0, py: 0, color: INKS.sumi };
let lastInteraction = 0;

function toUV(e) {
  const r = renderer.domElement.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height };
}
const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', e => {
  const p = toUV(e);
  if (paused) setPaused(false);
  canvas.setPointerCapture(e.pointerId);
  pointer.down = true;
  pointer.x = pointer.px = p.x; pointer.y = pointer.py = p.y;
  pointer.color = currentInkColor(true);
  dropInk(p.x, p.y, pointer.color, 0.6 + Math.random() * 0.3);
  lastInteraction = performance.now();
  hideHint();
});
canvas.addEventListener('pointermove', e => {
  const p = toUV(e);
  pointer.px = pointer.x; pointer.py = pointer.y;
  pointer.x = p.x; pointer.y = p.y;
  pointer.moved = true;
  lastInteraction = performance.now();
});
addEventListener('pointerup', () => { pointer.down = false; });
addEventListener('pointercancel', () => { pointer.down = false; });

function applyPointer() {
  if (!pointer.moved) return;
  pointer.moved = false;
  const dx = pointer.x - pointer.px;
  const dy = pointer.y - pointer.py;
  if (Math.abs(dx) + Math.abs(dy) < 1e-6) return;
  const fx = dx * config.SPLAT_FORCE;
  const fy = dy * config.SPLAT_FORCE;
  // ドラッグ中は墨も曳く。ホバーは水だけ動かす
  splatVelocity(pointer.x, pointer.y, fx, fy, pointer.down ? 2.0 : 1.4);
  if (pointer.down) {
    const speed = Math.min(Math.hypot(dx, dy) * 30, 1);
    splatDye(pointer.x, pointer.y, inkAbsorption(pointer.color, 0.06 + speed * 0.12), 0.9);
  }
}

/* ── 自動演出: 滴下と緩い水流 ── */
let autoFlow = true;
let nextDrop = 1200;
let nextStir = 2600;

function autoUpdate(now, dt) {
  if (!autoFlow) return;
  const idle = now - lastInteraction > 3000;

  nextDrop -= dt * 1000;
  if (idle && nextDrop <= 0) {
    const x = 0.14 + Math.random() * 0.72;
    const y = 0.16 + Math.random() * 0.68;
    const c = currentInkColor(true);
    dropInk(x, y, c, 0.8 + Math.random() * 0.7);

    // 三割の確率で近くにもう一滴(別色)を続けて落とし、混色を起こす
    if (Math.random() < 0.3) {
      const c2 = currentInkColor(true);
      const x2 = Math.min(Math.max(x + (Math.random() - 0.5) * 0.16, 0.08), 0.92);
      const y2 = Math.min(Math.max(y + (Math.random() - 0.5) * 0.16, 0.08), 0.92);
      setTimeout(() => dropInk(x2, y2, c2, 0.5 + Math.random() * 0.4), 220 + Math.random() * 300);
    }
    nextDrop = (reducedMotion ? 6500 : 2600) + Math.random() * 2600;
  }

  // 弱い"水流"で全体をゆっくり巡らせる
  nextStir -= dt * 1000;
  if (!reducedMotion && nextStir <= 0) {
    const t = now * 0.00012;
    const cx = 0.5 + Math.sin(t * 1.7) * 0.3;
    const cy = 0.5 + Math.cos(t * 1.1) * 0.3;
    const a = t * 6.0 + Math.random() * 1.5;
    splatVelocity(cx, cy, Math.cos(a) * 130, Math.sin(a) * 130, 14);
    nextStir = 700 + Math.random() * 900;
  }
}

/* ── 洗い流し ── */
let washing = 0;
function wash() { clearArtwork(); }

/* ── シミュレーションステップ ── */
function step(dt) {
  const sw = S.sw, sh = S.sh;

  // curl
  curlMat.uniforms.uVelocity.value = velocity.read.texture;
  curlMat.uniforms.uTexel.value.copy(velocity.texel);
  blit(curlMat, curlRT);

  // vorticity confinement
  vorticityMat.uniforms.uVelocity.value = velocity.read.texture;
  vorticityMat.uniforms.uCurl.value = curlRT.texture;
  vorticityMat.uniforms.uTexel.value.copy(velocity.texel);
  vorticityMat.uniforms.uCurlStrength.value = config.CURL;
  vorticityMat.uniforms.uDt.value = dt;
  blit(vorticityMat, velocity.write);
  velocity.swap();

  // divergence
  divergeMat.uniforms.uVelocity.value = velocity.read.texture;
  divergeMat.uniforms.uTexel.value.copy(velocity.texel);
  blit(divergeMat, divergeRT);

  // pressure: 減衰させてから反復
  clearMat.uniforms.uTexture.value = pressure.read.texture;
  clearMat.uniforms.uValue.value = 0.8;
  blit(clearMat, pressure.write);
  pressure.swap();

  pressureMat.uniforms.uDivergence.value = divergeRT.texture;
  pressureMat.uniforms.uTexel.value.copy(velocity.texel);
  for (let i = 0; i < config.PRESSURE_ITER; i++) {
    pressureMat.uniforms.uPressure.value = pressure.read.texture;
    blit(pressureMat, pressure.write);
    pressure.swap();
  }

  // gradient subtract
  gradientMat.uniforms.uPressure.value = pressure.read.texture;
  gradientMat.uniforms.uVelocity.value = velocity.read.texture;
  gradientMat.uniforms.uTexel.value.copy(velocity.texel);
  blit(gradientMat, velocity.write);
  velocity.swap();

  // advect velocity
  advectMat.uniforms.uVelocity.value = velocity.read.texture;
  advectMat.uniforms.uSource.value = velocity.read.texture;
  advectMat.uniforms.uTexel.value.copy(velocity.texel);
  advectMat.uniforms.uDt.value = dt;
  advectMat.uniforms.uDissipation.value = config.VEL_DISSIPATION;
  blit(advectMat, velocity.write);
  velocity.swap();

  // advect dye
  const dyeDis = config.DYE_DISSIPATION + (washing > 0 ? 2.4 : 0);
  advectMat.uniforms.uVelocity.value = velocity.read.texture;
  advectMat.uniforms.uSource.value = dye.read.texture;
  advectMat.uniforms.uTexel.value.copy(dye.texel);
  advectMat.uniforms.uDissipation.value = dyeDis;
  blit(advectMat, dye.write);
  dye.swap();

  if (washing > 0) washing -= dt;
}

/* ── メインループ ── */
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastT) / 1000;
  lastT = now;
  dt = Math.min(dt, 1 / 30);
  if (dt <= 0) return;

  if (!paused) {
  applyPointer();
  autoUpdate(now, dt);
  step(dt);
  updateWeather(dt);
  }
  drawWeather();

  displayMat.uniforms.uDye.value = dye.read.texture;
  displayMat.uniforms.uTexel.value.copy(dye.texel);
  displayMat.uniforms.uTime.value = now * 0.001;
  blit(displayMat, null);
}

/* ── 初期演出: 三滴 ── */
function seed() {
  dropInk(0.38, 0.58, INKS.sumi, 0.75);
  setTimeout(() => dropInk(0.62, 0.42, INKS.ai, 0.6), 450);
  setTimeout(() => dropInk(0.5, 0.62, INKS.shu, 0.5), 950);
}

/* ── UI ── */
const hintEl = document.getElementById('hint');
let hintHidden = false;
function hideHint() {
  if (hintHidden) return;
  hintHidden = true;
  hintEl.classList.add('gone');
}
setTimeout(hideHint, 9000);

document.getElementById('inks').addEventListener('click', e => {
  const btn = e.target.closest('.ink');
  if (!btn) return;
  inkMode = btn.dataset.ink;
  document.querySelectorAll('.ink').forEach(b =>
    b.setAttribute('aria-pressed', String(b === btn)));
});

const autoBtn = document.getElementById('autoBtn');
autoBtn.addEventListener('click', () => {
  autoFlow = !autoFlow;
  autoBtn.setAttribute('aria-pressed', String(autoFlow));
});

document.getElementById('washBtn').addEventListener('click', wash);

addEventListener('keydown', e => {
  if (/INPUT|SELECT|BUTTON/.test(e.target.tagName)) return;
  if (e.code === 'Space') {
    e.preventDefault();
    dropInk(0.2 + Math.random() * 0.6, 0.2 + Math.random() * 0.6, currentInkColor(true), 0.8 + Math.random() * 0.6);
    hideHint();
  }
  if (e.key === 'x' || e.key === 'X') wash();
});

/* ── リサイズ ── */
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  S = simSizes();
  velocity.resize(S.sw, S.sh);
  pressure.resize(S.sw, S.sh);
  curlRT.setSize(S.sw, S.sh);
  divergeRT.setSize(S.sw, S.sh);
  dye.resize(S.dw, S.dh);
});

let birdsEnabled=false, birds=[], flockClock=0;
let paused=false, weatherMode='ink', particles=[], ripples=[], spawnClock=0, strength=1;
const weather=document.createElement('canvas');weather.className='weather';document.body.append(weather);
const wc=weather.getContext('2d');
const notify=message=>{const el=document.getElementById('status');el.textContent=message;el.classList.add('show');clearTimeout(notify.timer);notify.timer=setTimeout(()=>el.classList.remove('show'),2600);};
function resizeWeather(){weather.width=Math.round(innerWidth*Math.min(devicePixelRatio,2));weather.height=Math.round(innerHeight*Math.min(devicePixelRatio,2));}
resizeWeather();addEventListener('resize',resizeWeather);
function setPaused(value){paused=value;document.getElementById('pauseBtn').textContent=value?'继续':'暂停';document.getElementById('pauseBtn').setAttribute('aria-pressed',String(value));}
function clearArtwork(){birds=[];flockClock=0;particles=[];ripples=[];for(const rt of [velocity.read,velocity.write,dye.read,dye.write,pressure.read,pressure.write,curlRT,divergeRT]){renderer.setRenderTarget(rt);renderer.setClearColor(0,0);renderer.clear();}renderer.setRenderTarget(null);spawnClock=-1;nextDrop=3000;notify('画布已清空');}
function setMode(mode){if(!['ink','rain','flowers','both'].includes(mode))throw new Error('未知风格');weatherMode=mode;particles=[];ripples=[];spawnClock=0;document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));if(mode!=='ink'){for(let i=0;i<(mode==='flowers'?18:35);i++)spawnParticle(true);dropInk(.35,.6,INKS.jade,.55);dropInk(.65,.4,INKS.pink,.4);}drawWeather();}
// Small watercolor stamps are rasterized once. Their silhouette and pose never
// depend on animation time; only position and atmospheric opacity change.
const petalStamps=[],birdStamps=[];
function makeStamp(kind,index){
 const c=document.createElement('canvas');c.width=192;c.height=128;
 const ink=document.createElement('canvas');ink.width=c.width;ink.height=c.height;
 const q=ink.getContext('2d');q.translate(96,64);
 if(kind==='petal'){
  q.rotate([-.5,.32,-.95,.8,.1,-.2][index]);
  q.scale([1,.8,1.1,.72,.92,1][index],[.85,1,.72,.92,1,.8][index]);
  const g=q.createLinearGradient(-25,-30,25,32);
  g.addColorStop(0,['#f7c5c7','#f3bdc2','#f8cdca'][index%3]);g.addColorStop(.65,'#eaa6b180');g.addColorStop(1,'#de98a54a');q.fillStyle=g;
  q.beginPath();q.moveTo(12,31);q.bezierCurveTo(-7,31,-34,6,-28,-15);q.bezierCurveTo(-26,-34,-11,-35,-4,-26);q.bezierCurveTo(9,-39,30,-18,28,-3);q.bezierCurveTo(27,12,17,21,12,31);q.fill();
  // Diluted pigment settling unevenly, without a glossy highlight or outline.
  q.globalCompositeOperation='source-atop';
  for(let j=0;j<60;j++){const x=Math.sin(j*12.989+index)*32,y=Math.cos(j*8.137+index)*36;q.fillStyle=j%2?'#fce0df0c':'#b46d8106';q.beginPath();q.ellipse(x,y,2+(j%5),1+(j%3),.4,0,Math.PI*2);q.fill();}
 }else{
  const color=index<3?'#eff5ed':'#71a1a4';
  const g=q.createLinearGradient(-68,0,46,0);g.addColorStop(0,color+'00');g.addColorStop(.32,color+'70');g.addColorStop(.7,color+'e0');g.addColorStop(1,color+'b0');q.fillStyle=g;
  const reach=[29,21,34][index%3];
  // Swept, brushlike wings: broad at the breast, trailing to fine soft tips.
  q.beginPath();q.moveTo(48,0);q.quadraticCurveTo(40,-3,31,-5);q.bezierCurveTo(22,-15,-12,-reach,-63,-reach-3);q.bezierCurveTo(-30,-reach+8,3,-9,9,-3);q.lineTo(-53,-9);q.quadraticCurveTo(-34,-1,-21,1);q.lineTo(-57,12);q.quadraticCurveTo(-23,11,8,5);q.bezierCurveTo(-2,16,-31,reach-1,-65,reach+5);q.bezierCurveTo(-12,reach+5,23,16,32,5);q.quadraticCurveTo(41,3,48,0);q.fill();
 }
 const out=c.getContext('2d');out.globalAlpha=.28;out.filter=kind==='petal'?'blur(3.3px)':'blur(2px)';out.drawImage(ink,0,0);out.globalAlpha=.83;out.filter=kind==='petal'?'blur(1.15px)':'blur(0.65px)';out.drawImage(ink,0,0);return c;
}
for(let i=0;i<6;i++){petalStamps.push(makeStamp('petal',i));birdStamps.push(makeStamp('bird',i));}
function spawnParticle(initial=false){
 const flower=weatherMode==='flowers'||(weatherMode==='both'&&Math.random()<.2),depth=Math.random();
 const wind=Number(document.getElementById('wind').value)/100;
 const fromSide=flower&&!initial&&Math.abs(wind)>.3&&Math.random()<.45;
 particles.push({flower,x:fromSide?(wind<0?1.06:-.06):Math.random()*1.1-.05,y:initial?Math.random():fromSide?Math.random()*.8:-.06,age:initial?4:0,phase:Math.random()*6.28,size:flower?7+depth*16:15+Math.random()*42,speed:flower?.009+depth*.012:.4+Math.random()*.45,drift:.007+Math.random()*.01,stamp:Math.floor(Math.random()*6),color:'#367f87',alpha:flower?.3+depth*.35:.09+Math.random()*.23});
}
function setBirds(enabled){birdsEnabled=enabled;const b=document.getElementById('birdsBtn');b.textContent=enabled?'飞鸟 · 开启':'飞鸟 · 关闭';b.setAttribute('aria-pressed',String(enabled));birds=[];flockClock=0;if(enabled)spawnFlock(true);drawWeather();}
function spawnFlock(initial=false){
 const direction=Number(document.getElementById('wind').value)<0?-1:1,density=Number(document.getElementById('birdAmount').value)/50;
 const count=Math.max(3,Math.round((4+Math.random()*5)*density));
 const y=.2+Math.random()*.55,x=initial?.35+Math.random()*.25:(direction>0?-.14:1.14);
 const depth=Math.random(),speed=.024+depth*.013,phase=Math.random()*6.28,rise=-.003-Math.random()*.004,tone=Math.random()<.55?0:3;
 let lag=0;
 for(let i=0;i<count&&birds.length<70;i++){
  lag+=.014+Math.random()*.025;
  // Uneven spacing and shared gentle current replace the mechanical V formation.
  const by=y+(Math.random()-.5)*.065;
  birds.push({x:x-direction*lag,y:by,baseY:by,age:initial?4:0,phase,speed:speed*(.97+Math.random()*.06),direction,size:11+depth*14+Math.random()*5,alpha:.33+depth*.33,stamp:tone+Math.floor(Math.random()*3),rise});
 }
}
function updateWeather(dt){
 const amount=Number(document.getElementById('amount').value)/60,wind=Number(document.getElementById('wind').value)/100;
 if(birdsEnabled){flockClock+=dt;if(autoFlow&&flockClock>10+7/(Number(document.getElementById('birdAmount').value)/50)){flockClock=0;spawnFlock();}
  for(const b of birds){b.age+=dt;b.x+=b.direction*(b.speed+Math.abs(wind)*.014)*dt;b.baseY+=b.rise*dt;b.y=b.baseY+Math.sin(b.age*.16+b.phase)*.004;}
  birds=birds.filter(b=>b.x>-.6&&b.x<1.6&&b.y>-.15&&b.y<1.15);
 }
 if(weatherMode==='ink')return;
 spawnClock+=dt;
 if(autoFlow){const interval=(weatherMode==='flowers'?1.5:.055)/amount;while(spawnClock>interval){spawnClock-=interval;if(particles.length<(weatherMode==='flowers'?90:350))spawnParticle();}}else spawnClock=0;
 for(const p of particles){p.age+=dt;p.y+=p.speed*dt;p.x+=(p.flower?(wind*.024+p.drift*.35+Math.sin(p.age*.22+p.phase)*.0025):wind*.24)*dt;
  if(!p.flower&&p.y>.97){ripples.push({x:p.x,y:.85+Math.random()*.13,age:0});if(Math.random()<.13)splatDye(Math.max(.01,Math.min(.99,p.x)),1-p.y,inkAbsorption(INKS.jade,.009*strength),.1);p.y=2;}
 }
 particles=particles.filter(p=>p.y<1.12&&p.x>-.3&&p.x<1.3);for(const r of ripples)r.age+=dt;ripples=ripples.filter(r=>r.age<1.4);
}
function atmosphere(p){const entry=Math.min(1,p.age/2.8),edge=Math.min(1,Math.max(0,Math.min(p.x+.025,1.025-p.x,p.y+.025,1.025-p.y))/.09);return entry*entry*(3-2*entry)*edge*edge*(3-2*edge);}
function drawPetal(ctx,p){const s=p.size;ctx.drawImage(petalStamps[p.stamp],-s*1.5,-s,s*3,s*2);}
function drawBird(ctx,b){const s=b.size;ctx.scale(b.direction,1);ctx.drawImage(birdStamps[b.stamp],-s*1.5,-s,s*3,s*2);}
function drawWeather(ctx=wc,width=weather.width,height=weather.height){ctx.clearRect(0,0,width,height);const scale=width/innerWidth,wind=Number(document.getElementById('wind').value)/100;ctx.save();ctx.scale(scale,scale);const W=innerWidth,H=innerHeight;
 for(const b of birds){ctx.save();ctx.translate(b.x*W,b.y*H);ctx.globalAlpha=b.alpha*atmosphere(b);drawBird(ctx,b);ctx.restore();}
 for(const p of particles){ctx.save();ctx.translate(p.x*W,p.y*H);ctx.globalAlpha=p.alpha*(p.flower?atmosphere(p):1);if(p.flower)drawPetal(ctx,p);else{ctx.strokeStyle=p.color;ctx.lineWidth=.55+(p.speed-.4)*1.3;ctx.beginPath();ctx.moveTo(-wind*p.size*.4,-p.size);ctx.lineTo(0,0);ctx.stroke();}ctx.restore();}
 for(const r of ripples){ctx.globalAlpha=.17*(1-r.age/1.4);ctx.strokeStyle='#367f87';ctx.lineWidth=.8;ctx.beginPath();ctx.ellipse(r.x*W,r.y*H,4+r.age*30,1+r.age*6,0,0,Math.PI*2);ctx.stroke();}ctx.restore();}

async function exportPNG(){const btn=document.getElementById('exportBtn');btn.disabled=true;const original=displayMat.uniforms.uTransparent.value;let target;
try{const option=Number(document.getElementById('exportSize').value),aspect=innerWidth/innerHeight;const w=option===1?renderer.domElement.width:Math.round(aspect>=1?option:option*aspect);const h=option===1?renderer.domElement.height:Math.round(aspect>=1?option/aspect:option);target=new THREE.WebGLRenderTarget(w,h,{type:THREE.UnsignedByteType,format:THREE.RGBAFormat,depthBuffer:false});displayMat.uniforms.uTransparent.value=1;displayMat.uniforms.uDye.value=dye.read.texture;blit(displayMat,target);const pixels=new Uint8Array(w*h*4);renderer.readRenderTargetPixels(target,0,0,w,h,pixels);const out=document.createElement('canvas');out.width=w;out.height=h;const ctx=out.getContext('2d');const img=ctx.createImageData(w,h);for(let y=0;y<h;y++)img.data.set(pixels.subarray((h-1-y)*w*4,(h-y)*w*4),y*w*4);ctx.putImageData(img,0,0);const overlay=document.createElement('canvas');overlay.width=w;overlay.height=h;drawWeather(overlay.getContext('2d'),w,h);ctx.drawImage(overlay,0,0);const blob=await new Promise(resolve=>out.toBlob(resolve,'image/png'));if(!blob)throw new Error('无法编码图像');const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`墨流-${weatherMode}-${w}x${h}-${Date.now()}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);notify(`已导出透明 PNG · ${w} × ${h}`);return {width:w,height:h,transparent:true};}catch(e){notify('导出失败，请尝试较小尺寸');throw e;}finally{target?.dispose();displayMat.uniforms.uTransparent.value=original;blit(displayMat,null);btn.disabled=false;}}
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
document.getElementById('birdsBtn').onclick=()=>setBirds(!birdsEnabled);
document.getElementById('birdAmount').oninput=e=>{document.getElementById('birdAmountValue').value=e.target.value+'%';};
document.getElementById('pauseBtn').onclick=()=>setPaused(!paused);
document.getElementById('exportBtn').onclick=()=>exportPNG().catch(()=>{});
document.getElementById('transparent').onchange=e=>{displayMat.uniforms.uTransparent.value=e.target.checked?1:0;document.body.classList.toggle('checker',e.target.checked);};
for(const id of ['density','amount','wind'])document.getElementById(id).oninput=e=>{document.getElementById(id+'Value').value=e.target.value+(id==='wind'?'':'%');if(id==='density')strength=Number(e.target.value)/100;};
const originalAbsorption=inkAbsorption;inkAbsorption=(c,s)=>originalAbsorption(c,s*strength);
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();setPaused(true);notify('渲染已中断，请刷新页面重新开始');});
if(reducedMotion){setPaused(true);autoFlow=false;autoBtn.setAttribute('aria-pressed','false');}
if(document.modelContext?.registerTool){const life=new AbortController();addEventListener('pagehide',()=>life.abort(),{once:true});Promise.resolve(document.modelContext.registerTool({name:'set_ink_scene',description:'设置当前水墨画布的水墨、雨天、落花或雨落花风格，并选择是否暂停。',inputSchema:{type:'object',properties:{mode:{type:'string',enum:['ink','rain','flowers','both']},paused:{type:'boolean'},birds:{type:'boolean'}},required:['mode'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input||!['ink','rain','flowers','both'].includes(input.mode)||('paused'in input&&typeof input.paused!=='boolean')||('birds'in input&&typeof input.birds!=='boolean'))throw new Error('无效参数');setMode(input.mode);if('paused'in input)setPaused(input.paused);if('birds'in input)setBirds(input.birds);return{mode:weatherMode,paused,birds:birdsEnabled};}},{signal:life.signal})).catch(()=>{});}

seed();
requestAnimationFrame(frame);
})();
