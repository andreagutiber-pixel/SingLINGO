/**
 * overlay.js — AR Hand Tracking Overlay
 *
 * Estilo: puntos neón esféricos por dedo + esqueleto fino coloreado.
 * Cada landmark es una esfera luminosa con gradiente radial y glow multicapa.
 */

// ── Conexiones del esqueleto ─────────────────────────────────────────────────
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];

// Qué dedo pertenece cada landmark (-1=palma, 0=pulgar … 4=meñique)
const LM_FINGER = [-1,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4];

// Paleta HUD para efectos secundarios
const C = {
  core:   "0, 220, 255",
  glow1:  "0, 160, 255",
  glow2:  "20, 80, 200",
  palm:   "0, 140, 220",
  text:   "0, 255, 220",
  accent: "255, 255, 255",
};

// ── Colores neón por dedo ────────────────────────────────────────────────────
// [muñeca/palma, pulgar, índice, medio, anular, meñique]
const FINGER_COLORS = [
  [220, 235, 255],   // muñeca  → blanco azulado
  [255,  55,  85],   // pulgar  → rojo coral
  [255, 155,  20],   // índice  → naranja
  [ 50, 230,  80],   // medio   → verde lima
  [ 20, 200, 255],   // anular  → cian eléctrico
  [210,  50, 255],   // meñique → magenta
];

function _fingerRgb(lmIndex) {
  const f = LM_FINGER[lmIndex];
  return FINGER_COLORS[f === -1 ? 0 : f + 1];
}

function _rgb(arr, a = 1) {
  return `rgba(${arr[0]},${arr[1]},${arr[2]},${a})`;
}

// ── Punto neón esférico ──────────────────────────────────────────────────────
/**
 * Dibuja una esfera luminosa neón con glow multicapa.
 * Cada llamada usa save/restore propio — nunca contamina el contexto exterior.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number[]} color  — [r,g,b]
 * @param {number}   r      — radio del núcleo (px)
 */
