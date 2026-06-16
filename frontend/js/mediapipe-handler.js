/**
 * mediapipe-handler.js — Gestiona la detección de manos Y cuerpo en tiempo real.
 *
 * Detecta hasta 2 manos con HandLandmarker y 33 puntos de cuerpo con PoseLandmarker.
 * Envía screen landmarks (overlay) Y world landmarks 3D (clasificación v6) Y pose.
 *
 * Eventos CustomEvent emitidos en document:
 *   'handsUpdate'    → { right, left, total_hands, pose }
 *                      Cada mano: { landmarks, worldLandmarks, handedness }
 *                      pose: array de 33 puntos {x,y,z,visibility} (o null)
 *   'noHand'         → sin detalle
 *   'cameraReady'    → sin detalle
 *   'cameraError'    → { detail: mensaje }
 *   'mediapipeError' → { detail: mensaje }
 *   'fpsUpdate'      → { fps: number } — cada 1 segundo
 */

const MEDIAPIPE_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const WASM_PATH     = `${MEDIAPIPE_CDN}/wasm`;
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

class MediaPipeHandler {
  /**
   * @param {object} opts
   * @param {number}  opts.numHands    — 1 o 2 manos (default 2)
   * @param {boolean} opts.captureMode — true = resolución baja + FPS counter
   * @param {boolean} opts.enablePose  — true = cargar PoseLandmarker (default true)
   */
  constructor({ numHands = 2, captureMode = false, enablePose = true } = {}) {
    this.numHands    = numHands;
    this.captureMode = captureMode;
    this.enablePose  = enablePose;

    this.handLandmarker = null;
    this.poseLandmarker = null;
    this.isRunning      = false;
    this.lastVideoTime  = -1;
    this.videoElement   = null;
    this.animationId    = null;

    this._fpsFrames     = 0;
    this._fpsLastTime   = 0;
    this._currentFps    = 0;
    this._lastPose      = null;
    this._poseCounter   = 0;     // throttle: pose cada N frames
    this.POSE_EVERY_N   = 3;     // corre pose cada 3 frames (balanceo CPU)
  }

  async init() {
    // ── Cargar HandLandmarker ─────────────────────────────────────────────────
    let handOk = false;
    for (const delegate of ["GPU", "CPU"]) {
      try {
        const { HandLandmarker, FilesetResolver } =
          await import(`${MEDIAPIPE_CDN}/vision_bundle.mjs`);

        const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

        this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: HAND_MODEL_URL,
            delegate,
          },
          runningMode: "VIDEO",
          numHands: this.numHands,
          minHandDetectionConfidence: this.captureMode ? 0.50 : 0.60,
          minHandPresenceConfidence:  this.captureMode ? 0.50 : 0.60,
          minTrackingConfidence:      this.captureMode ? 0.50 : 0.55,
        });

