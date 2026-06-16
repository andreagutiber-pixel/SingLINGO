/**
 * three-overlay.js v2 — Premium Three.js hand skeleton renderer.
 *
 * Features:
 *   - Pre-pooled meshes — zero per-frame allocations
 *   - EMA landmark smoothing (α=0.62 XY, α=0.38 Z)
 *   - True 3D depth via MediaPipe world-landmark Z coordinate
 *   - CylinderGeometry bones (real 3D tubes between joints)
 *   - Additive-blending glow halos around each joint
 *   - Translucent palm polygon showing hand orientation
 *   - Confidence-driven opacity (hand dims when AI is uncertain)
 *   - Finger-state coloring: green joints = correct, red = wrong
 *
 * Public API  (window.ThreeHandRenderer):
 *   draw(canvas, screenLms, worldLms?, opts?)
 *       opts: { alpha, confidence, fingersUp, targetFingers }
 *   drawSecondary(canvas, screenLms, worldLms?, alpha?)
 *   clear(canvas)
 *   syncSize(canvas, W, H)
 */

// ── Constants ─────────────────────────────────────────────────────────────────

// Each finger chain (including wrist root) for bone tubes
const FINGER_CHAINS = [
  [0, 1, 2, 3, 4],     // thumb
  [0, 5, 6, 7, 8],     // index
  [0, 9, 10, 11, 12],  // middle
  [0, 13, 14, 15, 16], // ring
  [0, 17, 18, 19, 20], // pinky
];

// Flat list of bone connections (same order used to index bone mesh pool)
const BONE_PAIRS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],          // cross-palm
];

// Which finger index (0-5) each landmark belongs to
const LM_FINGER_IDX = [-1,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4];

// Neon palette [wrist, thumb, index, middle, ring, pinky] as THREE.Color hex
const PALETTE = [0xdcebff, 0xff3755, 0xff9b14, 0x32e650, 0x14c8ff, 0xd232ff];

// Bones belonging to cross-palm connections (last 3 in BONE_PAIRS)
const PALM_BONE_START = 20;

// Z depth scale: world landmark Z (meters, ~±0.12) → pixels offset
const Z_SCALE = 80;

// EMA factors
const EMA_XY = 0.62;
const EMA_Z  = 0.38;

// Bone tube radius (pixels)
const BONE_R      = 2.2;
const BONE_R_PALM = 1.6;

