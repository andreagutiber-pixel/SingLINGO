(function () {
  "use strict";

  // ── Paleta de colores por dedo (coincide con overlay.js) ─────────────────────
  const FINGER_COLORS = [
    [255, 255, 255],   // 0 wrist/palm  — blanco
    [255, 60,  90 ],   // 1 thumb       — rojo neón
    [255, 160, 30 ],   // 2 index       — naranja
    [50,  230, 80 ],   // 3 middle      — verde
    [20,  210, 255],   // 4 ring        — cian
    [210, 60,  255],   // 5 pinky       — magenta
  ];

  // Índice de fingertip para cada dedo (orden: thumb→pinky)
  const FINGERTIP_IDX = [4, 8, 12, 16, 20];

  // ── Partícula básica (trail de yemas de dedo) ────────────────────────────────
  class Particle {
    constructor(p5, x, y, color) {
      this.p5    = p5;
      this.x     = x;
      this.y     = y;
      this.color = color;
      this.size  = p5.random(2.5, 6.5);
      this.vx    = p5.random(-1.0, 1.0);
      this.vy    = p5.random(-1.8, 0.4);
      this.life  = 1.0;
      this.decay = p5.random(0.05, 0.11);
    }

    update() {
      this.x   += this.vx;
      this.y   += this.vy;
      this.vy  += 0.09;
      this.vx  *= 0.94;
      this.life -= this.decay;
      this.size *= 0.96;
    }

    draw() {
      const { p5, color, life, size, x, y } = this;
      if (life <= 0 || size < 0.2) return;
      const a = life * 255;
      p5.noStroke();
      // glow halo
      p5.fill(color[0], color[1], color[2], a * 0.22);
      p5.ellipse(x, y, size * 3.2);
      // bright core
      p5.fill(color[0], color[1], color[2], a);
      p5.ellipse(x, y, size);
    }

    isDead() { return this.life <= 0 || this.size < 0.2; }
  }

  // ── Partícula de explosión (on correct detection) ────────────────────────────
  class BurstParticle {
    constructor(p5, x, y, color) {
      this.p5    = p5;
      this.x     = x;
      this.y     = y;
      this.color = color;
      this.size  = p5.random(5, 15);
      this.vx    = p5.random(-5.5, 5.5);
      this.vy    = p5.random(-7.0, 1.5);
      this.life  = 1.0;
      this.decay = p5.random(0.016, 0.038);
      this.trail = [];
    }

    update() {
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > 7) this.trail.shift();
      this.x   += this.vx;
      this.y   += this.vy;
      this.vy  += 0.14;
      this.vx  *= 0.92;
      this.life -= this.decay;
      this.size *= 0.97;
    }

    draw() {
      const { p5, color, life, size, x, y, trail } = this;
      if (life <= 0 || size < 0.3) return;
      const a = life * 255;
      // draw motion trail
      for (let i = 0; i < trail.length; i++) {
        const t   = i / trail.length;
        const ta  = t * life * 140;
        const ts  = size * 0.4 * t;
        p5.noStroke();
        p5.fill(color[0], color[1], color[2], ta);
        p5.ellipse(trail[i].x, trail[i].y, ts);
      }
      // glow
      p5.noStroke();
      p5.fill(color[0], color[1], color[2], a * 0.20);
      p5.ellipse(x, y, size * 3.5);
      // core
      p5.fill(color[0], color[1], color[2], a);
      p5.ellipse(x, y, size);
    }

    isDead() { return this.life <= 0 || this.size < 0.3; }
  }

  // ── P5OverlayManager ─────────────────────────────────────────────────────────
  class P5OverlayManager {
    constructor() {
      this._states = new Map();  // p5CanvasId → state
    }

    /**
     * Attach a p5 sketch to a camera container.
     *
     * @param {string} p5CanvasId   id of the placeholder <canvas> (used for sizing)
     * @param {string} refCanvasId  id of the existing overlay canvas (for size sync)
     */
    attach(p5CanvasId, refCanvasId) {
      if (this._states.has(p5CanvasId)) return;
      if (typeof p5 === "undefined") {
        console.warn("[P5Overlay] p5.js not loaded yet — deferring attach");
        setTimeout(() => this.attach(p5CanvasId, refCanvasId), 500);
        return;
      }

      const state = {
        particles:      [],
        burstParticles: [],
        motionTrail:    [],
        motionSign:     null,
        refCanvasId,
        p5CanvasId,
        sketch:         null,
      };

      const sketch = (p) => {
        let cnv;

        p.setup = () => {
          const ref = document.getElementById(refCanvasId);
          const W   = (ref && ref.width)  || 640;
          const H   = (ref && ref.height) || 480;
          cnv = p.createCanvas(W, H);

          // Position this canvas exactly over the existing overlay canvas
          const refEl = document.getElementById(refCanvasId);
          if (refEl && refEl.parentElement) {
            cnv.elt.style.position     = "absolute";
            cnv.elt.style.top          = "0";
            cnv.elt.style.left         = "0";
            cnv.elt.style.pointerEvents = "none";
            cnv.elt.style.zIndex       = "6";
            cnv.elt.id                  = `${p5CanvasId}-p5`;
            refEl.parentElement.appendChild(cnv.elt);
          }

          p.frameRate(60);
          p.noSmooth();
        };

        p.draw = () => {
          // Sync size to reference canvas every frame
          const ref = document.getElementById(refCanvasId);
          if (ref) {
            const W = ref.width  || 640;
            const H = ref.height || 480;
            if (p.width !== W || p.height !== H) {
              p.resizeCanvas(W, H);
            }
          }

          p.clear();

          // ── Motion trail ────────────────────────────────────────────────────
          const trail = state.motionTrail;
          if (trail && trail.length > 1) {
            const sign  = state.motionSign;
            const color =
              sign === "Z" ? [255, 180, 50 ] :
              sign === "S" ? [210, 60,  255] :
              sign === "Ñ" ? [20,  210, 255] :
                             [0,   245, 200];   // J default

            p.noFill();
            for (let i = 1; i < trail.length; i++) {
              const t    = i / trail.length;
              const alpha = t * 230;
              const w    = t * 5 + 1;
              const pt0  = trail[i - 1];
              const pt1  = trail[i];
              // Mirror X (webcam is mirrored)
              const x0 = (1 - pt0.x) * p.width;
              const y0 =      pt0.y  * p.height;
              const x1 = (1 - pt1.x) * p.width;
              const y1 =      pt1.y  * p.height;

              // Outer glow
              p.stroke(color[0], color[1], color[2], alpha * 0.20);
              p.strokeWeight(w * 4.5);
              p.line(x0, y0, x1, y1);
              // Mid glow
              p.stroke(color[0], color[1], color[2], alpha * 0.45);
              p.strokeWeight(w * 2.0);
              p.line(x0, y0, x1, y1);
              // Core
              p.stroke(color[0], color[1], color[2], alpha);
              p.strokeWeight(w);
              p.line(x0, y0, x1, y1);
            }
            p.noStroke();

            // Bright dot at trail tip
            const tip = trail[trail.length - 1];
            const tx  = (1 - tip.x) * p.width;
            const ty  =      tip.y  * p.height;
            p.fill(color[0], color[1], color[2], 50);
            p.ellipse(tx, ty, 22);
            p.fill(color[0], color[1], color[2], 200);
            p.ellipse(tx, ty, 9);
            p.fill(255, 255, 255, 220);
            p.ellipse(tx, ty, 4);
          }

          // ── Fingertip particles ─────────────────────────────────────────────
          state.particles = state.particles.filter(par => {
            par.update();
            par.draw();
            return !par.isDead();
          });

          // ── Burst particles ─────────────────────────────────────────────────
          state.burstParticles = state.burstParticles.filter(par => {
            par.update();
            par.draw();
            return !par.isDead();
          });
        };
      };

      state.sketch = new p5(sketch);
      this._states.set(p5CanvasId, state);
    }

    /**
     * Spawn fingertip particles from normalized landmark array.
     *
     * @param {string} p5CanvasId
     * @param {Array}  landmarks   21 × {x,y,z} normalized
     * @param {number} W           canvas width in px
     * @param {number} H           canvas height in px
     */
    updateHand(p5CanvasId, landmarks, W, H) {
      const state = this._states.get(p5CanvasId);
      if (!state || !landmarks || landmarks.length < 21) return;

      // Cap total for performance
      if (state.particles.length > 150) return;

      const p = state.sketch;

      FINGERTIP_IDX.forEach((tipIdx, fi) => {
        const lm = landmarks[tipIdx];
        if (!lm) return;
        // Mirror X (webcam mirror)
        const px = (1 - lm.x) * W;
        const py =      lm.y  * H;
        const color = FINGER_COLORS[fi + 1]; // fi+1: skip wrist slot

        state.particles.push(new Particle(p, px, py, color));
        // Occasionally spawn a second particle for density
        if (Math.random() < 0.45) {
          state.particles.push(new Particle(p, px, py, color));
        }
      });
    }

    /**
     * Update the motion trail shown over the video.
     *
     * @param {string}      p5CanvasId
     * @param {Array|null}  points  [{x,y}, …] normalized coords
     * @param {string|null} sign    "J" | "Z" | "S" | "Ñ"
     */
    setMotionTrail(p5CanvasId, points, sign) {
      const state = this._states.get(p5CanvasId);
      if (!state) return;
      state.motionTrail = points || [];
      state.motionSign  = sign   || null;
    }

    /**
     * Trigger a burst explosion at the center of the canvas on correct detection.
     * @param {string} p5CanvasId
     */
    triggerBurst(p5CanvasId) {
      const state = this._states.get(p5CanvasId);
      if (!state) return;

      const p  = state.sketch;
      const cx = p.width  / 2;
      const cy = p.height / 2;

      const BURST_COLORS = [
        [0,   245, 200],
        [255, 60,  90 ],
        [255, 200, 30 ],
        [100, 120, 255],
        [210, 60,  255],
        [50,  230, 80 ],
      ];

      for (let i = 0; i < 45; i++) {
        const color = BURST_COLORS[Math.floor(Math.random() * BURST_COLORS.length)];
        // Spread from center ± random offset
        const ox = (Math.random() - 0.5) * 80;
        const oy = (Math.random() - 0.5) * 60;
        state.burstParticles.push(new BurstParticle(p, cx + ox, cy + oy, color));
      }
    }
  }

  // ── Expose globally ──────────────────────────────────────────────────────────
  window.P5Overlay = new P5OverlayManager();

})();