        console.log(
          `[MediaPipe] ✓ HandLandmarker listo (${delegate}, ${this.numHands} manos` +
          (this.captureMode ? ", modo captura)" : ")")
        );
        handOk = true;
        break;
      } catch (err) {
        console.warn(`[MediaPipe] HandLandmarker falló con ${delegate}:`, err?.message ?? err);
        this.handLandmarker = null;
        if (delegate === "CPU") {
          const msg = err?.message ?? "Error desconocido al cargar MediaPipe";
          console.error("[MediaPipe] Error inicializando HandLandmarker:", msg);
          document.dispatchEvent(new CustomEvent("mediapipeError", { detail: msg }));
          return false;
        }
      }
    }

    // ── Cargar PoseLandmarker (opcional, no bloquea si falla) ─────────────────
    if (this.enablePose && handOk) {
      try {
        const { PoseLandmarker, FilesetResolver } =
          await import(`${MEDIAPIPE_CDN}/vision_bundle.mjs`);

        const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

        this.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: POSE_MODEL_URL,
            delegate: "CPU",            // lite model + CPU evita conflictos de contexto GPU
          },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence:  0.5,
          minTrackingConfidence:      0.5,
          outputSegmentationMasks:    false,
        });

        console.log("[MediaPipe] ✓ PoseLandmarker listo (cuerpo + manos activos)");
      } catch (err) {
        console.warn("[MediaPipe] PoseLandmarker no disponible (no crítico):", err?.message ?? err);
        this.poseLandmarker = null;
      }
    }

    return handOk;
  }

  async startCamera(videoEl) {
    this.videoElement = videoEl;

    const videoConstraints = this.captureMode
      ? { width: { ideal: 640 },  height: { ideal: 480 },  facingMode: "user" }
      : { width: { ideal: 1280 }, height: { ideal: 720 },  facingMode: "user" };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
      videoEl.srcObject = stream;
      videoEl.setAttribute("playsinline", true);

      await new Promise((resolve, reject) => {
        videoEl.onloadeddata = resolve;
        videoEl.onerror      = reject;
        videoEl.play();
      });

      this.isRunning    = true;
      this._fpsLastTime = performance.now();
      this._fpsFrames   = 0;
      this._detectLoop();

      document.dispatchEvent(new CustomEvent("cameraReady"));
      console.log("[MediaPipe] ✓ Cámara iniciada" +
        (this.captureMode ? " (640×480, modo captura)" : " (1280×720)"));
      return true;
    } catch (err) {
      console.error("[MediaPipe] Error de cámara:", err);
      document.dispatchEvent(new CustomEvent("cameraError", { detail: err.message }));
      return false;
    }
  }

  stopCamera() {
    this.isRunning = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.videoElement?.srcObject) {
      this.videoElement.srcObject.getTracks().forEach(t => t.stop());
      this.videoElement.srcObject = null;
    }
  }

  _detectLoop() {
    if (!this.isRunning || !this.handLandmarker) return;

    const video = this.videoElement;
    if (video.readyState >= 2 && video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = video.currentTime;

      try {
        const now    = performance.now();
        const result = this.handLandmarker.detectForVideo(video, now);
        const count  = result.landmarks?.length ?? 0;

        // ── PoseLandmarker — throttleado: corre cada POSE_EVERY_N frames ─────
        this._poseCounter++;
        if (this.poseLandmarker && this._poseCounter >= this.POSE_EVERY_N) {
          this._poseCounter = 0;
          try {
            const poseResult = this.poseLandmarker.detectForVideo(video, now);
            if (poseResult.landmarks?.length > 0) {
              this._lastPose = poseResult.landmarks[0];  // 33 puntos
            } else {
              this._lastPose = null;
            }
          } catch (_) { }
        }

        // ── FPS tracking ─────────────────────────────────────────────────────
        this._fpsFrames++;
        if (now - this._fpsLastTime >= 1000) {
          this._currentFps = Math.round(
            this._fpsFrames * 1000 / (now - this._fpsLastTime)
          );
          document.dispatchEvent(new CustomEvent("fpsUpdate", {
            detail: { fps: this._currentFps },
          }));
          this._fpsFrames   = 0;
          this._fpsLastTime = now;
        }

        if (count > 0) {
          let rightHand = null;
          let leftHand  = null;

          for (let i = 0; i < count; i++) {
            const handedness = result.handedness?.[i]?.[0]?.categoryName ?? "Unknown";

            const handData = {
              landmarks:      result.landmarks[i],
              worldLandmarks: result.worldLandmarks?.[i] ?? null,
              handedness,
              hand_index:  i,
              total_hands: count,
            };

            // MediaPipe "Left" → mano derecha del usuario (imagen espejo)
            if (handedness === "Left") {
              rightHand = handData;
            } else if (handedness === "Right") {
              leftHand = handData;
            } else {
              if (!rightHand) rightHand = handData;
              else if (!leftHand) leftHand = handData;
            }

            document.dispatchEvent(new CustomEvent("handDetected", { detail: handData }));
          }

          document.dispatchEvent(new CustomEvent("handsUpdate", {
            detail: {
              right: rightHand,
              left:  leftHand,
              total_hands: count,
              pose: this._lastPose,   // 33 puntos o null
            },
          }));
        } else {
          document.dispatchEvent(new CustomEvent("noHand"));
        }
      } catch (_) {
        // Frame saltado — no es error fatal
      }
    }

    this.animationId = requestAnimationFrame(() => this._detectLoop());
  }

  getFps()   { return this._currentFps; }
  isReady()  { return this.handLandmarker !== null; }
  hasPose()  { return this.poseLandmarker !== null; }
}

window.MediaPipeHandler = MediaPipeHandler;
