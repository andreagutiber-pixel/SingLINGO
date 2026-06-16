/**
 * collect.js â€” Modo de recolecciÃ³n de datos de entrenamiento.
 *
 * Novedades v3:
 *   - BUG FIX: _renderSignGrid usa sampleCounts (actualizado al guardar)
 *             en lugar de allSigns (datos viejos del servidor)
 *   - GuÃ­as especiales para G, H, J, S, Z
 *   - Trail de movimiento en tiempo real durante grabaciÃ³n de J/Z
 *   - Contador de repeticiones para seÃ±as de movimiento
 *   - GuÃ­a de orientaciÃ³n horizontal para G/H
 *   - Total de muestras actualizado inmediatamente tras guardar
 */

const FRAMES_PER_SIGN   = 100;
const MIN_SIGNS_TO_TRAIN = 5;

// â”€â”€ ConfiguraciÃ³n de seÃ±as especiales â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// SeÃ±as que necesitan guÃ­as visuales adicionales porque son difÃ­ciles de grabar

const SIGN_CONFIG = {
  G: {
    icon: "<->",
    mode: "motion_orientation",
    color: "0, 245, 200",
    tipIdx: 8,
    title: "Orientacion horizontal",
    hints: [
      "Gira la muneca 90 grados: la mano de lado",
      "El indice apunta hacia la derecha o izquierda",
      "El pulgar tambien queda horizontal",
    ],
    warning: "Mantén G de lado y repite un movimiento corto durante la grabación.",
    repLabel: "indice",
  },
  H: {
    icon: "<->",
    mode: "motion_orientation",
    color: "100, 180, 255",
    tipIdx: 12,
    title: "Dos dedos horizontales",
    hints: [
      "Indice y medio extendidos, los demas cerrados",
      "La mano de lado: dedos apuntan horizontalmente",
      "Palma mirando hacia abajo o hacia ti",
    ],
    warning: "Mantén H horizontal y repite un movimiento corto durante la grabación.",
    repLabel: "dedo medio",
  },
  J: {
    icon: "J",
    mode: "motion",
    color: "255, 120, 80",
    tipIdx: 20,
    title: "Sena de movimiento",
    hints: [
      "Solo el menique extendido (como la letra I)",
      "Mueve el menique hacia abajo",
      "Al final, gira en gancho (como una J)",
    ],
    warning: "Repite el movimiento 4-5 veces durante la grabacion.",
    repLabel: "menique",
  },
  S: {
    icon: "S",
    mode: "motion",
    color: "200, 100, 255",
    tipIdx: 0,
    title: "Pulgar encima del puno",
    hints: [
      "Cierra el puno firmemente (todos los dedos doblados)",
      "El pulgar cruza POR ENCIMA de los dedos (no al lado)",
      "Haz una sacudida corta de muñeca para diferenciarla de A",
    ],
    warning: "Repite la sacudida 4-5 veces durante la grabación.",
    repLabel: "muneca",
  },
  "Ã‘": {
    icon: "~",
    mode: "motion",
    color: "20, 210, 255",
    tipIdx: 12,
    title: "Movimiento de tilde",
    hints: [
      "Forma la N primero",
      "Mueve la mano en una tilde corta (~)",
      "Movimiento suave, no un zigzag amplio",
    ],
    warning: "Repite la tilde 4-5 veces durante la grabacion.",
    repLabel: "dedo medio",
  },
  "Ãƒâ€˜": {
    icon: "~",
    mode: "motion",
    color: "20, 210, 255",
    tipIdx: 12,
    title: "Movimiento de tilde",
    hints: [
      "Forma la N primero",
      "Mueve la mano en una tilde corta (~)",
      "Movimiento suave, no un zigzag amplio",
    ],
    warning: "Repite la tilde 4-5 veces durante la grabacion.",
    repLabel: "dedo medio",
  },
  Z: {
    icon: "Z",
    mode: "motion",
    color: "124, 58, 237",
    tipIdx: 8,
    title: "Sena de movimiento",
    hints: [
      "Solo el indice extendido",
      "Traza la letra Z: derecha, diagonal, derecha",
      "El movimiento debe ser amplio y claro",
    ],
    warning: "Repite la Z completa 4-5 veces durante la grabacion.",
    repLabel: "indice",
  },
};

SIGN_CONFIG["\u00D1"] = SIGN_CONFIG["\u00D1"] || SIGN_CONFIG["Ã‘"] || SIGN_CONFIG["Ãƒâ€˜"];
SIGN_CONFIG["Ã‘"] = SIGN_CONFIG["\u00D1"];
SIGN_CONFIG["Ãƒâ€˜"] = SIGN_CONFIG["\u00D1"];

// Cantidad de frames en trail visual
const TRAIL_MAX = 35;

function isMotionMode(cfg) {
  return cfg?.mode?.includes("motion");
}

function isOrientationMode(cfg) {
  return cfg?.mode?.includes("orientation");
}

