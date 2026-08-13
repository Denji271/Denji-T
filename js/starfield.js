/**
 * Starfield — Three.js csillagmező háttér
 * Teljes oldalas fixed canvas, ES-module importmap-pel.
 * Denji-T oldalba integrálva.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GammaCorrectionShader } from 'three/addons/shaders/GammaCorrectionShader.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

/* ── CONFIG ── */
const CONFIG = {
  bgColor: '#0c0a08',
  flameColor: '#a0e0ab',
  flameColor2: '#ffac2e',
  flameAmt: 0.18,
  colorA: '#a0e0ab',       // zöld  (--irid-a)
  colorB: '#ffac2e',       // narancs (--irid-b)
  colorC: '#c84a3a',       // meleg vörös (--irid-c)
  opacity: 2,
  pointSize: 50,
  brightness: 1.85,
  drift: 2.35,
  twinkle: 1,
  spin: 0.03,
  repelRadius: 5,
  repelStrength: 0.35,
  scrollPush: 8,
  scrollDrift: 6,
  scrollSpin: 0.1,
  parallax: 0.6,
};

const LAYERS = { NONE: 0, TORUS_SCENE: 1, BLOOM_SCENE: 2, ENTIRE_SCENE: 3 };

function hexToVec3(hex) {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/* ── SETUP ── */
const canvas = document.getElementById('starfield');
if (!canvas) throw new Error('Starfield: #starfield canvas not found');

const renderer = new THREE.WebGL1Renderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.Fog(0x000000, 0, 15);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 80);
camera.position.set(0, 0, 5);
camera.layers.enable(LAYERS.TORUS_SCENE);
camera.layers.enable(LAYERS.BLOOM_SCENE);
camera.layers.enable(LAYERS.ENTIRE_SCENE);
scene.add(camera);

/* ── GEOMETRY ── */
const count = 4200;
const depth = 30;

const positions = new Float32Array(count * 3);
const palette = new Float32Array(count);
const bright = new Float32Array(count);
const scales = new Float32Array(count);
const phases = new Float32Array(count);

for (let i = 0; i < count; i++) {
  const i3 = i * 3;
  positions[i3]     = (Math.random() - 0.5) * 24;
  positions[i3 + 1] = (Math.random() - 0.5) * 16;
  positions[i3 + 2] = (Math.random() - 0.5) * 30;
  palette[i] = Math.floor(Math.random() * 3);
  bright[i]  = 0.7 + Math.random() * 0.6;
  scales[i]  = 0.5 + Math.pow(Math.random(), 1.4) * 2.5;
  phases[i]  = Math.random();
}

const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
geo.setAttribute('aScale',   new THREE.Float32BufferAttribute(scales, 1));
geo.setAttribute('aPhase',   new THREE.Float32BufferAttribute(phases, 1));
geo.setAttribute('aPalette', new THREE.Float32BufferAttribute(palette, 1));
geo.setAttribute('aBright',  new THREE.Float32BufferAttribute(bright, 1));

/* ── MATERIAL ── */
const starMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uTime: { value: 0 },
    uSize: { value: CONFIG.pointSize },
    uOpacity: { value: 0 },
    uDrift: { value: 0 },
    uDepth: { value: depth },
    uTwinkle: { value: CONFIG.twinkle },
    uCursor: { value: new THREE.Vector3() },
    uRepelRadius: { value: CONFIG.repelRadius },
    uRepelStrength: { value: CONFIG.repelStrength },
    uActivity: { value: 0 },
    uColorA: { value: hexToVec3(CONFIG.colorA) },
    uColorB: { value: hexToVec3(CONFIG.colorB) },
    uColorC: { value: hexToVec3(CONFIG.colorC) },
    uBrightness: { value: CONFIG.brightness },
  },
  vertexShader: /* glsl */ `
    uniform float uTime; uniform float uSize; uniform float uDrift; uniform float uDepth; uniform float uTwinkle;
    uniform vec3 uCursor; uniform float uRepelRadius; uniform float uRepelStrength; uniform float uActivity;
    uniform vec3 uColorA; uniform vec3 uColorB; uniform vec3 uColorC;
    attribute float aScale; attribute float aPhase; attribute float aPalette; attribute float aBright;
    varying vec3 vColor; varying float vTwinkle;
    void main() {
      vec3 pos = position;
      pos.z = mod(pos.z + uDrift + (uDepth * 0.5), uDepth) - (uDepth * 0.5);

      float tw = sin(uTime * 1.6 + aPhase * 6.2831);
      vTwinkle = (1.0 - uTwinkle) + uTwinkle * (0.55 + 0.45 * tw);

      vec4 modelPosition = modelMatrix * vec4(pos, 1.0);

      vec3 toParticle = modelPosition.xyz - uCursor;
      float dist = length(toParticle);
      float falloff = smoothstep(uRepelRadius, 0.0, dist);
      modelPosition.xyz += normalize(toParticle + vec3(0.0001)) * falloff * uRepelStrength * uActivity;

      vec4 viewPosition = viewMatrix * modelPosition;
      gl_Position = projectionMatrix * viewPosition;
      gl_PointSize = uSize * aScale;
      gl_PointSize *= (1.0 / -viewPosition.z);

      vec3 base = aPalette < 0.5 ? uColorA : (aPalette < 1.5 ? uColorB : uColorC);
      vColor = base * aBright;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uOpacity; uniform float uBrightness;
    varying vec3 vColor; varying float vTwinkle;
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float d = length(uv);
      if (d > 0.5) discard;
      float strength = pow(1.0 - d * 2.0, 4.0);
      vec3 color = mix(vec3(0.0), vColor, strength);
      gl_FragColor = vec4(color * uBrightness, strength * uOpacity * vTwinkle);
    }
  `,
});

