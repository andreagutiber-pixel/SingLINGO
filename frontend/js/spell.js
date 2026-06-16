/**
 * spell.js — Modo Deletreo: quiz de deletrear palabras con señas.
 *
 * El usuario ve una palabra. Debe hacer cada letra en orden usando señas.
 * Mantén cada letra ~0.6 segundos para confirmarla.
 * Dificultad: fácil (3-4 letras), media (5-6), difícil (7+).
 *
 * Detección de movimiento (J, Z, S, Ñ) via WebSocket — misma pipeline que
 * el modo práctica, con MotionClassifier en el servidor.
 */

// ── Listas de palabras por idioma y dificultad ────────────────────────────────

const WORD_LISTS = {
  lsc: {
    easy:   ["SOL", "MAR", "PAZ", "RIO", "LUZ", "FIN", "DIA", "VOZ",
             "OCA", "BEL", "CAL", "RUE", "PIE", "TEN", "VER"],
    medium: ["AMOR", "LUNA", "VIDA", "MANO", "ROCA", "VINO", "TREN",
             "AGUA", "BOCA", "CARA", "DEDO", "FOTO", "IDEA", "MONO"],
    hard:   ["CIUDAD", "BRASIL", "FLORES", "COLORES", "TIEMPO", "TRABAJO",
             "PUEBLO", "TIERRA", "MUCHOS", "GRANDE", "BLANCO", "FRENTE"],
  },
  asl: {
    easy:   ["CAT", "DOG", "SUN", "MAN", "BAT", "CUP", "RED", "BIG",
             "FUN", "OLD", "NEW", "DAY", "EAR", "EYE"],
    medium: ["BLUE", "MOON", "LOVE", "BIRD", "CORN", "FARM", "GOOD",
             "HAND", "IDEA", "MILK", "OPEN", "TREE", "WORD"],
    hard:   ["FLOWER", "PURPLE", "YELLOW", "FOREST", "FRIEND", "MOTHER",
             "FATHER", "SISTER", "BROTHER", "PLANET", "FINGER"],
  },
  bsl: {
    easy:   ["CAT", "DOG", "SUN", "MAN", "BAT", "CUP", "RED", "BIG",
             "FUN", "OLD", "NEW", "DAY"],
    medium: ["BLUE", "MOON", "LOVE", "BIRD", "FARM", "GOOD",
             "HAND", "IDEA", "MILK", "OPEN", "TREE"],
    hard:   ["FLOWER", "PURPLE", "YELLOW", "FOREST", "FRIEND", "MOTHER",
             "FATHER", "FINGER", "PLANET"],
  },
};

// Señas dinámicas que requieren movimiento
const MOTION_SIGNS = new Set(["J", "Z", "S", "Ñ"]);

// Señas que son más difíciles de reconocer
const TRICKY_LETTERS = new Set(["G", "H", "J", "S", "Z", "Ñ"]);

const HOLD_REQUIRED     = 22;   // frames consecutivos para confirmar letra (~0.8s)
const PREDICT_INTERVAL  = 120;  // ms entre predicciones
const MIN_CONFIDENCE    = 0.55;
const MIN_MOTION_CONFIDENCE = 0.58;
const FINGER_FALLBACK_CONFIDENCE = 0.38;
const SCORE_PER_LETTER  = 10;
const SCORE_SPEED_BONUS = 5;

["G", "H", "\u00D1"].forEach(s => MOTION_SIGNS.add(s));

// ─────────────────────────────────────────────────────────────────────────────

class SpellMode {
  constructor() {
    this.mp              = null;
    this.wsPredictor     = null;   // WebSocket predictor (motion-aware)
    this.currentCountry  = "lsc";
    this.isActive        = false;
    this.currentWord     = null;
    this.currentLetterIdx = 0;
    this.holdFrames      = 0;
    this.score           = 0;
    this.wordsCompleted  = 0;
    this.currentDifficulty = "easy";
    this.lastPredSign    = null;
    this.lastPredConf    = 0;
    this.lastPredTime    = 0;
    this._stableSignId   = null;
    this.letterStartTime = 0;
    this._predicting     = false;
    this._usedWords      = new Set();
    this._letterHistory  = [];    // {letter, correct, ms}
    this.motionTrail     = [];
    this.motionTrailTip  = null;
    this.voiceEnabled    = true;
    this.voiceLang       = "es-CO";

    this.videoEl  = document.getElementById("spell-video");
    this.canvasEl = document.getElementById("spell-canvas");

    this._bindUI();
  }