function _drawNeonDot(ctx, x, y, color, r) {
  ctx.save();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur  = 0;

  // ── Capa 1: halo externo muy difuso ──────────────────────────────────────
  ctx.globalAlpha = 0.15;
  ctx.shadowColor = _rgb(color);
  ctx.shadowBlur  = 35;
  ctx.fillStyle   = _rgb(color, 0.6);
  ctx.beginPath();
  ctx.arc(x, y, r * 3.5, 0, Math.PI * 2);
  ctx.fill();

  // ── Capa 2: halo medio ───────────────────────────────────────────────────
  ctx.globalAlpha = 0.30;
  ctx.shadowBlur  = 20;
  ctx.fillStyle   = _rgb(color, 0.8);
  ctx.beginPath();
  ctx.arc(x, y, r * 2.0, 0, Math.PI * 2);
  ctx.fill();

  // ── Capa 3: núcleo sólido ────────────────────────────────────────────────
  ctx.globalAlpha = 1.0;
  ctx.shadowBlur  = 14;
  ctx.shadowColor = _rgb(color);
  ctx.fillStyle   = _rgb(color);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  // ── Capa 4: gradiente radial para efecto esférico (reflexión de luz) ─────
  ctx.globalAlpha = 1.0;
  ctx.shadowBlur  = 0;
  const hx = x - r * 0.32;
  const hy = y - r * 0.32;
  const grad = ctx.createRadialGradient(hx, hy, r * 0.05, x, y, r);
  grad.addColorStop(0.00, "rgba(255,255,255,0.92)");
  grad.addColorStop(0.28, _rgb(color, 0.85));
  grad.addColorStop(0.70, _rgb(color, 0.60));
  grad.addColorStop(1.00, _rgb(color, 0.15));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ── Esqueleto coloreado por segmento ────────────────────────────────────────
/**
 * Dibuja las líneas del esqueleto coloreadas con el color del dedo
 * al que pertenece cada segmento.
 */
function _drawColoredSkeleton(ctx, pts, alpha = 1.0) {
  ctx.save();
  ctx.lineCap  = "round";
  ctx.lineJoin = "round";

  HAND_CONNECTIONS.forEach(([a, b]) => {
    if (!pts[a] || !pts[b]) return;
    const col = _fingerRgb(a);

    // Halo difuso
    ctx.globalAlpha = 0.18 * alpha;
    ctx.lineWidth   = 10;
    ctx.shadowColor = _rgb(col, 0.9);
    ctx.shadowBlur  = 16;
    ctx.strokeStyle = _rgb(col, 0.5);
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.stroke();

    // Línea principal fina
    ctx.globalAlpha = 0.65 * alpha;
    ctx.lineWidth   = 1.6;
    ctx.shadowBlur  = 8;
    ctx.strokeStyle = _rgb(col, 0.85);
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.stroke();
  });

  ctx.restore();
}

// ── Utilidades ───────────────────────────────────────────────────────────────

function clearCanvas(canvas) {
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

// Radio por tipo de landmark — valores pequeños (Three.js maneja los nodos grandes)
function _dotRadius(i) {
  if ([4, 8, 12, 16, 20].includes(i)) return 4;   // yemas
  if (i === 0)                         return 3.5; // muñeca
  if ([5, 9, 13, 17].includes(i))      return 3.5; // nudillos MCP
  return 3;                                         // articulaciones PIP/DIP
}

// ── Dibujo de mano del usuario ───────────────────────────────────────────────

function drawUserHand(canvas, landmarks) {
  if (!landmarks?.length) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  // Espejo — cámara frontal ya viene espejada, des-espejamos para overlay
  const pts = landmarks.map(p => ({ x: (1 - p.x) * W, y: p.y * H }));

  // 1. Esqueleto fino coloreado
  _drawColoredSkeleton(ctx, pts, 1.0);

  // 2. Puntos neón encima — cada uno aislado con su propio save/restore
  pts.forEach((p, i) => {
    _drawNeonDot(ctx, p.x, p.y, _fingerRgb(i), _dotRadius(i));
  });
}

// ── Segunda mano (misma paleta, misma estética) ──────────────────────────────

function drawUserHandSecondary(canvas, landmarks) {
  if (!landmarks?.length) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const pts = landmarks.map(p => ({ x: (1 - p.x) * W, y: p.y * H }));

  _drawColoredSkeleton(ctx, pts, 0.85);

  pts.forEach((p, i) => {
    _drawNeonDot(ctx, p.x, p.y, _fingerRgb(i), _dotRadius(i));
  });
}

// ── Mano fantasma (referencia de la seña objetivo) ───────────────────────────

function buildGhostLandmarks(fingerStates, W, H) {
  const cx = W * 0.5, cy = H * 0.62, scale = H * 0.32;
  const [thumbUp, indexUp, middleUp, ringUp, pinkyUp] = fingerStates;

  const palmOffsets = [
    { x: -0.18, y: -0.05 }, { x: -0.12, y: -0.18 },
    { x:  0.00, y: -0.22 }, { x:  0.12, y: -0.20 },
    { x:  0.22, y: -0.16 },
  ];
  const fingerDefs = [
    { up: thumbUp,  segs:[0.12,0.10,0.08,0.07], dir:{x:-0.22,y:-0.14} },
    { up: indexUp,  segs:[0.18,0.12,0.10,0.09], dir:{x:-0.05,y:-0.28} },
    { up: middleUp, segs:[0.18,0.12,0.11,0.09], dir:{x: 0.00,y:-0.30} },
    { up: ringUp,   segs:[0.16,0.11,0.10,0.08], dir:{x: 0.08,y:-0.27} },
    { up: pinkyUp,  segs:[0.12,0.08,0.07,0.06], dir:{x: 0.15,y:-0.23} },
  ];

  const pts = new Array(21);
  pts[0] = { x: cx, y: cy + scale * 0.12 };

  fingerDefs.forEach((finger, fi) => {
    const baseOff  = palmOffsets[fi];
    const baseX    = cx + baseOff.x * scale;
    const baseY    = (cy + scale * 0.12) + baseOff.y * scale;
    const baseIdx  = fi === 0 ? 1 : 5 + fi * 4 - 4;
    const joints   = [baseIdx, baseIdx+1, baseIdx+2, baseIdx+3];
    pts[joints[0]] = { x: baseX, y: baseY };

    let bx = baseX, by = baseY;
    if (finger.up) {
      finger.segs.forEach((seg, si) => {
        bx += finger.dir.x * scale * seg;
        by += finger.dir.y * scale * seg;
        pts[joints[si+1]] = { x: bx, y: by };
      });
    } else {
      const fa = [0.2, 0.35, 0.25, 0.20];
      finger.segs.forEach((seg, si) => {
        bx += (finger.dir.x * 0.3 + fa[si] * 0.1) * scale * seg;
        by += (-0.08 + fa[si] * 0.35) * scale * seg;
        pts[joints[si+1]] = { x: bx, y: by };
      });
    }
  });

  for (let i = 0; i < 21; i++) if (!pts[i]) pts[i] = { x: cx, y: cy };
  return pts;
}

function _drawGhostSkeleton(ctx, pts, alpha = 1.0) {
  const t     = Date.now() / 1000;
  const pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * 1.6));

  _drawColoredSkeleton(ctx, pts, (0.35 + 0.20 * pulse) * alpha);

  pts.forEach((p, i) => {
    if (!p) return;
    const col = _fingerRgb(i);
    const r   = _dotRadius(i) * 0.85;
    // Fantasma más translúcido — reducimos opacity via halo
    ctx.save();
    ctx.globalAlpha = (0.55 + 0.20 * pulse) * alpha;
    _drawNeonDot(ctx, p.x, p.y, col, r);
    ctx.restore();
  });
}

