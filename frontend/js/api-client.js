/**
 * api-client.js — Cliente HTTP/WebSocket para la API Python de SignLingo.
 *
 * Soporte completo:
 *   - Dos manos (landmarks_right + landmarks_left)
 *   - World landmarks 3D (para features v6 rotation-invariant)
 *   - WsPredictor con worldLandmarks en protocolo v4
 */

const API_BASE = "/api";

async function apiFetch(path, options = {}) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json", ...options.headers },
      ...options,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    console.error(`[API] ${path} failed:`, e.message);
    return null;
  }
}

const ApiClient = {
  async health() {
    return apiFetch("/health");
  },

  async getSigns(country = "lsc", category = null) {
    const q = new URLSearchParams({ country });
    if (category) q.set("category", category);
    return apiFetch(`/signs?${q}`);
  },

  async getAllSigns() {
    return apiFetch("/signs/all");
  },

  async getSign(country, signId) {
    return apiFetch(`/signs/${country}/${signId}`);
  },

  async getTemplates(country = "lsc") {
    return apiFetch(`/signs/${country}/templates/all`);
  },

  /**
   * Predice la seña con soporte de una o dos manos + world landmarks.
   *
   * @param {Array}       landmarks              - Mano dominante (legacy)
   * @param {string}      country
   * @param {string|null} targetSignId
   * @param {Array|null}  landmarksRight         - Screen landmarks mano derecha
   * @param {Array|null}  landmarksLeft          - Screen landmarks mano izquierda
   * @param {Array|null}  worldLandmarksRight    - World landmarks 3D mano derecha
   * @param {Array|null}  worldLandmarksLeft     - World landmarks 3D mano izquierda
   * @param {Array|null}  poseLandmarks          - 33 landmarks de cuerpo
   */
  async predict(
    landmarks, country = "lsc", targetSignId = null,
    landmarksRight = null, landmarksLeft = null,
    worldLandmarksRight = null, worldLandmarksLeft = null,
    poseLandmarks = null,
  ) {
    const body = { landmarks, country, target_sign_id: targetSignId };
    if (landmarksRight)      body.landmarks_right       = landmarksRight;
    if (landmarksLeft)       body.landmarks_left        = landmarksLeft;
    if (worldLandmarksRight) body.world_landmarks_right = worldLandmarksRight;
    if (worldLandmarksLeft)  body.world_landmarks_left  = worldLandmarksLeft;
    if (poseLandmarks)       body.pose_landmarks        = poseLandmarks;

    return apiFetch("/predict", { method: "POST", body: JSON.stringify(body) });
  },

  async saveProgress(signId, country, success, responseTimeMs = null) {
    return apiFetch("/progress", {
      method: "POST",
      body: JSON.stringify({
        sign_id: signId, country, success, response_time_ms: responseTimeMs,
      }),
    });
  },

  async getProgress() {
    return apiFetch("/progress/summary");
  },

  async collectSamples(signId, country, samples) {
    return apiFetch("/train/collect", {
      method: "POST",
      body: JSON.stringify({ sign_id: signId, country, samples }),
    });
  },
};

class WsPredictor {
  constructor(country = "asl") {
    this.country = country;
    this.ws = null;
    this.onResult = null;
    this.onError  = null;
    this._reconnectDelay = 1000;
    this._destroyed = false;
    this._reconnectTimer = null;
  }

  connect() {
    if (this._destroyed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url   = `${proto}://${location.host}/api/ws/predict`;
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.warn("[WS] No se pudo crear conexión:", e.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log("[WS] Conectado al stream de predicción");
      this._reconnectDelay = 1000;
      // Heartbeat cada 20s para mantener la conexión viva a través del proxy
      this._heartbeatTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 20000);
    };

    this.ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (this.onResult) this.onResult(data);
      } catch (_) {}
    };

    this.ws.onerror = () => {
      console.warn("[WS] Error de conexión, reconectando…");
    };

    this.ws.onclose = () => {
      clearInterval(this._heartbeatTimer);
      if (!this._destroyed) {
        console.log(`[WS] Desconectado. Reconectando en ${this._reconnectDelay}ms…`);
        this._scheduleReconnect();
      }
    };
  }

  _scheduleReconnect() {
    if (this._destroyed) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 8000);
      this.connect();
    }, this._reconnectDelay);
  }

  /**
   * Envía landmarks para predicción en tiempo real.
   * Incluye world landmarks 3D para features v6 rotation-invariant.
   *
   * @param {Array}       landmarks           - Mano dominante (legacy)
   * @param {string|null} targetSignId
   * @param {Array|null}  landmarksRight      - Screen landmarks derecha
   * @param {Array|null}  landmarksLeft       - Screen landmarks izquierda
   * @param {Array|null}  worldLandmarksRight - World landmarks 3D derecha
   * @param {Array|null}  worldLandmarksLeft  - World landmarks 3D izquierda
   * @param {Array|null}  poseLandmarks       - 33 landmarks de cuerpo (PoseLandmarker)
   */
  send(
    landmarks, targetSignId = null,
    landmarksRight = null, landmarksLeft = null,
    worldLandmarksRight = null, worldLandmarksLeft = null,
    poseLandmarks = null,
  ) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    const payload = {
      landmarks,
      country:        this.country,
      target_sign_id: targetSignId,
    };
    if (landmarksRight)      payload.landmarks_right       = landmarksRight;
    if (landmarksLeft)       payload.landmarks_left        = landmarksLeft;
    if (worldLandmarksRight) payload.world_landmarks_right = worldLandmarksRight;
    if (worldLandmarksLeft)  payload.world_landmarks_left  = worldLandmarksLeft;
    if (poseLandmarks)       payload.pose_landmarks        = poseLandmarks;

    this.ws.send(JSON.stringify(payload));
    return true;
  }

  disconnect() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._heartbeatTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

window.ApiClient   = ApiClient;
window.WsPredictor = WsPredictor;