  // ── Eventos de UI ──────────────────────────────────────────────────────────

  _bindUI() {
    document.addEventListener("handsUpdate", (e) => {
      // store world landmarks for Three.js depth rendering
      if (!this.isActive) return;
      const { right, left, pose } = e.detail;
      const dominant = right ?? left;
      if (!dominant) return;

      const secondary = dominant === right ? left : right;
      this._drawLiveHand(
        dominant.landmarks,
        dominant.worldLandmarks ?? null,
        secondary?.landmarks ?? null,
        secondary?.worldLandmarks ?? null,
      );

      // ── WebSocket send (rate-limited) ────────────────────────────────────
      const now = Date.now();
      if (now - this.lastPredTime >= PREDICT_INTERVAL) {
        if (this.wsPredictor?.isConnected()) {
          this.lastPredTime = now;
          this.wsPredictor.send(
            dominant.landmarks,
            this.currentWord?.[this.currentLetterIdx] ?? null,
            right?.landmarks  ?? null,
            left?.landmarks   ?? null,
            right?.worldLandmarks ?? null,
            left?.worldLandmarks  ?? null,
            pose ?? null,
          );
        } else if (!this._predicting) {
          // Fallback REST (no motion detection)
          this._predict(
            right?.landmarks  ?? null,
            left?.landmarks   ?? null,
            right?.worldLandmarks ?? null,
            left?.worldLandmarks  ?? null,
            pose ?? null,
          );
        }
      }
    });

    document.addEventListener("noHand", () => {
      if (!this.isActive) return;
      if (this.canvasEl) Overlay.clearCanvas(this.canvasEl);
      const threeCanvas = document.getElementById("spell-three-canvas");
      if (threeCanvas && window.ThreeHandRenderer) ThreeHandRenderer.clear(threeCanvas);
      this.holdFrames = 0;
      this._updateHoldBar(0);
      this.motionTrail = [];
    });

    document.addEventListener("cameraReady", () => {
      if (!this.isActive) return;
      const dot  = document.getElementById("spell-cam-dot");
      const text = document.getElementById("spell-cam-text");
      if (dot)  dot.classList.add("active");
      if (text) text.textContent = "Detectando";
    });

    document.getElementById("btn-spell-start")
      ?.addEventListener("click", () => this.startQuiz());

    document.getElementById("btn-spell-skip-top")
      ?.addEventListener("click", () => this._nextWord());

    document.getElementById("btn-spell-restart-top")
      ?.addEventListener("click", () => this.startQuiz());

    document.getElementById("btn-spell-voice")
      ?.addEventListener("click", () => this.toggleVoice());

    document.getElementById("spell-difficulty-toggle")
      ?.addEventListener("click", (event) => {
        event.stopPropagation();
        document.getElementById("spell-difficulty-options")?.classList.toggle("hidden");
      });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".spell-difficulty-menu")) {
        document.getElementById("spell-difficulty-options")?.classList.add("hidden");
      }
    });

    document.querySelectorAll("[data-spell-diff]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-spell-diff]").forEach(item => {
          item.classList.toggle("active", item === btn);
        });
        const label = btn.textContent.trim();
        const toggle = document.getElementById("spell-difficulty-toggle");
        if (toggle) toggle.textContent = `Dificultad: ${label}`;
        document.getElementById("spell-difficulty-options")?.classList.add("hidden");
        this.setDifficulty(btn.dataset.spellDiff);
        this._showInfo(`Dificultad cambiada a ${label}. Nueva palabra cargada.`);
        if (this.isActive) {
          this._usedWords.clear();
          this._nextWord();
        }
      });
    });
  }

  // ── Ciclo principal ────────────────────────────────────────────────────────

  async init(country = "lsc") {
    this.currentCountry = country;
  }

  async startQuiz() {
    this._usedWords.clear();
    this.score          = 0;
    this.wordsCompleted = 0;
    this._letterHistory = [];
    this.isActive       = true;

    this._showPanel("playing");
    this._updateScoreDisplay();

    // Cargar mapa de señas para finger-state matching
    try {
      const resp = await fetch(`/api/signs?country=${this.currentCountry}`);
      if (resp.ok) {
        const data = await resp.json();
        this.signsMap = {};
        (data.signs ?? []).forEach(s => { this.signsMap[s.id] = s; });
      }
    } catch (_) {}

    if (!this.mp) {
      await this._startCamera();
    } else {
      this.mp.resumeDetection && this.mp.resumeDetection();
    }

    // ── Iniciar WebSocket predictor ──────────────────────────────────────
    this._connectWs();

    this._nextWord();
  }

  _connectWs() {
    if (this.wsPredictor) {
      this.wsPredictor.disconnect();
    }
    this.wsPredictor = new WsPredictor(this.currentCountry);
    this.wsPredictor.onResult = (result) => this._handleWsResult(result);
    this.wsPredictor.connect();
  }

  _handleWsResult(data) {
    if (!this.isActive || !data) return;

    // ── Finger-state matching ────────────────────────────────────────────
    const targetLetter = this.currentWord?.[this.currentLetterIdx];
    const targetSign   = this.signsMap?.[targetLetter];
    if (targetSign?.finger_states?.length === 5 && data.fingers_up?.length === 5) {
      const exactMatch = data.fingers_up.every(
        (v, i) => v === (targetSign.finger_states[i] ?? false)
      );
      if (exactMatch && (data.confidence ?? 0) >= FINGER_FALLBACK_CONFIDENCE) {
        data.sign_id    = targetLetter;
        data.confidence = Math.max(data.confidence ?? 0, MIN_CONFIDENCE + 0.05);
      }
    }

    // ── Motion sign override (J, Z, S, Ñ) ───────────────────────────────
    if (data.motion_sign && MOTION_SIGNS.has(data.motion_sign)) {
      this._showMotionBadge(data.motion_sign);

      if (data.motion_trail?.length > 1) {
        this.motionTrail    = data.motion_trail;
        this.motionTrailTip = data.motion_sign === "Z" ? "index" : "pinky";
      }

      // If the motion sign matches the target, promote confidence
      if (data.motion_sign === targetLetter) {
        data.sign_id    = data.motion_sign;
        data.confidence = Math.max(data.confidence ?? 0, MIN_CONFIDENCE + 0.15);
      }
    } else {
      if (!data.motion_sign) this.motionTrail = [];
    }

    this.lastPredSign = data.sign_id;
    this.lastPredConf = data.confidence ?? 0;

    this._updatePredictionUI(data);
    this._checkLetterMatch(data.sign_id, data.confidence ?? 0);
  }

  _nextWord() {
    const list    = WORD_LISTS[this.currentCountry]?.[this.currentDifficulty] ?? WORD_LISTS.lsc.easy;
    const unused  = list.filter(w => !this._usedWords.has(w));
    const pool    = unused.length > 0 ? unused : list;
    const word    = pool[Math.floor(Math.random() * pool.length)];

    this._usedWords.add(word);
    this.currentWord      = word;
    this.currentLetterIdx = 0;
    this.holdFrames       = 0;
    this._stableSignId    = null;
    this.letterStartTime  = Date.now();
    this.motionTrail      = [];

    // Reset WS target context so motion buffer resets on backend
    if (this.wsPredictor?.isConnected()) {
      this.wsPredictor.send([], null);  // lightweight target reset
    }

    this._renderWord();
    this._renderCurrentLetter();
    this._updateHoldBar(0);
    this._speak(`Nueva palabra: ${this._spellForVoice(word)}. Letra ${this.currentWord[this.currentLetterIdx]}.`);

    const wordEl = document.getElementById("spell-word-display");
    if (wordEl) {
      wordEl.classList.remove("word-enter");
      void wordEl.offsetWidth;
      wordEl.classList.add("word-enter");
    }
  }

  _confirmLetter() {
    const letter = this.currentWord[this.currentLetterIdx];
    const ms     = Date.now() - this.letterStartTime;

    this._letterHistory.push({ letter, correct: true, ms });

    const bonus = ms < 2000 ? SCORE_SPEED_BONUS : 0;
    this.score += SCORE_PER_LETTER + bonus;
    this._updateScoreDisplay();

    this._markLetterDone(this.currentLetterIdx, true);

    this.currentLetterIdx++;
    this.holdFrames      = 0;
    this._stableSignId   = null;
    this.letterStartTime = Date.now();
    this.motionTrail     = [];

    if (this.currentLetterIdx >= this.currentWord.length) {
      this.wordsCompleted++;
      this._showWordComplete();
    } else {
      this._renderCurrentLetter();
      this._updateHoldBar(0);
      this._speak(`Correcto. Ahora letra ${this.currentWord[this.currentLetterIdx]}.`);
    }
  }

  // ── Predicción REST (fallback sin WebSocket) ────────────────────────────────

  async _predict(landmarksR, landmarksL, worldR, worldL, poseLandmarks = null) {
    if (!this.currentWord) return;
    this._predicting   = true;
    this.lastPredTime  = Date.now();

    try {
      const dominant = landmarksR ?? landmarksL;
      const body = {
        landmarks:             dominant,
        country:               this.currentCountry,
        landmarks_right:       landmarksR ?? null,
        landmarks_left:        landmarksL ?? null,
        world_landmarks_right: worldR ?? null,
        world_landmarks_left:  worldL ?? null,
        pose_landmarks:        poseLandmarks ?? null,
        target_sign_id:        this.currentWord?.[this.currentLetterIdx] ?? null,
      };
      const resp = await fetch("/api/predict", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (!resp.ok) return;

      const data = await resp.json();

      const targetLetter = this.currentWord?.[this.currentLetterIdx];
      const targetSign   = this.signsMap?.[targetLetter];
      if (targetSign?.finger_states?.length === 5 && data.fingers_up?.length === 5) {
        const exactMatch = data.fingers_up.every(
          (v, i) => v === (targetSign.finger_states[i] ?? false)
        );
      if (exactMatch && (data.confidence ?? 0) >= FINGER_FALLBACK_CONFIDENCE) {
        data.sign_id    = targetLetter;
        data.confidence = Math.max(data.confidence ?? 0, MIN_CONFIDENCE + 0.05);
      }
      }

      this.lastPredSign = data.sign_id;
      this.lastPredConf = data.confidence ?? 0;

      this._updatePredictionUI(data);
      this._checkLetterMatch(data.sign_id, data.confidence ?? 0);
    } catch (_) {
    } finally {
      this._predicting = false;
    }
  }

  _checkLetterMatch(signId, conf) {
    if (!this.currentWord || this.currentLetterIdx >= this.currentWord.length) return;
    const target = this.currentWord[this.currentLetterIdx];
    const isMotionTarget = MOTION_SIGNS.has(target);
    const minConfidence = isMotionTarget ? MIN_MOTION_CONFIDENCE : MIN_CONFIDENCE;

    if (signId === target && conf >= minConfidence) {
      if (this._stableSignId !== signId) {
        this._stableSignId = signId;
        this.holdFrames = 0;
      }
      this.holdFrames++;
      this._updateHoldBar(this.holdFrames / HOLD_REQUIRED);

      if (this.holdFrames >= HOLD_REQUIRED) {
        this._confirmLetter();
      }
    } else {
      if (signId !== target) this._stableSignId = null;
      this.holdFrames = Math.max(0, this.holdFrames - 2);
      this._updateHoldBar(this.holdFrames / HOLD_REQUIRED);
    }
  }

  // ── Cámara ─────────────────────────────────────────────────────────────────

  async _startCamera() {
    if (!this.videoEl) return;
    this.mp = new MediaPipeHandler({ numHands: 2, captureMode: false });
    const ok = await this.mp.init();
    if (!ok) {
      this._showError("❌ No se pudo iniciar la cámara.");
      return;
    }
    this._syncCanvas();
    await this.mp.startCamera(this.videoEl);
  }

  _syncCanvas() {
    if (!this.videoEl || !this.canvasEl) return;
    const ro = new ResizeObserver(() => {
      const W = this.videoEl.clientWidth  || 480;
      const H = this.videoEl.clientHeight || 360;
      this.canvasEl.width  = W;
      this.canvasEl.height = H;
      const tc = document.getElementById("spell-three-canvas");
      if (tc) { tc.width = W; tc.height = H; }
    });
    ro.observe(this.videoEl);
    const W = this.videoEl.clientWidth  || 480;
    const H = this.videoEl.clientHeight || 360;
    this.canvasEl.width  = W;
    this.canvasEl.height = H;
    const tc = document.getElementById("spell-three-canvas");
    if (tc) { tc.width = W; tc.height = H; }
  }

  stop() {
    this.isActive = false;
    if (this.wsPredictor) {
      this.wsPredictor.disconnect();
      this.wsPredictor = null;
    }
    if (this.mp) {
      this.mp.stopCamera();
      this.mp = null;
    }
  }

  setCountry(country) {
    this.currentCountry = country;
    if (this.wsPredictor) {
      this.wsPredictor.country = country;
    }
  }

  // ── Motion badge ────────────────────────────────────────────────────────────

  _showMotionBadge(signId) {
    const container = this.canvasEl?.parentElement;
    if (!container) return;

    let badge = document.getElementById("spell-motion-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "spell-motion-badge";
      badge.style.cssText = `
        position:absolute; top:10px; left:50%; transform:translateX(-50%);
        background: rgba(0,245,200,0.18); border: 1px solid rgba(0,245,200,0.55);
        color: #00f5c8; font-size:12px; font-weight:700; padding:3px 12px;
        border-radius:20px; pointer-events:none; z-index:20;
        text-shadow: 0 0 8px rgba(0,245,200,0.8);
        box-shadow: 0 0 10px rgba(0,245,200,0.3);
        transition: opacity 0.3s;
      `;
      container.style.position = "relative";
      container.appendChild(badge);
    }
    badge.textContent = `✋ Movimiento: ${signId}`;
    badge.style.opacity = "1";
    clearTimeout(this._motionBadgeTimer);
    this._motionBadgeTimer = setTimeout(() => { badge.style.opacity = "0"; }, 1400);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  _renderWord() {
    const el = document.getElementById("spell-word-display");
    if (!el || !this.currentWord) return;

    el.innerHTML = [...this.currentWord].map((letter, i) => {
      const state = i < this.currentLetterIdx ? "done"
                  : i === this.currentLetterIdx ? "current"
                  : "pending";
      return `<div class="spell-letter spell-letter-${state}" id="spell-letter-${i}">${letter}</div>`;
    }).join("");
  }

  _renderCurrentLetter() {
    if (!this.currentWord) return;
    const target = this.currentWord[this.currentLetterIdx];

    const targetEl = document.getElementById("spell-target-letter");
    if (targetEl) targetEl.textContent = target;

    const nameEl = document.getElementById("spell-target-name");
    if (nameEl) {
      const isMotion = MOTION_SIGNS.has(target);
      nameEl.textContent = isMotion
        ? `⚠️ Seña dinámica — traza el movimiento`
        : TRICKY_LETTERS.has(target)
          ? "⚠️ Seña especial — mira la guía"
          : `Letra ${target}`;
    }

    const progEl = document.getElementById("spell-letter-progress");
    if (progEl) {
      progEl.textContent = `${this.currentLetterIdx + 1} / ${this.currentWord.length}`;
    }
  }

  _markLetterDone(idx, correct) {
    const el = document.getElementById(`spell-letter-${idx}`);
    if (!el) return;
    el.classList.remove("spell-letter-current");
    el.classList.add(correct ? "spell-letter-done" : "spell-letter-error");
    if (correct) {
      el.classList.add("spell-letter-pop");
      setTimeout(() => el.classList.remove("spell-letter-pop"), 400);
    }
    const nextEl = document.getElementById(`spell-letter-${idx + 1}`);
    if (nextEl) {
      nextEl.classList.remove("spell-letter-pending");
      nextEl.classList.add("spell-letter-current");
    }
  }

  _updatePredictionUI(data) {
    const el = document.getElementById("spell-prediction");
    if (!el) return;
    const pct = Math.round((data.confidence ?? 0) * 100);
    const sign = data.sign_id ?? "—";
    const isMatch = sign === this.currentWord?.[this.currentLetterIdx];

    // Show motion sign prominently if detected
    const displaySign = (data.motion_sign && MOTION_SIGNS.has(data.motion_sign))
      ? `${data.sign_id} ✋`
      : sign;

    el.innerHTML = `
      <span class="spell-pred-sign ${isMatch ? "spell-pred-match" : ""}">${displaySign}</span>
      <span class="spell-pred-conf">${pct}%</span>
    `;

    // Also update the "de detecta" card
    const deDetecta = document.getElementById("spell-de-detecta");
    if (deDetecta) deDetecta.textContent = sign === "UNKNOWN" ? "—" : sign;
    const confFill = document.getElementById("spell-conf-fill");
    if (confFill) confFill.style.width = `${pct}%`;
    const confPct = document.getElementById("spell-conf-pct");
    if (confPct) confPct.textContent = `${pct}%`;
  }

  _updateHoldBar(fraction) {
    const bar = document.getElementById("spell-hold-fill");
    if (!bar) return;
    const pct = Math.min(100, Math.round(fraction * 100));
    bar.style.width = `${pct}%`;
    bar.className = `spell-hold-fill ${pct > 66 ? "hold-almost" : pct > 33 ? "hold-mid" : ""}`;
  }

  _updateScoreDisplay() {
    const el = document.getElementById("spell-score");
    if (el) el.textContent = this.score;
    const wEl = document.getElementById("spell-words-done");
    if (wEl) wEl.textContent = this.wordsCompleted;
  }

  _showWordComplete() {
    this._speak(`Palabra completada: ${this._spellForVoice(this.currentWord)}.`);
    const burst = document.getElementById("spell-word-burst");
    if (burst) {
      burst.style.display = "flex";
      burst.querySelector(".spell-burst-word").textContent = this.currentWord;
      burst.querySelector(".spell-burst-score").textContent = `+${SCORE_PER_LETTER * this.currentWord.length}`;
      setTimeout(() => {
        burst.style.display = "none";
        this._nextWord();
      }, 1800);
    } else {
      setTimeout(() => this._nextWord(), 1000);
    }
    this._updateScoreDisplay();
  }

  setDifficulty(diff) {
    this.currentDifficulty = diff;
  }

  toggleVoice() {
    this.voiceEnabled = !this.voiceEnabled;
    const btn = document.getElementById("btn-spell-voice");
    if (btn) {
      btn.textContent = this.voiceEnabled ? "Voz: On" : "Voz: Off";
      btn.classList.toggle("active", this.voiceEnabled);
    }
    this._speak(this.voiceEnabled ? "Voz activada." : "");
    if (!this.voiceEnabled && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }

  _spellForVoice(text) {
    return String(text ?? "")
      .replaceAll("_", " ")
      .split("")
      .join(" ");
  }

  _speak(text) {
    if (!this.voiceEnabled || !text || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = this.voiceLang;
    utterance.rate = 0.92;
    utterance.pitch = 1.02;
    window.speechSynthesis.speak(utterance);
  }

  _showInfo(msg) {
    const el = document.getElementById("spell-status");
    if (!el) return;
    el.textContent = msg;
    el.className = "spell-status-info";
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      if (el.textContent === msg) el.textContent = "";
    }, 2200);
  }

  _showPanel(which) {
    document.getElementById("spell-playing-panel")?.classList.toggle("hidden", which !== "playing");
  }

  _showError(msg) {
    const el = document.getElementById("spell-status");
    if (el) { el.textContent = msg; el.className = "spell-status-error"; }
  }

  _drawLiveHand(landmarks, worldLandmarks = null, landmarksSecondary = null, worldLandmarksSecondary = null) {
    if (!this.canvasEl) return;

    // 2D canvas: scan line + motion trail (HUD)
    Overlay.clearCanvas(this.canvasEl);
    Overlay.drawScanLine(this.canvasEl);

    if (this.motionTrail?.length > 1 && Overlay.drawMotionTrail) {
      const trailColor = this.motionTrailTip === "index" ? "255, 180, 50" : "0, 245, 200";
      Overlay.drawMotionTrail(this.canvasEl, this.motionTrail, trailColor);
    }

    // Three.js canvas: 3D hand skeleton with world-landmark depth
    const threeCanvas = document.getElementById("spell-three-canvas");
    if (threeCanvas && window.ThreeHandRenderer) {
      ThreeHandRenderer.syncSize(threeCanvas, threeCanvas.width, threeCanvas.height);
      ThreeHandRenderer.draw(threeCanvas, landmarks, worldLandmarks, {
        confidence: this.lastConfidence ?? 1,
      });
      if (landmarksSecondary && ThreeHandRenderer.drawSecondary) {
        ThreeHandRenderer.drawSecondary(threeCanvas, landmarksSecondary, worldLandmarksSecondary, 0.72);
      }
    }

    Overlay.drawUserHand(this.canvasEl, landmarks);
    if (landmarksSecondary && Overlay.drawUserHandSecondary) {
      Overlay.drawUserHandSecondary(this.canvasEl, landmarksSecondary);
    }
  }
}

window.SpellMode = SpellMode;