const points = new THREE.Points(geo, starMaterial);
points.layers.enable(LAYERS.ENTIRE_SCENE);
const group = new THREE.Group();
group.add(points);
scene.add(group);

/* ── POSTPROCESSING ── */
const renderScene = new RenderPass(scene, camera);
const res = new THREE.Vector2(innerWidth, innerHeight);

// Torus composer
const torusComposer = new EffectComposer(renderer);
torusComposer.renderToScreen = false;
torusComposer.addPass(renderScene);
torusComposer.addPass(new ShaderPass(GammaCorrectionShader));
torusComposer.addPass(new UnrealBloomPass(res.clone(), 0.22, 0.2, 0));
torusComposer.addPass(new ShaderPass(CopyShader));

// Bloom composer
const bloomComposer = new EffectComposer(renderer);
bloomComposer.renderToScreen = false;
bloomComposer.addPass(renderScene);
bloomComposer.addPass(new UnrealBloomPass(res.clone(), 0.4, 0.55, 0));
bloomComposer.addPass(new ShaderPass(GammaCorrectionShader));

// FinalPass shader
const FinalPassShader = {
  uniforms: {
    iTime:        { value: 0 },
    tDiffuse:     { value: null },
    torusTexture: { value: null },
    bloomTexture: { value: null },
    haloTexture:  { value: null },
    uBg:       { value: hexToVec3(CONFIG.bgColor) },
    uFlameA:   { value: hexToVec3(CONFIG.flameColor) },
    uFlameB:   { value: hexToVec3(CONFIG.flameColor2) },
    uFlameAmt: { value: CONFIG.flameAmt },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform float iTime; uniform sampler2D tDiffuse; uniform sampler2D bloomTexture; uniform sampler2D torusTexture; uniform sampler2D haloTexture;
    uniform vec3 uBg; uniform vec3 uFlameA; uniform vec3 uFlameB; uniform float uFlameAmt;
    varying vec2 vUv;
    vec3 warp3d(vec3 pos, float t){ float curv=.8,a=1.9,b=0.7; pos*=2.;
      pos.x+=curv*sin(t+a*pos.y)+t*b; pos.y+=curv*cos(t+a*pos.x);
      pos.y+=curv*sin(t+a*pos.z)+t*b; pos.z+=curv*cos(t+a*pos.y);
      pos.z+=curv*sin(t+a*pos.x)+t*b; pos.x+=curv*cos(t+a*pos.z);
      return 0.5+0.5*cos(pos.xyz+vec3(1,2,4)); }
    void main(){
      vec2 uv = 2.*vUv - 1.;
      vec3 w = pow(warp3d(vec3(uv.x, sin(uv.y), uv.y), iTime*1.5), vec3(1.5));
      vec3 flame = 1.5*uFlameA*w.x; flame*=w.y; flame += uFlameB*w.z;
      flame *= smoothstep(0.25, 1., abs(uv.y));
      float md = smoothstep(-0.7, 1., -uv.y*uv.x); flame *= md*md;
      vec3 bg = uBg * (1.0 - 0.4 * length(uv));
      vec3 halo = texture2D(haloTexture, vUv).xyz;
      gl_FragColor = vec4(bg + flame*uFlameAmt + texture2D(bloomTexture, vUv).xyz + texture2D(torusTexture, vUv).xyz + texture2D(tDiffuse, vUv).xyz + halo, 1.);
    }
  `,
};

// Create a 1×1 black texture for the unused haloTexture
const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
blackTex.needsUpdate = true;
FinalPassShader.uniforms.haloTexture.value = blackTex;

// Final composer
const finalComposer = new EffectComposer(renderer);
const finalPass = new ShaderPass(FinalPassShader);
finalComposer.addPass(renderScene);
finalComposer.addPass(finalPass);

finalPass.uniforms.bloomTexture.value = bloomComposer.renderTarget1.texture;
finalPass.uniforms.torusTexture.value = torusComposer.renderTarget1.texture;

/* ── POINTER ── */
const POINTER = {
  ndc: { x: 0, y: 0 },
  world: new THREE.Vector3(),
  activity: 0,
  active: false,
  lastMove: 0,
};
const mouseSmooth = { x: 0, y: 0 };

document.addEventListener('mousemove', (e) => {
  POINTER.ndc.x = (e.clientX / innerWidth) * 2 - 1;
  POINTER.ndc.y = -(e.clientY / innerHeight) * 2 - 1;
  POINTER.active = true;
  POINTER.lastMove = performance.now();
}, { passive: true });

document.addEventListener('mouseout', () => {
  POINTER.active = false;
});

function updatePointer() {
  let target;
  if (POINTER.active) {
    const ndc = new THREE.Vector3(POINTER.ndc.x, POINTER.ndc.y, 0.5);
    ndc.unproject(camera);
    const dir = ndc.sub(camera.position).normalize();
    if (Math.abs(dir.z) > 1e-4) {
      const t = -camera.position.z / dir.z;
      if (t > 0 && isFinite(t)) {
        target = new THREE.Vector3().copy(camera.position).addScaledVector(dir, t);
      }
    }
  }
  if (!target) target = new THREE.Vector3(0, 0, 0);
  POINTER.world.lerp(target, 0.12);

  const idle = (performance.now() - POINTER.lastMove) / 1000;
  const want = (POINTER.active && idle < 3) ? 1 : 0;
  POINTER.activity += (want - POINTER.activity) * 0.06;
}

/* ── SCROLL ── */
let scrollTarget = 0;
let scrollSmooth = 0;
let scrollCurrent = 0;

function updateScroll() {
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  scrollTarget = maxScroll > 0 ? Math.max(0, Math.min(1, window.scrollY / maxScroll)) : 0;
  scrollSmooth += (scrollTarget - scrollSmooth) * 0.10;
  scrollCurrent += (scrollSmooth - scrollCurrent) * 0.06;
}

/* ── ANIMATION ── */
let t0 = performance.now() / 1000;
const appearStart = performance.now();
let paused = false;

function animate() {
  if (paused) { requestAnimationFrame(animate); return; }

  const t = performance.now() / 1000;
  const dt = Math.min(0.05, t - t0);
  t0 = t;

  updateScroll();
  updatePointer();

  // Mouse smooth
  mouseSmooth.x += (POINTER.ndc.x - mouseSmooth.x) * 0.06;
  mouseSmooth.y += (POINTER.ndc.y - mouseSmooth.y) * 0.06;

  const scroll = scrollCurrent;
  const m = mouseSmooth;

  // Uniforms
  starMaterial.uniforms.uTime.value = t;
  starMaterial.uniforms.uDrift.value += dt * (CONFIG.drift + scroll * CONFIG.scrollDrift);
  starMaterial.uniforms.uCursor.value.copy(POINTER.world);
  starMaterial.uniforms.uActivity.value = POINTER.activity;

  // Appear fade
  const elapsed = performance.now() - appearStart;
  const fade = Math.max(0, Math.min(1, (elapsed - 300) / 1400));
  starMaterial.uniforms.uOpacity.value = fade * CONFIG.opacity;

  // Camera
  camera.position.set(m.x * CONFIG.parallax, m.y * CONFIG.parallax, 5 - scroll * CONFIG.scrollPush);
  camera.lookAt(m.x * CONFIG.parallax, m.y * CONFIG.parallax, -10);

  // Group rotation (barrel roll)
  group.rotation.z += dt * (CONFIG.spin + scroll * CONFIG.scrollSpin);

  // FinalPass time
  finalPass.uniforms.iTime.value = t;

  // Render the three composers with layer switching
  camera.layers.set(LAYERS.TORUS_SCENE);
  torusComposer.render();

  camera.layers.set(LAYERS.BLOOM_SCENE);
  bloomComposer.render();

  camera.layers.set(LAYERS.ENTIRE_SCENE);
  finalComposer.render();

  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);

/* ── RESIZE ── */
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h, false);
  torusComposer.setPixelRatio(window.devicePixelRatio);
  torusComposer.setSize(w, h);
  bloomComposer.setPixelRatio(window.devicePixelRatio);
  bloomComposer.setSize(w, h);
  finalComposer.setPixelRatio(window.devicePixelRatio);
  finalComposer.setSize(w, h);
}
window.addEventListener('resize', onResize);

/* ── REDUCED MOTION ── */
function checkMotion() {
  const reduced = document.documentElement.dataset.motion === 'reduced';
  if (reduced) {
    paused = true;
  } else {
    paused = false;
  }
}

// Observe data-motion attribute changes
const motionObserver = new MutationObserver(() => checkMotion());
motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
checkMotion();

/* ── GLOBAL HOOKS (for app.js integration) ── */
window.starfieldPause = () => { paused = true; };
window.starfieldResume = () => {
  if (document.documentElement.dataset.motion !== 'reduced') {
    paused = false;
    t0 = performance.now() / 1000;
  }
};