function getSignConfig(signId) {
  if (!signId) return null;
  const key = String(signId).toUpperCase();
  return SIGN_CONFIG[key] || null;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class CollectMode {
  constructor() {
    this.mp = null;
    this.currentCountry = "lsc";
    this.currentSignId  = null;
    this.isRecording    = false;
    this.capturedFrames = [];
    this.sampleMeta     = {};
    this.sampleCounts   = {};   // signId â†’ count (siempre actualizado)
    this.allSigns       = [];
    this.cameraActive   = false;
    this.searchTerm     = "";
    this.categoryFilter = "alphabet";
    this._latestPose    = null;
    this._recordingStartedAt = 0;
    this._sequenceId = null;

    this._currentFps    = 0;
    this._fpsEl         = null;

    // Motion trail para J/Z
    this._motionTrail   = [];
    this._repCount      = 0;
    this._motionPeak    = 0;
    this._lastTipPos    = null;
    this._prevVel       = 0;
    this._inMotion      = false;

    this.videoEl  = document.getElementById("collect-video");
    this.canvasEl = document.getElementById("collect-canvas");

    this._bindUI();
    this._loadCaptureProtocol();
  }

  _bindUI() {
    document.addEventListener("handsUpdate", (e) => {
      if (!this.cameraActive) return;
      const { right, left, total_hands, pose } = e.detail;
      this._latestPose = pose ?? null;
      const hands = this._normalizeHands(right, left);
      if (!hands.primary) return;

      this._drawFrame(hands.primary.landmarks, hands.secondary?.landmarks ?? null, total_hands ?? 1);

      if (this.isRecording) {
        this._captureFrame(hands.primary, hands.secondary, pose ?? null, total_hands ?? 1);
      }
    });

    document.addEventListener("noHand", () => {
      if (this.canvasEl) Overlay.clearCanvas(this.canvasEl);
      this._drawFpsOverlay();
    });

    document.addEventListener("cameraReady", () => {
      this.cameraActive = true;
      const dot  = document.getElementById("collect-cam-dot");
      const text = document.getElementById("collect-cam-text");
      if (dot)  dot.classList.add("active");
      if (text) text.textContent = "Detectando";
    });

    document.addEventListener("fpsUpdate", (e) => {
      this._currentFps = e.detail?.fps ?? 0;
      this._updateFpsEl();
    });

    document.getElementById("btn-collect-record")
      ?.addEventListener("click", () => this._startRecording());

    document.getElementById("collect-country-select")
      ?.addEventListener("change", (e) => {
        this.currentCountry = e.target.value;
        this._loadStatusForCountry();
      });

    document.getElementById("btn-retrain")
      ?.addEventListener("click", () => this._triggerRetrain());

    document.getElementById("btn-validate-dataset")
      ?.addEventListener("click", () => this._validateDatasetQuality());

    document.getElementById("btn-quality-info")
      ?.addEventListener("click", () => this._openQualityModal());

    document.getElementById("btn-close-quality-modal")
      ?.addEventListener("click", () => this._closeQualityModal());

    document.getElementById("quality-modal")
      ?.addEventListener("click", (e) => {
        if (e.target?.id === "quality-modal") this._closeQualityModal();
      });

    document.getElementById("btn-export-dataset")
      ?.addEventListener("click", () => this._exportDataset());

    document.getElementById("btn-import-dataset")
      ?.addEventListener("click", () => document.getElementById("dataset-import-file")?.click());

    document.getElementById("dataset-import-file")
      ?.addEventListener("change", (e) => this._importDataset(e));

    document.getElementById("btn-clear-sign")
      ?.addEventListener("click", () => this._clearCurrentSign());

    document.getElementById("train-search-input")?.addEventListener("input", (e) => {
      this.searchTerm = e.target.value.trim().toLowerCase();
      this._renderSignGrid();
    });

    document.querySelectorAll("[data-train-cat]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-train-cat]").forEach(item => item.classList.remove("active"));
        btn.classList.add("active");
        this.categoryFilter = btn.dataset.trainCat ?? "all";
        this._renderSignGrid();
      });
    });

    document.getElementById("btn-new-sign")?.addEventListener("click", () => this._openNewSignModal());
    document.getElementById("btn-close-new-sign")?.addEventListener("click", () => this._closeNewSignModal());
    document.getElementById("btn-cancel-new-sign")?.addEventListener("click", () => this._closeNewSignModal());
    document.getElementById("new-sign-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "new-sign-modal") this._closeNewSignModal();
    });
    document.getElementById("new-sign-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this._createNewSign();
    });

    [
      "capture-participant-id",
      "capture-dominant-hand",
      "capture-distance",
      "capture-environment",
    ].forEach((id) => {
      const el = document.getElementById(id);
      el?.addEventListener("change", () => {
        this._saveCaptureProtocol();
        this._updateProtocolProgress();
      });
      el?.addEventListener("input", () => {
        this._saveCaptureProtocol();
        this._updateProtocolProgress();
      });
    });
  }

  _loadCaptureProtocol() {
    const saved = JSON.parse(localStorage.getItem("signlingo_capture_protocol") || "{}");
    const setValue = (id, value) => {
      const el = document.getElementById(id);
      if (el && value) el.value = value;
    };
    setValue("capture-participant-id", saved.participant_id);
    setValue("capture-dominant-hand", saved.dominant_hand);
    setValue("capture-distance", saved.camera_distance);
    setValue("capture-environment", saved.capture_environment);
    this._updateProtocolProgress();
  }

  _openNewSignModal() {
    const modal = document.getElementById("new-sign-modal");
    modal?.classList.remove("hidden");
    const country = document.getElementById("collect-country-select")?.value ?? this.currentCountry;
    this.currentCountry = country;
    document.getElementById("new-sign-id")?.focus();
  }

  _closeNewSignModal() {
    document.getElementById("new-sign-modal")?.classList.add("hidden");
    const status = document.getElementById("new-sign-form-status");
    if (status) {
      status.textContent = "";
      status.className = "new-sign-form-status";
    }
  }

  async _createNewSign() {
    const status = document.getElementById("new-sign-form-status");
    const submit = document.querySelector("#new-sign-form button[type='submit']");
    const fingerStates = Array.from(document.querySelectorAll("[data-new-finger]"))
      .map(input => input.checked);
    const requiresMotion = document.getElementById("new-sign-motion")?.checked ?? false;
    const payload = {
      country: this.currentCountry,
      sign_id: document.getElementById("new-sign-id")?.value ?? "",
      name: document.getElementById("new-sign-name")?.value ?? "",
      category: document.getElementById("new-sign-category")?.value ?? "words",
      difficulty: Number(document.getElementById("new-sign-difficulty")?.value ?? 2),
      description: document.getElementById("new-sign-description")?.value ?? "",
      tips: (document.getElementById("new-sign-tips")?.value ?? "")
        .split(/\r?\n/)
        .map(item => item.trim())
        .filter(Boolean),
      finger_states: fingerStates,
      two_handed: document.getElementById("new-sign-two-handed")?.checked ?? false,
      requires_motion: requiresMotion,
      motion_type: requiresMotion ? "custom_sequence" : null,
    };

    if (requiresMotion && status) {
      status.textContent = "Se registrará como dinámica. Captura varias repeticiones completas; el modelo temporal genérico aún está en desarrollo.";
      status.className = "new-sign-form-status warn";
    }

    if (submit) submit.disabled = true;
    try {
      const resp = await fetch("/api/train/signs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail ?? "No se pudo crear la seña.");

      await this._loadStatusForCountry();
      this.selectSign(data.sign.id);
      document.getElementById("new-sign-form")?.reset();
      this._closeNewSignModal();
      this._showStatus(data.message, "success");
    } catch (error) {
      if (status) {
        status.textContent = error.message;
        status.className = "new-sign-form-status error";
      }
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  _getCaptureProtocol() {
    const participant = document.getElementById("capture-participant-id")?.value?.trim() ?? "";
    return {
      participant_id: participant.toUpperCase(),
      dominant_hand: document.getElementById("capture-dominant-hand")?.value ?? "right",
      camera_distance: document.getElementById("capture-distance")?.value ?? "normal",
      capture_environment: document.getElementById("capture-environment")?.value ?? "indoor",
    };
  }

  _saveCaptureProtocol() {
    localStorage.setItem("signlingo_capture_protocol", JSON.stringify(this._getCaptureProtocol()));
  }

  _getSignConfig(signId) {
    const predefined = getSignConfig(signId);
    if (predefined) return predefined;
    const sign = this.allSigns.find(item => item.sign_id === signId);
    if (!sign?.requires_motion) return null;
    return {
      mode: "motion",
      title: "Seña dinámica personalizada",
      hints: ["Mantén primero la postura base", "Realiza el movimiento completo varias veces"],
      warning: "Graba el recorrido completo, no solo la posición final.",
      color: "34,86,136",
    };
  }

  _getCurrentSignMeta() {
    return this.allSigns.find(item => item.sign_id === this.currentSignId) ?? null;
  }

  _getCaptureMode(signMeta, cfg) {
    if (signMeta?.requires_pose || signMeta?.body_zone) return "body_sequence";
    if (signMeta?.requires_motion || isMotionMode(cfg)) return "motion_sequence";
    return "frames";
  }

  _updateProtocolProgress() {
    const el = document.getElementById("capture-protocol-progress");
    if (!el) return;

    const protocol = this._getCaptureProtocol();
    const meta = this.sampleMeta[this.currentSignId] ?? { participants: 0, environments: 0 };
    const participants = meta.participants ?? 0;
    const environments = meta.environments ?? 0;
    const hasParticipant = protocol.participant_id.length >= 2;

    const isPrototypeReady = participants >= 5 && environments >= 2;
    const isIdealReady = participants >= 10 && environments >= 3;
    el.classList.toggle("ready", isPrototypeReady);
    el.classList.toggle("ideal", isIdealReady);
    el.classList.toggle("warn", !hasParticipant || (!isPrototypeReady && participants > 0));

    if (!hasParticipant) {
      el.textContent = "Escribe un codigo de participante antes de grabar.";
      return;
    }

    const status = isIdealReady
      ? "Dataset ideal"
      : isPrototypeReady
      ? "Listo para prototipo"
      : "Necesita mas variedad";
    el.textContent = `${status}: ${participants}/5 personas · ${environments}/2 entornos · ideal 10 personas`;
  }

  // â”€â”€ InicializaciÃ³n â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async init(country = "lsc") {
    this.currentCountry = country;
    await this._loadStatusForCountry();
    this._createFpsEl();
    await this._startCamera();
  }

  _createFpsEl() {
    const container = this.canvasEl?.parentElement;
    if (!container) return;
    if (document.getElementById("collect-fps")) return;

    const el = document.createElement("div");
    el.id = "collect-fps";
    el.className = "collect-fps";
    el.textContent = "-- FPS";
    container.style.position = "relative";
    container.appendChild(el);
    this._fpsEl = el;
  }

  _updateFpsEl() {
    if (!this._fpsEl) return;
    const fps = this._currentFps;
    this._fpsEl.textContent = `${fps} FPS`;
    this._fpsEl.className = `collect-fps ${fps >= 25 ? "fps-good" : fps >= 15 ? "fps-ok" : "fps-bad"}`;
  }

  async _loadStatusForCountry() {
    try {
      const resp = await fetch(`/api/train/status/${this.currentCountry}`);
      const status = await resp.json();
      this.allSigns = status.samples_per_sign ?? [];
      // Reconstruir sampleCounts desde datos frescos del servidor
      this.sampleCounts = {};
      this.sampleMeta   = {};
      this.allSigns.forEach(s => {
        this.sampleCounts[s.sign_id] = s.count;
        this.sampleMeta[s.sign_id] = {
          participants: s.participants ?? 0,
          environments: s.environments ?? 0,
        };
      });
      this._renderSignGrid();
      this._updateProtocolProgress();
      this._updateTrainButton(status);
      this._updateReadyCount(status);
      this._refreshQualityPanelSilent();
    } catch (e) {
      console.error("[Collect] Error cargando estado:", e);
    }
  }

  async _startCamera() {
    if (!this.videoEl) return;
    if (!this.mp) {
      this.mp = new MediaPipeHandler({ numHands: 2, captureMode: true });
      this._showStatus("Cargando modelo de IA (~8 MB)...", "info");
      const ok = await this.mp.init();
      if (!ok) {
        this._showStatus("Error cargando MediaPipe. Verifica tu conexion.", "error");
        return;
      }
    }
    this._syncCanvas();
    this._showStatus("Permite el acceso a la camara cuando el navegador te lo pida.", "info");
    await this.mp.startCamera(this.videoEl);
    this._showStatus("", "");
  }

  _syncCanvas() {
    if (!this.videoEl || !this.canvasEl) return;
    const ro = new ResizeObserver(() => {
      this.canvasEl.width  = this.videoEl.clientWidth  || 480;
      this.canvasEl.height = this.videoEl.clientHeight || 360;
    });
    ro.observe(this.videoEl);
    this.canvasEl.width  = this.videoEl.clientWidth  || 480;
    this.canvasEl.height = this.videoEl.clientHeight || 360;
  }

  // â”€â”€ SelecciÃ³n de seÃ±a â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  selectSign(signId) {
    this.currentSignId = signId;

    document.querySelectorAll(".collect-sign-item").forEach(el => {
      el.classList.toggle("selected", el.dataset.signId === signId);
    });

    const count = this.sampleCounts[signId] ?? 0;
    const meta  = this.sampleMeta[signId] ?? { participants: 0, environments: 0 };
    const pct   = Math.min(100, Math.round((count / FRAMES_PER_SIGN) * 100));
    const cfg   = this._getSignConfig(signId);
    const signMeta = this.allSigns.find(s => s.sign_id === signId) ?? {};
    const infoEl = document.getElementById("collect-sign-info");
    if (infoEl) {
      let specialHtml = "";

      if (cfg) {
        const hintsHtml = cfg.hints.map(h =>
          `<li style="text-align:left; margin-bottom:0.3rem; font-size:0.78rem; color:var(--text-muted)">${h}</li>`
        ).join("");

        const modeLabel = isMotionMode(cfg)
          ? `<span class="sign-badge sign-badge-motion">Sena de movimiento</span>`
          : isOrientationMode(cfg)
          ? `<span class="sign-badge sign-badge-orientation">Orientacion especial</span>`
          : `<span class="sign-badge sign-badge-special">Posicion especial</span>`;

        specialHtml = `
          <div class="sign-guide-box" style="margin:0.6rem 0; background:rgba(${cfg.color},0.08);
            border:1px solid rgba(${cfg.color},0.25); border-radius:8px; padding:0.75rem; text-align:left">
            <div style="margin-bottom:0.4rem">${modeLabel}</div>
            <strong style="font-size:0.82rem; color:rgba(${cfg.color},1)">${cfg.title}</strong>
            <ul style="margin:0.4rem 0 0.3rem 0; padding-left:1.1rem">${hintsHtml}</ul>
            ${cfg.warning ? `<div style="font-size:0.75rem; margin-top:0.4rem; opacity:0.9">${cfg.warning}</div>` : ""}
          </div>`;
      }

      const requirements = [];
      if (signMeta.two_handed) requirements.push("Debe verse la segunda mano durante casi toda la grabación.");
      if (signMeta.requires_motion) requirements.push("Graba el recorrido completo, no solo la postura final.");
      if (signMeta.requires_pose || signMeta.body_zone) requirements.push("Aléjate un poco: cara, hombros y pecho deben entrar en cámara.");
      if ((meta.participants ?? 0) < 5) requirements.push(`Prioridad: faltan ${5 - (meta.participants ?? 0)} participantes para prototipo.`);
      if ((meta.environments ?? 0) < 2) requirements.push("Prioridad: falta variedad de luz/fondo.");

      if (requirements.length) {
        specialHtml += `
          <div class="sign-requirements-box">
            ${requirements.slice(0, 4).map(item => `<div>${item}</div>`).join("")}
          </div>
        `;
      }

      const imgPath = window.getSignImagePath ? window.getSignImagePath(signId) : null;
      infoEl.innerHTML = `
        ${imgPath
          ? `<div class="collect-selected-photo-wrap"><img src="${imgPath}" alt="Sena ${signId}" class="collect-selected-photo-img" /></div>`
          : `<div class="collect-target-sign">${signId}</div>`
        }
        <div class="collect-sample-count">
          <strong style="font-size:1.1rem; color:var(--blue-dark); font-family:'Martian Mono',monospace;">${signId}</strong>
          &nbsp;·&nbsp;
          <span class="${count >= FRAMES_PER_SIGN ? "text-cyan" : "text-muted"}">${count}</span>
          <span class="text-muted"> / ${FRAMES_PER_SIGN}</span>
        </div>
        <div class="collect-mini-bar">
          <div class="collect-mini-fill" style="width:${pct}%"></div>
        </div>
        <p class="text-muted" style="font-size:0.68rem; margin-top:0.35rem; font-family:'Martian Mono',monospace; line-height:1.35;">
          ${meta.participants ?? 0}/5 personas · ${meta.environments ?? 0}/2 entornos
        </p>
        <p class="text-muted" style="font-size:0.75rem; margin-top:0.4rem; font-family:'Martian Mono',monospace; line-height:1.4;">
          ${count >= FRAMES_PER_SIGN
            ? "Suficientes muestras. Puedes grabar mas."
            : `Faltan ${FRAMES_PER_SIGN - count} frames.`}
        </p>
        ${specialHtml}
      `;
    }

    const btn = document.getElementById("btn-collect-record");
    const clearBtn = document.getElementById("btn-clear-sign");
    if (btn) {
      btn.disabled = false;
      // Etiqueta especial para seÃ±as de movimiento
      btn.textContent = isMotionMode(cfg)
        ? `Grabar movimiento (${FRAMES_PER_SIGN} frames)`
        : `Grabar (${FRAMES_PER_SIGN} frames)`;
    }
    if (clearBtn) clearBtn.disabled = count === 0;
    this._updateProtocolProgress();
  }

  // â”€â”€ GrabaciÃ³n â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  _startRecording() {
    if (!this.currentSignId) {
      this._showStatus("Selecciona una sena primero.", "warn");
      return;
    }
    if (!this.mp?.isReady()) {
      this._showStatus("La camara no esta lista.", "warn");
      return;
    }
    const protocol = this._getCaptureProtocol();
    if (protocol.participant_id.length < 2) {
      this._showStatus("Escribe un codigo de participante, por ejemplo P01.", "warn");
      document.getElementById("capture-participant-id")?.focus();
      this._updateProtocolProgress();
      return;
    }
    this._saveCaptureProtocol();

    this.isRecording    = true;
    this.capturedFrames = [];
    this._recordingStartedAt = performance.now();
    this._sequenceId = `${this.currentCountry}_${this.currentSignId}_${Date.now()}`;

    // Reset motion tracking
    this._motionTrail  = [];
    this._repCount     = 0;
    this._motionPeak   = 0;
    this._lastTipPos   = null;
    this._prevVel      = 0;
    this._inMotion     = false;

    const cfg = this._getSignConfig(this.currentSignId);
    const signMeta = this._getCurrentSignMeta();
    const captureMode = this._getCaptureMode(signMeta, cfg);
    const btn = document.getElementById("btn-collect-record");
    if (btn) {
      btn.textContent = `Grabando 0 / ${FRAMES_PER_SIGN}`;
      btn.disabled    = true;
      btn.classList.add("recording");
    }

    const msg = captureMode === "body_sequence"
      ? `Grabando "${this.currentSignId}" con manos + cuerpo. Mantén el cuerpo visible.`
      : isMotionMode(cfg)
      ? `Grabando "${this.currentSignId}" — ${cfg.warning}`
      : isOrientationMode(cfg)
      ? `Grabando "${this.currentSignId}" — ${cfg.warning}`
      : `Grabando "${this.currentSignId}" — mantén la mano estable`;

    this._showStatus(msg, "info");
  }

  _normalizeHands(right, left) {
    // Mantener slots consistentes con inferencia: derecha primero, izquierda segunda.
    const primary = right ?? left;
    const secondary = right ? left : null;
    return { primary, secondary };
  }

  _captureFrame(primaryHand, secondaryHand = null, poseLandmarks = null, totalHands = 1) {
    if (!this.isRecording) return;

    const landmarks = primaryHand?.landmarks;
    if (!landmarks) return;
    const signMeta = this._getCurrentSignMeta();
    if (signMeta?.two_handed && totalHands < 2) {
      this._showStatus("Esta seña requiere dos manos visibles para guardar muestras.", "warn");
      return;
    }
    if ((signMeta?.requires_pose || signMeta?.body_zone) && !poseLandmarks) {
      this._showStatus("Esta seña necesita cuerpo visible; aléjate un poco de la cámara.", "warn");
      return;
    }

    const frame = {
      landmarks,
      frame_index: this.capturedFrames.length,
      timestamp_ms: Math.round(performance.now() - this._recordingStartedAt),
    };
    if (primaryHand.worldLandmarks) frame.world_landmarks = primaryHand.worldLandmarks;
    if (secondaryHand?.landmarks) frame.landmarks_left = secondaryHand.landmarks;
    if (secondaryHand?.worldLandmarks) frame.world_landmarks_left = secondaryHand.worldLandmarks;
    if (poseLandmarks?.length === 33) frame.pose_landmarks = poseLandmarks;
    this.capturedFrames.push(frame);

    const n   = this.capturedFrames.length;
    const btn = document.getElementById("btn-collect-record");
    if (btn) btn.textContent = `Grabando ${n} / ${FRAMES_PER_SIGN}`;

    // â”€â”€ Tracking de movimiento para seÃ±as J y Z â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const cfg = this._getSignConfig(this.currentSignId);
    if (isMotionMode(cfg) && cfg.tipIdx !== undefined) {
      const tip = landmarks[cfg.tipIdx];
      if (tip) {
        // AÃ±adir al trail
        this._motionTrail.push({ x: tip.x, y: tip.y });
        if (this._motionTrail.length > TRAIL_MAX) {
          this._motionTrail.shift();
        }

        // Detectar repeticiÃ³n: velocidad sube y luego baja (1 ciclo = 1 rep)
        if (this._lastTipPos) {
          const dx = tip.x - this._lastTipPos.x;
          const dy = tip.y - this._lastTipPos.y;
          const vel = Math.sqrt(dx * dx + dy * dy);

          if (vel > 0.012) {
            this._inMotion = true;
            this._motionPeak = Math.max(this._motionPeak, vel);
          } else if (vel < 0.004 && this._inMotion && this._motionPeak > 0.025) {
            // Movimiento terminÃ³: completÃ³ una rep
            this._inMotion    = false;
            this._motionPeak  = 0;
            this._repCount++;
          }
        }
        this._lastTipPos = { x: tip.x, y: tip.y };
      }
    }

    this._drawRecordingProgress(n, FRAMES_PER_SIGN);

    if (n >= FRAMES_PER_SIGN) {
      this.isRecording = false;
      if (!this._validateCapturedSequence()) {
        this.capturedFrames = [];
        const btn = document.getElementById("btn-collect-record");
        if (btn) {
          const cfg = this._getSignConfig(this.currentSignId);
          btn.textContent = isMotionMode(cfg)
            ? `⏺ Grabar movimiento (${FRAMES_PER_SIGN} frames)`
            : `⏺ Grabar (${FRAMES_PER_SIGN} frames)`;
          btn.disabled = false;
          btn.classList.remove("recording");
        }
        return;
      }
      this._saveSamples();
    }
  }

  _sanitizePoint(point, includeVisibility = false, limit = 5) {
    if (!point) return null;
    const x = Number(point.x);
    const y = Number(point.y);
    const z = Number(point.z ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    const clamp = (value) => Math.max(-limit, Math.min(limit, value));
    const clean = { x: clamp(x), y: clamp(y), z: clamp(z) };
    if (includeVisibility) {
      const visibility = Number(point.visibility ?? 0);
      clean.visibility = Number.isFinite(visibility) ? Math.max(0, Math.min(1, visibility)) : 0;
    }
    return clean;
  }

  _sanitizePointList(points, expectedLength, includeVisibility = false, limit = 5) {
    if (!Array.isArray(points) || points.length !== expectedLength) return null;
    const clean = points.map(p => this._sanitizePoint(p, includeVisibility, limit));
    return clean.every(Boolean) ? clean : null;
  }

  _sanitizeFrameForSave(frame) {
    const landmarks = this._sanitizePointList(frame.landmarks, 21);
    if (!landmarks) return null;

    const clean = {
      landmarks,
      frame_index: Number.isFinite(Number(frame.frame_index)) ? Number(frame.frame_index) : 0,
      timestamp_ms: Number.isFinite(Number(frame.timestamp_ms)) ? Number(frame.timestamp_ms) : 0,
    };

    const world = this._sanitizePointList(frame.world_landmarks, 21);
    if (world) clean.world_landmarks = world;

    const left = this._sanitizePointList(frame.landmarks_left, 21);
    if (left) clean.landmarks_left = left;

    const worldLeft = this._sanitizePointList(frame.world_landmarks_left, 21);
    if (worldLeft) clean.world_landmarks_left = worldLeft;

    const pose = this._sanitizePointList(frame.pose_landmarks, 33, true, 10);
    if (pose) clean.pose_landmarks = pose;

    return clean;
  }

  _formatApiError(errorLike) {
    if (!errorLike) return "Error desconocido";
    if (typeof errorLike === "string") return errorLike;
    if (Array.isArray(errorLike)) {
      return errorLike.slice(0, 4).map(item => this._formatApiError(item)).join(" | ");
    }
    if (typeof errorLike === "object") {
      const loc = Array.isArray(errorLike.loc) ? errorLike.loc.join(".") : "";
      const msg = errorLike.msg ?? errorLike.message ?? errorLike.detail;
      if (msg) return loc ? `${loc}: ${this._formatApiError(msg)}` : this._formatApiError(msg);
      try { return JSON.stringify(errorLike); } catch (_) { return String(errorLike); }
    }
    return String(errorLike);
  }

  _validateCapturedSequence() {
    const signMeta = this._getCurrentSignMeta();
    const cfg = this._getSignConfig(this.currentSignId);
    if (!this.capturedFrames.length) return false;

    if (signMeta?.two_handed) {
      const twoHandFrames = this.capturedFrames.filter(f => f.landmarks_left?.length === 21).length;
      if (twoHandFrames < Math.round(this.capturedFrames.length * 0.8)) {
        this._showStatus("No guardé la muestra: faltó la segunda mano en demasiados frames.", "warn");
        return false;
      }
    }

    if (signMeta?.requires_pose || signMeta?.body_zone) {
      const poseFrames = this.capturedFrames.filter(f => f.pose_landmarks?.length === 33).length;
      if (poseFrames < Math.round(this.capturedFrames.length * 0.8)) {
        this._showStatus("No guardé la muestra: faltó el cuerpo visible en demasiados frames.", "warn");
        return false;
      }
    }

    if (signMeta?.requires_motion || isMotionMode(cfg)) {
      const trail = this._motionTrail.length
        ? this._motionTrail
        : this.capturedFrames
            .map(f => f.landmarks?.[cfg?.tipIdx ?? 0] ?? f.landmarks?.[8] ?? f.landmarks?.[0])
            .filter(Boolean)
            .map(p => ({ x: p.x, y: p.y }));
      const path = trail.reduce((sum, p, i, arr) => {
        if (i === 0) return 0;
        const prev = arr[i - 1];
        return sum + Math.hypot(p.x - prev.x, p.y - prev.y);
      }, 0);
      if (path < 0.08) {
        this._showStatus("No guardé la muestra: el movimiento fue muy corto o no se detectó.", "warn");
        return false;
      }
    }
    return true;
  }

  // â”€â”€ Guardado â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async _saveSamples() {
    if (!this.capturedFrames.length) return;

    const btn = document.getElementById("btn-collect-record");
    if (btn) {
      btn.textContent = "Guardando...";
      btn.classList.remove("recording");
    }
    this._showStatus("Guardando muestras en el servidor...", "info");

    try {
      const cleanSamples = this.capturedFrames
        .map(frame => this._sanitizeFrameForSave(frame))
        .filter(Boolean);
      if (!cleanSamples.length) {
        this._showStatus("No se guardó: los frames capturados venían incompletos. Repite la grabación con la mano completa visible.", "error");
        return;
      }

      const resp = await fetch("/api/train/collect", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          sign_id:  this.currentSignId,
          country:  this.currentCountry,
          ...this._getCaptureProtocol(),
          sequence_id: this._sequenceId,
          capture_mode: this._getCaptureMode(this._getCurrentSignMeta(), this._getSignConfig(this.currentSignId)),
          samples:  cleanSamples,
        }),
      });
      const data = await resp.json().catch(() => ({
        detail: `HTTP ${resp.status} ${resp.statusText}`,
      }));

      if (resp.ok) {
        // â”€â”€ BUG FIX: actualizar sampleCounts Y re-renderizar con nuevos valores â”€â”€
        this.sampleCounts[this.currentSignId] = data.total_for_sign;

        // TambiÃ©n actualizar el objeto en allSigns para consistencia
        const idx = this.allSigns.findIndex(s => s.sign_id === this.currentSignId);
        if (idx >= 0) {
          this.allSigns[idx] = {
            ...this.allSigns[idx],
            count:  data.total_for_sign,
            enough: data.total_for_sign >= FRAMES_PER_SIGN,
          };
        }

        this._showStatus(
          `${data.saved} frames guardados. Total "${this.currentSignId}": ${data.total_for_sign} / ${FRAMES_PER_SIGN}`,
          "success",
        );

        // Actualizar grid y panel de seÃ±a seleccionada
        await this._loadStatusForCountry();
        this.selectSign(this.currentSignId);
      } else {
        const detail = this._formatApiError(data.detail ?? data.message ?? data);
        this._showStatus(`❌ Error guardando: ${detail}`, "error");
      }
    } catch (e) {
      this._showStatus(`❌ Error de red: ${e.message}. Revisa que el servidor siga activo.`, "error");
    } finally {
      this.capturedFrames = [];
      this._motionTrail   = [];
      if (btn) {
        const cfg = this._getSignConfig(this.currentSignId);
        btn.textContent = isMotionMode(cfg)
          ? `Grabar movimiento (${FRAMES_PER_SIGN} frames)`
          : `Grabar (${FRAMES_PER_SIGN} frames)`;
        btn.disabled = false;
      }
      if (this.canvasEl) Overlay.clearCanvas(this.canvasEl);
    }
  }

  async _clearCurrentSign() {
    if (!this.currentSignId) return;
    try {
      await fetch(`/api/train/collected/${this.currentCountry}/${this.currentSignId}`, {
        method: "DELETE",
      });
      this.sampleCounts[this.currentSignId] = 0;
      this.sampleMeta[this.currentSignId] = { participants: 0, environments: 0 };
      const idx = this.allSigns.findIndex(s => s.sign_id === this.currentSignId);
      if (idx >= 0) {
        this.allSigns[idx] = {
          ...this.allSigns[idx],
          count: 0,
          enough: false,
          participants: 0,
          environments: 0,
        };
      }
      this._renderSignGrid();
      this.selectSign(this.currentSignId);
      this._showStatus(`Datos de "${this.currentSignId}" borrados.`, "info");
      await this._updateTrainButtonFromAPI();
    } catch (e) {
      this._showStatus("Error borrando datos.", "error");
    }
  }

  // â”€â”€ Reentrenamiento â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async _triggerRetrain() {
    const btn = document.getElementById("btn-retrain");
    if (btn) {
      btn.disabled    = true;
      btn.textContent = "Entrenando...";
    }
    this._showStatus("Entrenando modelo... esto toma ~30-60 segundos.", "info");

    try {
      const resp = await fetch(`/api/train/retrain/${this.currentCountry}`, { method: "POST" });
      const data = await resp.json();
      this._showStatus(data.message, "info");

      if (data.success) {
        this._pollRetrainStatus();
      }
    } catch (e) {
      this._showStatus(`Error iniciando entrenamiento: ${e.message}`, "error");
      if (btn) {
        btn.disabled    = false;
        btn.textContent = "Reentrenar Modelo";
      }
    }
  }

  async _validateDatasetQuality() {
    const btn = document.getElementById("btn-validate-dataset");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Validando...";
    }
    try {
      const resp = await fetch(`/api/train/quality/${this.currentCountry}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail ?? "No se pudo validar.");

      const weak = (data.signs ?? []).filter(s => s.warnings?.length);
      const main = [
        `${data.total_frames} frames · ${data.signs.filter(s => s.count > 0).length}/${data.total_signs} señas con datos`,
        `${weak.length} señas con advertencias`,
      ].join(" · ");
      const examples = weak.slice(0, 5).map(s => `${s.sign_id}: ${s.warnings[0]}`).join(" | ");
      this._renderQualityPanel(data);
      this._openQualityModal();
      this._showStatus(examples ? `${main}. ${examples}` : `${main}. Dataset sin advertencias críticas.`, weak.length ? "warn" : "success");
    } catch (error) {
      this._showStatus(`Error validando dataset: ${error.message}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Validar dataset";
      }
    }
  }

  async _openQualityModal() {
    const modal = document.getElementById("quality-modal");
    if (!modal) return;
    const panel = document.getElementById("dataset-quality-panel");
    if (panel && panel.classList.contains("hidden")) {
      await this._refreshQualityPanelSilent();
    }
    modal.classList.remove("hidden");
  }

  _closeQualityModal() {
    document.getElementById("quality-modal")?.classList.add("hidden");
  }

  async _refreshQualityPanelSilent() {
    try {
      const resp = await fetch(`/api/train/quality/${this.currentCountry}`);
      if (!resp.ok) return;
      const data = await resp.json();
      this._renderQualityPanel(data);
    } catch (_) {}
  }

  _renderQualityPanel(data) {
    const panel = document.getElementById("dataset-quality-panel");
    if (!panel) return;

    const signs = data.signs ?? [];
    const priority = signs
      .filter(s => s.warnings?.length)
      .sort((a, b) => {
        const score = (s) =>
          (s.count === 0 ? 100 : 0) +
          (!s.ready_motion ? 60 : 0) +
          (!s.ready_body ? 50 : 0) +
          ((5 - Math.min(5, s.participants ?? 0)) * 8) +
          ((2 - Math.min(2, s.environments ?? 0)) * 5);
        return score(b) - score(a);
      })
      .slice(0, 6);

    const issueHtml = (data.issues ?? []).slice(0, 4)
      .map(issue => `<li>${issue}</li>`)
      .join("");
    const priorityHtml = priority.map(s => `
      <button class="quality-priority-item" type="button" data-quality-sign="${s.sign_id}">
        <strong>${s.sign_id}</strong>
        <span>${s.count} frames · ${s.participants}/5 personas · ${s.environments}/2 entornos</span>
        <small>${s.warnings?.[0] ?? "Revisar captura"}</small>
      </button>
    `).join("");

    panel.classList.remove("hidden");
    panel.innerHTML = `
      <div class="quality-panel-title">Prioridades de entrenamiento</div>
      <div class="quality-panel-summary">${data.total_frames} frames · ${data.ready_to_train ? "listo para entrenar estáticas" : "faltan datos base"}</div>
      ${issueHtml ? `<ul class="quality-issues">${issueHtml}</ul>` : ""}
      ${priorityHtml ? `<div class="quality-priority-list">${priorityHtml}</div>` : `<p class="quality-empty">Sin alertas críticas.</p>`}
    `;

    panel.querySelectorAll("[data-quality-sign]").forEach(btn => {
      btn.addEventListener("click", () => {
        this.selectSign(btn.dataset.qualitySign);
        document.querySelector(`[data-sign-id="${btn.dataset.qualitySign}"]`)?.scrollIntoView({ block: "center" });
      });
    });
  }

  _exportDataset() {
    window.location.href = `/api/train/export/${this.currentCountry}`;
  }

  async _importDataset(e) {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;

    const btn = document.getElementById("btn-import-dataset");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Importando...";
    }
    try {
      const resp = await fetch(`/api/train/import/${this.currentCountry}`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: file,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail ?? "No se pudo importar.");
      this._showStatus(data.message ?? "Dataset importado.", "success");
      await this._loadStatusForCountry();
      await this._validateDatasetQuality();
    } catch (error) {
      this._showStatus(`Error importando dataset: ${error.message}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Importar";
      }
      input.value = "";
    }
  }

  _pollRetrainStatus() {
    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`/api/train/retrain-status/${this.currentCountry}`);
        const data = await resp.json();
        const { status } = data;
        const btn = document.getElementById("btn-retrain");

        if (status === "done") {
          clearInterval(interval);
          this._showStatus("Modelo reentrenado. La practica ya usa el nuevo modelo.", "success");
          if (btn) { btn.textContent = "Reentrenado"; btn.disabled = false; }
          document.dispatchEvent(new CustomEvent("modelUpdated", {
            detail: { country: this.currentCountry },
          }));
        } else if (status?.startsWith("error:")) {
          clearInterval(interval);
          this._showStatus(`Error: ${status.replace("error:", "")}`, "error");
          if (btn) { btn.textContent = "Reintentar"; btn.disabled = false; }
        } else if (status === "running") {
          if (btn) btn.textContent = "Entrenando...";
        }
      } catch (e) {
        clearInterval(interval);
      }
    }, 3000);
  }

  // â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  _renderSignGrid() {
    const grid = document.getElementById("collect-signs-grid");
    if (!grid) return;

    const totalSamples = Object.values(this.sampleCounts).reduce((sum, count) => sum + count, 0);
    grid.innerHTML = "";

    const visibleSigns = this.allSigns.filter(sign => {
      const text = `${sign.sign_id} ${sign.name ?? ""}`.toLowerCase();
      const matchesSearch = !this.searchTerm || text.includes(this.searchTerm);
      const matchesCategory = window.signMatchesVocabularyCategory
        ? window.signMatchesVocabularyCategory({ id: sign.sign_id, category: sign.category }, this.categoryFilter)
        : (this.categoryFilter === "all" || sign.category === this.categoryFilter);
      return matchesSearch && matchesCategory;
    });

    visibleSigns.forEach(({ sign_id }) => {
      // â”€â”€ BUG FIX: usar sampleCounts (actualizado al guardar), no allSigns â”€â”€
      const count  = this.sampleCounts[sign_id] ?? 0;
      const enough = count >= FRAMES_PER_SIGN;
      const cfg    = this._getSignConfig(sign_id);
      const item = document.createElement("div");
      item.className  = "collect-sign-item";
      item.dataset.signId = sign_id;
      if (sign_id === this.currentSignId) item.classList.add("selected");

      // AÃ±adir clase especial para seÃ±as con guÃ­a
      if (cfg) item.classList.add(`sign-mode-${cfg.mode}`);

      const pct = Math.min(100, Math.round((count / FRAMES_PER_SIGN) * 100));

      // Indicador visual del tipo de seÃ±a
      const modeIcon = isMotionMode(cfg) ? "M"
                     : isOrientationMode(cfg) ? "<->"
                     : cfg?.mode === "static_special" ? "*" : "";

      const imgPath = window.getSignImagePath ? window.getSignImagePath(sign_id) : null;
      item.innerHTML = `
        <div class="collect-sign-photo-wrap">
          ${imgPath
            ? `<img src="${imgPath}" alt="${sign_id}" class="collect-sign-photo-img" />`
            : `<span class="collect-sign-letter-fallback">${sign_id}</span>`
          }
          <span class="collect-sign-overlay-letter">${sign_id}${modeIcon ? `<span style="font-size:0.5em;opacity:0.7">${modeIcon}</span>` : ""}</span>
        </div>
        <div class="collect-sign-bar">
          <div class="collect-sign-fill ${enough ? "full" : ""}" style="width:${pct}%"></div>
        </div>
        <div class="collect-sign-num ${enough ? "text-cyan" : "text-muted"}">${count}</div>
      `;
      item.addEventListener("click", () => this.selectSign(sign_id));
      grid.appendChild(item);
    });

    if (!visibleSigns.length) {
      grid.innerHTML = `<p class="text-muted" style="grid-column:1/-1; font-size:0.7rem; padding:0.75rem; text-align:center;">No hay señas con este filtro.</p>`;
    }

    // Actualizar total
    const readyCount = document.getElementById("signs-ready-count");
    if (readyCount) {
      const ready = this.allSigns.filter(s => (this.sampleCounts[s.sign_id] ?? 0) >= FRAMES_PER_SIGN).length;
      readyCount.textContent = `${ready}/${this.allSigns.length} listas · ${totalSamples} total`;
    }
  }

  _updateTrainButton(status) {
    const btn  = document.getElementById("btn-retrain");
    const info = document.getElementById("train-ready-info");
    if (!btn) return;

    const ready     = status.ready_to_train;
    const signsDone = status.signs_ready;
    const total     = status.total_signs;

    btn.disabled = !ready;
    if (info) {
      info.textContent = ready
        ? `${signsDone}/${total} senas listas - puedes reentrenar`
        : `${signsDone}/${total} senas con ${status.min_samples_needed}+ muestras`;
    }
  }

  _updateReadyCount(status) {
    const el = document.getElementById("signs-ready-count");
    if (!el) return;
    const total = Object.values(this.sampleCounts).reduce((a, b) => a + b, 0);
    el.textContent = `${status.signs_ready}/${status.total_signs} listas · ${total} total`;
  }

  async _updateTrainButtonFromAPI() {
    try {
      const resp = await fetch(`/api/train/status/${this.currentCountry}`);
      const status = await resp.json();
      this._updateTrainButton(status);
      this._updateReadyCount(status);
    } catch (e) {}
  }

  // â”€â”€ Dibujo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  _drawFrame(landmarks, landmarksSecondary = null, totalHands = 1) {
    if (!this.canvasEl) return;
    Overlay.clearCanvas(this.canvasEl);
    Overlay.drawUserHand(this.canvasEl, landmarks, 0.8);
    if (landmarksSecondary && Overlay.drawUserHandSecondary) {
      Overlay.drawUserHandSecondary(this.canvasEl, landmarksSecondary);
    }

    const cfg = this._getSignConfig(this.currentSignId);

    // Dibujar guÃ­a de orientaciÃ³n para G/H (flecha horizontal)
    if (isOrientationMode(cfg)) {
      Overlay.drawOrientationGuide(this.canvasEl, cfg.color);
    }

    // Dibujar trail de movimiento para J/Z durante grabaciÃ³n
    if (this.isRecording && isMotionMode(cfg) && this._motionTrail.length >= 2) {
      Overlay.drawMotionTrail(this.canvasEl, this._motionTrail, cfg.color);

      // Badge de repeticiones completadas
      if (this._repCount > 0) {
        Overlay.drawRepBadge(this.canvasEl, this._repCount, cfg.color);
      }
    }

    if (this.isRecording && totalHands < 2 && this.currentSignId) {
      const sign = this.allSigns.find(s => s.sign_id === this.currentSignId);
      if (sign?.two_handed) {
        const ctx = this.canvasEl.getContext("2d");
        ctx.save();
        ctx.fillStyle = "rgba(255, 190, 70, 0.95)";
        ctx.font = "bold 12px monospace";
        ctx.textAlign = "center";
        ctx.fillText("Falta la segunda mano", this.canvasEl.width / 2, 28);
        ctx.restore();
      }
    }

    this._drawFpsOverlay();
  }

  _drawFpsOverlay() {
    if (!this.canvasEl || !this._currentFps) return;
    const ctx = this.canvasEl.getContext("2d");
    const W   = this.canvasEl.width;
    ctx.save();
    ctx.font      = "bold 12px monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = this._currentFps >= 25 ? "rgba(0,245,200,0.8)"
                  : this._currentFps >= 15 ? "rgba(255,200,50,0.8)"
                  : "rgba(255,80,80,0.8)";
    ctx.fillText(`${this._currentFps} FPS`, W - 6, 18);
    ctx.restore();
  }

  _drawRecordingProgress(current, total) {
    if (!this.canvasEl) return;
    const ctx  = this.canvasEl.getContext("2d");
    const W    = this.canvasEl.width;
    const H    = this.canvasEl.height;
    const pct  = current / total;
    const barH = 6;
    const barY = H - barH - 8;

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(8, barY, W - 16, barH);
    ctx.fillStyle = pct > 0.7 ? "rgba(0,245,200,0.9)" : "rgba(124,58,237,0.9)";
    ctx.fillRect(8, barY, (W - 16) * pct, barH);

    ctx.fillStyle = "#e0e0ff";
    ctx.font      = "bold 14px Inter, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${current} / ${total}`, W - 10, barY - 6);

    // FPS
    ctx.font      = "bold 12px monospace";
    ctx.fillStyle = this._currentFps >= 25 ? "rgba(0,245,200,0.8)"
                  : this._currentFps >= 15 ? "rgba(255,200,50,0.8)"
                  : "rgba(255,80,80,0.8)";
    ctx.fillText(`${this._currentFps} FPS`, W - 6, 18);
    ctx.restore();
  }

  _showStatus(msg, type) {
    const el = document.getElementById("collect-status");
    if (!el) return;
    el.textContent   = msg;
    el.className     = `collect-status collect-status-${type}`;
    el.style.display = msg ? "block" : "none";
  }

  stop() {
    this.isRecording    = false;
    this.capturedFrames = [];
    this._motionTrail   = [];
    if (this.mp) this.mp.stopCamera();
    this.cameraActive = false;
  }
}

window.CollectMode = CollectMode;