// Joint sphere radius
function _jointR(i) {
  if ([4, 8, 12, 16, 20].includes(i)) return 5.0; // fingertips
  if (i === 0)                         return 4.5; // wrist
  if ([5, 9, 13, 17].includes(i))      return 4.0; // MCP knuckles
  return 3.2;                                       // PIP / DIP
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _fingerColor(lmIndex) {
  const f = LM_FINGER_IDX[lmIndex];
  return PALETTE[f === -1 ? 0 : f + 1];
}

function _makeMat(hex, opacity, additive = false) {
  return new THREE.MeshStandardMaterial({
    color:       new THREE.Color(hex),
    emissive:    new THREE.Color(hex),
    emissiveIntensity: 0.65,
    roughness:   0.3,
    metalness:   0.15,
    transparent: true,
    opacity,
    blending:    additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite:  !additive,
  });
}

function _makeBoneMat(hex, opacity) {
  return new THREE.MeshStandardMaterial({
    color:             new THREE.Color(hex),
    emissive:          new THREE.Color(hex),
    emissiveIntensity: 0.50,
    roughness:         0.4,
    metalness:         0.2,
    transparent:       true,
    opacity,
  });
}

/** Update a pre-built cylinder mesh to span from p1 → p2 with given radius. */
// Lazy-initialized so THREE doesn't need to exist at parse time
let _UP = null, _TMP_DIR = null, _TMP_Q = null;
function _setCylinder(mesh, p1, p2, r) {
  if (!_UP) {
    _UP     = new THREE.Vector3(0, 1, 0);
    _TMP_DIR = new THREE.Vector3();
    _TMP_Q   = new THREE.Quaternion();
  }
  _TMP_DIR.subVectors(p2, p1);
  const len = _TMP_DIR.length();
  if (len < 0.5) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.addVectors(p1, p2).multiplyScalar(0.5);
  _TMP_Q.setFromUnitVectors(_UP, _TMP_DIR.normalize());
  mesh.quaternion.copy(_TMP_Q);
  mesh.scale.set(r, len / 2, r); // CylinderGeometry has height=2 by default
}

// ── EMA smoothing ─────────────────────────────────────────────────────────────

const _emaMap = new WeakMap(); // canvas → Map<slot, {x,y,z}[]>

function _emaSmooth(canvas, slot, rawLms, worldLms) {
  if (!rawLms?.length) return null;

  let canvasMap = _emaMap.get(canvas);
  if (!canvasMap) { canvasMap = new Map(); _emaMap.set(canvas, canvasMap); }

  const key = slot;
  if (!canvasMap.has(key)) {
    const init = rawLms.map((lm, i) => ({
      x: lm.x, y: lm.y,
      z: worldLms?.[i]?.z ?? 0,
    }));
    canvasMap.set(key, init);
    return init;
  }

  const prev   = canvasMap.get(key);
  const result = rawLms.map((lm, i) => ({
    x: prev[i].x + EMA_XY * (lm.x - prev[i].x),
    y: prev[i].y + EMA_XY * (lm.y - prev[i].y),
    z: prev[i].z + EMA_Z  * ((worldLms?.[i]?.z ?? 0) - prev[i].z),
  }));
  canvasMap.set(key, result);
  return result;
}

// ── Per-canvas renderer context ───────────────────────────────────────────────

const _ctxMap = new WeakMap();

function _createCtx(canvas) {
  if (!window.THREE) return null;

  const W = canvas.width  || 640;
  const H = canvas.height || 480;

  // Renderer
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = false;
  renderer.autoClear = false;

  // Scene + camera
  const scene  = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, W, 0, H, -500, 500);
  camera.position.z = 200;

  // Lights
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const pt = new THREE.PointLight(0xffffff, 0.55, 3000);
  pt.position.set(W / 2, H / 2, 300);
  scene.add(pt);

  // ── Pre-built materials ───────────────────────────────────────────────────
  // [0] = per-finger-color sphere mat, [1] = halo mat (additive)
  const sphereMats = PALETTE.map(hex => _makeMat(hex, 1.0));
  const haloMats   = PALETTE.map(hex => new THREE.MeshBasicMaterial({
    color:       new THREE.Color(hex),
    transparent: true,
    opacity:     0.08,
    blending:    THREE.AdditiveBlending,
    depthWrite:  false,
  }));
  const boneMats = PALETTE.map(hex => _makeBoneMat(hex, 0.78));

  // Finger-state override materials (green=correct, red=wrong)
  const greenMat = _makeMat(0x22ff88, 0.95);
  const redMat   = _makeMat(0xff3333, 0.85);

  // ── Shared geometries ─────────────────────────────────────────────────────
  // One sphere geo per distinct radius
  const sphereGeos = {};
  for (let i = 0; i < 21; i++) {
    const r = _jointR(i);
    const k = Math.round(r * 10);
    if (!sphereGeos[k]) sphereGeos[k] = new THREE.SphereGeometry(r, 10, 7);
  }

  const cylGeo  = new THREE.CylinderGeometry(1, 1, 2, 7, 1); // radius=1 height=2
  const haloGeo = {};  // bigger spheres for glow halos

  // ── Pre-build mesh pools ──────────────────────────────────────────────────

  // 21 joint spheres + 21 glow halos
  const joints   = [];
  const halos    = [];
  for (let i = 0; i < 21; i++) {
    const fi  = LM_FINGER_IDX[i] === -1 ? 0 : LM_FINGER_IDX[i] + 1;
    const r   = _jointR(i);
    const k   = Math.round(r * 10);
    const jm  = new THREE.Mesh(sphereGeos[k], sphereMats[fi].clone());
    jm.position.z = 5;
    scene.add(jm);
    joints.push(jm);

    // Halo (1.8× radius, additive)
    const hk  = Math.round(r * 1.8 * 10);
    if (!haloGeo[hk]) haloGeo[hk] = new THREE.SphereGeometry(r * 1.8, 8, 6);
    const hm  = new THREE.Mesh(haloGeo[hk], haloMats[fi].clone());
    hm.position.z = 4;
    scene.add(hm);
    halos.push(hm);
  }

  // 23 bone cylinders
  const bones = [];
  for (let b = 0; b < BONE_PAIRS.length; b++) {
    const isPalm = b >= PALM_BONE_START;
    const a      = BONE_PAIRS[b][0];
    const fi     = LM_FINGER_IDX[a] === -1 ? 0 : LM_FINGER_IDX[a] + 1;
    const bm     = new THREE.Mesh(cylGeo, boneMats[fi].clone());
    bm.position.z = 2;
    bm.userData.isPalm = isPalm;
    scene.add(bm);
    bones.push(bm);
  }

  // Palm polygon (5-vertex fan: wrist + MCP knuckles)
  const palmGeo = new THREE.BufferGeometry();
  const palmVerts = new Float32Array(5 * 3); // 5 verts * xyz
  palmGeo.setAttribute("position", new THREE.BufferAttribute(palmVerts, 3));
  palmGeo.setIndex([0,1,2, 0,2,3, 0,3,4]); // fan from wrist
  const palmMat  = new THREE.MeshBasicMaterial({
    color: 0x00aaff, transparent: true, opacity: 0.07,
    side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const palmMesh = new THREE.Mesh(palmGeo, palmMat);
  palmMesh.position.z = 1;
  scene.add(palmMesh);

  // ── Pool fantasma (seña objetivo, detrás de la mano real, Z=-30) ──────────
  const ghostJointMat = new THREE.MeshBasicMaterial({
    color: 0x99d4ff, transparent: true, opacity: 0.32,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const ghostBoneMat2 = new THREE.MeshBasicMaterial({
    color: 0x66aaf0, transparent: true, opacity: 0.22,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const ghostJoints = [], ghostBones = [];
  for (let i = 0; i < 21; i++) {
    const r  = _jointR(i) * 0.76;
    const gj = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), ghostJointMat.clone());
    gj.position.z = -30;
    gj.visible    = false;
    scene.add(gj);
    ghostJoints.push(gj);
  }
  for (let b = 0; b < BONE_PAIRS.length; b++) {
    const gb = new THREE.Mesh(cylGeo, ghostBoneMat2.clone());
    gb.visible = false;
    scene.add(gb);
    ghostBones.push(gb);
  }

  const ctx = {
    renderer, scene, camera, W, H,
    pt, joints, halos, bones, palmMesh, palmVerts,
    sphereMats, haloMats, boneMats, greenMat, redMat,
    ghostJoints, ghostBones,
  };
  _ctxMap.set(canvas, ctx);
  return ctx;
}

function _ensureCtx(canvas) {
  return _ctxMap.get(canvas) ?? _createCtx(canvas);
}

// ── Core draw function ────────────────────────────────────────────────────────

/**
 * Maps smoothed normalized landmarks → pixel 3D positions.
 * Uses Z from world landmarks for depth.
 */
function _toPixelPts(smoothed, W, H) {
  return smoothed.map(lm => new THREE.Vector3(
    (1 - lm.x) * W,
    lm.y * H,
    lm.z * Z_SCALE,   // depth: positive Z = closer
  ));
}

/**
 * Determine which joints have the correct / wrong finger state vs target.
 * Returns array of 21: null = no info, true = correct, false = wrong.
 */
function _jointStates(fingersUp, targetFingers) {
  if (!fingersUp?.length || !targetFingers?.length) return null;
  const FINGER_LMS = [
    [1,2,3,4],    // thumb  (finger 0)
    [5,6,7,8],    // index  (finger 1)
    [9,10,11,12], // middle (finger 2)
    [13,14,15,16],// ring   (finger 3)
    [17,18,19,20],// pinky  (finger 4)
  ];
  const states = new Array(21).fill(null);
  for (let fi = 0; fi < 5; fi++) {
    const correct = fingersUp[fi] === targetFingers[fi];
    FINGER_LMS[fi].forEach(idx => { states[idx] = correct; });
  }
  return states;
}

function _renderHand(ctx, pts, opts, isSecondary) {
  const {
    alpha       = 1.0,
    confidence  = 1.0,
    fingersUp   = null,
    targetFingers = null,
  } = opts || {};

  const { W, H, joints, halos, bones, palmMesh, palmVerts,
          sphereMats, haloMats, boneMats, greenMat, redMat } = ctx;

  // Confidence dims everything below 35%
  const confScale = Math.max(0.25, Math.min(1.0, confidence * 1.8));
  const baseAlpha = alpha * (isSecondary ? 0.78 : 1.0);
  const jointStates = _jointStates(fingersUp, targetFingers);

  // ── Joint spheres + halos ─────────────────────────────────────────────────
  pts.forEach((p, i) => {
    const mesh = joints[i];
    const halo = halos[i];
    const fi   = LM_FINGER_IDX[i] === -1 ? 0 : LM_FINGER_IDX[i] + 1;

    mesh.position.copy(p);
    halo.position.copy(p);
    halo.position.z = p.z - 1;

    // Finger state override
    if (jointStates && jointStates[i] !== null) {
      mesh.material = jointStates[i] ? greenMat : redMat;
    } else {
      mesh.material = sphereMats[fi];
    }

    const a = baseAlpha * confScale;
    mesh.material.opacity = a;
    halo.material.opacity = Math.max(0, a * 0.12);
    mesh.visible = true;
    halo.visible = !isSecondary;
  });

  // ── Bone cylinders ────────────────────────────────────────────────────────
  BONE_PAIRS.forEach(([a, b], idx) => {
    const bone = bones[idx];
    const r    = bone.userData.isPalm ? BONE_R_PALM : BONE_R;
    const fi   = LM_FINGER_IDX[a] === -1 ? 0 : LM_FINGER_IDX[a] + 1;
    _setCylinder(bone, pts[a], pts[b], r);
    bone.material = boneMats[fi];
    bone.material.opacity = baseAlpha * confScale * 0.72;
  });

  // ── Palm polygon ──────────────────────────────────────────────────────────
  const PALM_IDX = [0, 5, 9, 13, 17];
  PALM_IDX.forEach((li, vi) => {
    palmVerts[vi * 3]     = pts[li].x;
    palmVerts[vi * 3 + 1] = pts[li].y;
    palmVerts[vi * 3 + 2] = pts[li].z - 2;
  });
  palmMesh.geometry.attributes.position.needsUpdate = true;
  palmMesh.material.opacity = baseAlpha * confScale * 0.07;
  palmMesh.visible = true;
}

// ── Render fantasma (seña objetivo en esquina inferior derecha) ───────────────

function _renderGhost(ctx, pixelPts, alpha) {
  const { ghostJoints, ghostBones } = ctx;

  ghostJoints.forEach((mesh, i) => {
    mesh.position.set(pixelPts[i].x, pixelPts[i].y, -30);
    mesh.material.opacity = alpha;
    mesh.visible = true;
  });

  BONE_PAIRS.forEach(([a, b], idx) => {
    const pa = new THREE.Vector3(pixelPts[a].x, pixelPts[a].y, -30);
    const pb = new THREE.Vector3(pixelPts[b].x, pixelPts[b].y, -30);
    _setCylinder(ghostBones[idx], pa, pb, BONE_R_PALM * 0.75);
    ghostBones[idx].material.opacity = alpha * 0.75;
    ghostBones[idx].visible = true;
  });
}

// ── API pública ───────────────────────────────────────────────────────────────

window.ThreeHandRenderer = {

  /**
   * Posiciona la mano fantasma (objetivo) ANTES de llamar a draw().
   * Recibe coordenadas en píxeles (salida directa de buildGhostLandmarks).
   * No renderiza — el render ocurre en draw().
   *
   * @param {HTMLCanvasElement} canvas
   * @param {Array}  pixelLms  — [{x,y}×21] en coordenadas de píxel
   * @param {object} [opts]
   *   opts.alpha  {number}  opacidad base (default 0.30)
   */
  drawGhost(canvas, pixelLms, opts = {}) {
    if (!window.THREE || !pixelLms?.length) return;
    const ctx = _ensureCtx(canvas);
    if (!ctx) return;
    const base  = opts.alpha ?? 0.30;
    const pulse = 0.72 + 0.28 * Math.abs(Math.sin(Date.now() / 1300));
    _renderGhost(ctx, pixelLms, base * pulse);
  },

  /**
   * Renderiza la mano principal.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {Array}  screenLms   — landmarks normalizados MediaPipe [{x,y,z}×21]
   * @param {Array}  [worldLms]  — world landmarks [{x,y,z}×21]
   * @param {object} [opts]
   *   opts.alpha          {number}   opacidad global (default 1)
   *   opts.confidence     {number}   confianza IA 0–1 (default 1)
   *   opts.fingersUp      {bool[5]}  dedos detectados
   *   opts.targetFingers  {bool[5]}  dedos objetivo (coloración verde/rojo)
   */
  draw(canvas, screenLms, worldLms, opts) {
    if (!window.THREE || !screenLms?.length) return;
    const ctx = _ensureCtx(canvas);
    if (!ctx) return;

    // Ocultar fantasma si no fue activado este frame (resetea cada frame)
    ctx.ghostJoints.forEach(m => { m.visible = false; });
    ctx.ghostBones.forEach(m  => { m.visible = false; });

    const W = canvas.width  || 640;
    const H = canvas.height || 480;
    this.syncSize(canvas, W, H);

    const smoothed = _emaSmooth(canvas, "primary", screenLms, worldLms);
    const pts      = _toPixelPts(smoothed, W, H);

    _renderHand(ctx, pts, opts, false);

    ctx.renderer.clear();
    ctx.renderer.render(ctx.scene, ctx.camera);
  },

  /**
   * Renderiza una segunda mano (encima del draw principal).
   */
  drawSecondary(canvas, screenLms, worldLms, alpha = 0.78) {
    if (!window.THREE || !screenLms?.length) return;
    const ctx = _ctxMap.get(canvas);
    if (!ctx) return;

    const W = canvas.width  || 640;
    const H = canvas.height || 480;
    const smoothed = _emaSmooth(canvas, "secondary", screenLms, worldLms);
    const pts      = _toPixelPts(smoothed, W, H);

    _renderHand(ctx, pts, { alpha }, true);
    ctx.renderer.render(ctx.scene, ctx.camera);
  },

  /** Limpia el canvas WebGL. */
  clear(canvas) {
    const ctx = _ctxMap.get(canvas);
    if (!ctx) return;
    ctx.joints.forEach(m      => { m.visible = false; });
    ctx.halos.forEach(m       => { m.visible = false; });
    ctx.bones.forEach(m       => { m.visible = false; });
    ctx.ghostJoints.forEach(m => { m.visible = false; });
    ctx.ghostBones.forEach(m  => { m.visible = false; });
    ctx.palmMesh.visible = false;
    ctx.renderer.clear();
    const ema = _emaMap.get(canvas);
    if (ema) { ema.delete("primary"); ema.delete("secondary"); }
  },

  /** Sincroniza el renderer con el tamaño del canvas en píxeles. */
  syncSize(canvas, W, H) {
    const ctx = _ctxMap.get(canvas);
    if (!ctx || (ctx.W === W && ctx.H === H)) return;
    ctx.renderer.setSize(W, H, false);
    ctx.camera.right  = W;
    ctx.camera.bottom = H;
    ctx.camera.updateProjectionMatrix();
    ctx.pt.position.set(W / 2, H / 2, 300);
    ctx.W = W;
    ctx.H = H;
  },
};