function drawGhostHand(canvas, fingerStates) {
  if (!fingerStates?.length) return;
  const ctx = canvas.getContext("2d");
  const pts = buildGhostLandmarks(fingerStates, canvas.width, canvas.height);
  _drawGhostSkeleton(ctx, pts, 1.0);
}

function drawGhostHandSecondary(canvas, fingerStates) {
  if (!fingerStates?.length) return;
  const ctx   = canvas.getContext("2d");
  const pts   = buildGhostLandmarks(fingerStates, canvas.width, canvas.height);
  const shift = canvas.width * 0.30;
  const sp    = pts.map(p => p ? { x: p.x - shift, y: p.y } : p);
  _drawGhostSkeleton(ctx, sp, 0.70);
}

// ── Efectos extra ─────────────────────────────────────────────────────────────

function drawMatchFlash(canvas, intensity = 1) {
  const ctx = canvas.getContext("2d");
  ctx.save();
  const grad = ctx.createRadialGradient(
    canvas.width/2, canvas.height/2, 0,
    canvas.width/2, canvas.height/2, Math.max(canvas.width, canvas.height)*0.6,
  );
  grad.addColorStop(0,   `rgba(${C.core}, ${0.15 * intensity})`);
  grad.addColorStop(0.5, `rgba(${C.glow1}, ${0.06 * intensity})`);
  grad.addColorStop(1,   "transparent");
  ctx.fillStyle   = grad;
  ctx.globalAlpha = 1;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function drawScanLine(canvas) {
  const ctx = canvas.getContext("2d");
  const t   = Date.now() / 1000;
  const y   = ((t * 0.14) % 1) * canvas.height;
  ctx.save();
  ctx.globalAlpha = 0.022;
  const grad = ctx.createLinearGradient(0, y-3, 0, y+3);
  grad.addColorStop(0,   "transparent");
  grad.addColorStop(0.5, `rgba(${C.core}, 1)`);
  grad.addColorStop(1,   "transparent");
  ctx.fillStyle = grad;
  ctx.fillRect(0, y-3, canvas.width, 6);
  ctx.restore();
}

function drawMotionTrail(canvas, trailPoints, color = C.core) {
  if (!trailPoints?.length || trailPoints.length < 2) return;
  const ctx = canvas.getContext("2d");
  const W   = canvas.width, H = canvas.height;
  const pts = trailPoints.map(p => ({ x: (1 - p.x) * W, y: p.y * H }));
  const n   = pts.length;
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 1; i < n; i++) {
    const t = i / n;
    ctx.beginPath();
    ctx.moveTo(pts[i-1].x, pts[i-1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = `rgba(${color}, ${0.08 + t * 0.80})`;
    ctx.lineWidth   = 1.5 + t * 4;
    ctx.shadowColor = `rgba(${color}, ${t * 0.7})`;
    ctx.shadowBlur  = 4 + t * 10;
    ctx.stroke();
  }
  const last = pts[n-1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
  ctx.fillStyle   = `rgba(${color}, 0.95)`;
  ctx.shadowColor = `rgba(${color}, 1)`;
  ctx.shadowBlur  = 16;
  ctx.fill();
  ctx.restore();
}

function drawOrientationGuide(canvas, color = C.core) {
  const ctx   = canvas.getContext("2d");
  const W     = canvas.width, H = canvas.height;
  const cx    = W * 0.75, cy = H * 0.10;
  const len   = Math.min(W * 0.14, 55);
  const t     = Date.now() / 1000;
  const pulse = 0.6 + 0.4 * Math.abs(Math.sin(t * 1.8));

  ctx.save();
  ctx.globalAlpha = pulse * 0.85;
  ctx.strokeStyle = `rgba(${color}, 0.9)`;
  ctx.fillStyle   = `rgba(${color}, 0.9)`;
  ctx.lineWidth   = 1.8;
  ctx.shadowColor = `rgba(${color}, 0.7)`;
  ctx.shadowBlur  = 6;
  ctx.lineCap     = "round";

  ctx.beginPath();
  ctx.moveTo(cx - len/2, cy); ctx.lineTo(cx + len/2, cy); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + len/2, cy); ctx.lineTo(cx + len/2 - 8, cy - 5);
  ctx.moveTo(cx + len/2, cy); ctx.lineTo(cx + len/2 - 8, cy + 5); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - len/2, cy); ctx.lineTo(cx - len/2 + 8, cy - 5);
  ctx.moveTo(cx - len/2, cy); ctx.lineTo(cx - len/2 + 8, cy + 5); ctx.stroke();

  ctx.globalAlpha = pulse * 0.78;
  ctx.font        = "bold 10px 'Courier New', monospace";
  ctx.textAlign   = "center";
  ctx.fillText("↔ HORIZONTAL", cx, cy + 16);
  ctx.restore();
}

function drawHUD(canvas, data = {}) {
  const { confidence = 0, signId = "—" } = data;
  const ctx = canvas.getContext("2d");
  const W   = canvas.width;

  ctx.save();
  const pw = 110, ph = 52, px = W - pw - 10, py = 10, pr = 6;
  ctx.globalAlpha = 0.55;
  ctx.fillStyle   = "rgba(0,10,30,0.80)";
  ctx.strokeStyle = `rgba(${C.core}, 0.50)`;
  ctx.lineWidth   = 1;
  ctx.shadowColor = `rgba(${C.core}, 0.4)`;
  ctx.shadowBlur  = 8;
  ctx.beginPath();
  ctx.moveTo(px+pr, py);
  ctx.lineTo(px+pw-pr, py); ctx.arcTo(px+pw,py,px+pw,py+pr,pr);
  ctx.lineTo(px+pw, py+ph-pr); ctx.arcTo(px+pw,py+ph,px+pw-pr,py+ph,pr);
  ctx.lineTo(px+pr, py+ph); ctx.arcTo(px,py+ph,px,py+ph-pr,pr);
  ctx.lineTo(px, py+pr); ctx.arcTo(px,py,px+pr,py,pr);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur  = 0;
  ctx.globalAlpha = 0.75;
  ctx.stroke();

  ctx.globalAlpha = 0.90;
  ctx.font        = "bold 10px 'Courier New', monospace";
  ctx.textAlign   = "left";
  ctx.fillStyle   = `rgba(${C.text}, 0.95)`;
  ctx.shadowColor = `rgba(${C.text}, 0.7)`;
  ctx.shadowBlur  = 4;
  ctx.fillText(`SEÑA: ${signId}`, px+8, py+16);
  ctx.fillText(`CONF: ${Math.round(confidence*100)}%`, px+8, py+30);

  const barW = pw - 16, barH = 3, barX = px+8, barY = py+38;
  ctx.globalAlpha = 0.30;
  ctx.fillStyle   = "rgba(255,255,255,0.2)";
  ctx.fillRect(barX, barY, barW, barH);
  ctx.globalAlpha = 0.90;
  ctx.fillStyle   = confidence > 0.5
    ? `rgba(${C.core}, 0.9)`
    : `rgba(${C.glow1}, 0.7)`;
  ctx.fillRect(barX, barY, barW * Math.min(confidence, 1), barH);

  ctx.restore();
}

/**
 * drawStabilityRing — circular hold-progress arc drawn around the wrist.
 * Fills from 0 → full circle as the user holds the sign steady.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} cx     wrist pixel X (already flipped for mirror)
 * @param {number} cy     wrist pixel Y
 * @param {number} progress  0.0 – 1.0
 */
function drawStabilityRing(canvas, cx, cy, progress) {
  if (progress <= 0) return;
  const ctx = canvas.getContext("2d");
  ctx.save();

  const R     = 28;
  const start = -Math.PI / 2;
  const end   = start + progress * 2 * Math.PI;

  // Background track
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth   = 3.5;
  ctx.stroke();

  // Filled arc (color shifts green as it fills)
  const r = Math.round(34  + (1 - progress) * 220);
  const g = Math.round(230 - (1 - progress) * 80);
  const b = Math.round(110 - (1 - progress) * 60);
  const grad = ctx.createLinearGradient(
    cx - R, cy - R, cx + R, cy + R
  );
  grad.addColorStop(0,   `rgba(${r},${g},${b},0.92)`);
  grad.addColorStop(1,   `rgba(${r},${g},${b},0.55)`);

  ctx.beginPath();
  ctx.arc(cx, cy, R, start, end);
  ctx.strokeStyle = grad;
  ctx.lineWidth   = 3.5;
  ctx.lineCap     = "round";
  ctx.shadowColor = `rgba(${r},${g},${b},0.9)`;
  ctx.shadowBlur  = 12;
  ctx.stroke();

  // Completion pulse at 100%
  if (progress >= 0.99) {
    ctx.beginPath();
    ctx.arc(cx, cy, R + 5, 0, 2 * Math.PI);
    ctx.strokeStyle = `rgba(50,255,130,0.4)`;
    ctx.lineWidth   = 2;
    ctx.shadowBlur  = 20;
    ctx.shadowColor = "rgba(50,255,130,0.8)";
    ctx.stroke();
  }

  ctx.restore();
}

function drawRepBadge(canvas, repCount, color = C.core) {
  const ctx = canvas.getContext("2d");
  ctx.save();
  const x=10, y=30, w=104, h=30, r=6;
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
  ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
  ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
  ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r); ctx.closePath();
  ctx.fillStyle   = "rgba(0,10,30,0.75)";
  ctx.fill();
  ctx.strokeStyle = `rgba(${color}, 0.70)`;
  ctx.lineWidth   = 1.2;
  ctx.shadowColor = `rgba(${color}, 0.5)`;
  ctx.shadowBlur  = 6;
  ctx.stroke();
  ctx.fillStyle   = `rgba(${color}, 0.95)`;
  ctx.font        = "bold 11px 'Courier New', monospace";
  ctx.textAlign   = "left";
  ctx.fillText(`✓ ${repCount} rep${repCount!==1?"s":""}`, x+10, y+19);
  ctx.restore();
}

window.Overlay = {
  clearCanvas,
  drawUserHand,
  drawUserHandSecondary,
  drawGhostHand,
  drawGhostHandSecondary,
  drawMatchFlash,
  drawScanLine,
  drawMotionTrail,
  drawOrientationGuide,
  drawRepBadge,
  drawHUD,
  buildGhostLandmarks,
  drawStabilityRing,
};
