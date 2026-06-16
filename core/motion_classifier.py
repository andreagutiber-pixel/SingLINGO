"""
motion_classifier.py — Clasificador de señas que requieren movimiento (J, Z, S, Ñ).

Sistema de dos fases:
  Fase 1 "position" — el usuario fija la postura base (dedos correctos).
                      Se requiere POSITION_HOLD_FRAMES frames estables.
  Fase 2 "motion"   — una vez bloqueada la posición, se detecta el trazo.

Señas soportadas:
  J — Meñique traza una J (base: meñique arriba)
  Z — Índice traza una Z (base: índice arriba)
  S — Puño cerrado con sacudida lateral (base: puño cerrado)
  Ñ — N con movimiento ondulante (base: índice+medio arriba)
  G — Pulgar+índice horizontales (base: pulgar+índice arriba) — se detecta estáticamente
  H — Índice+medio horizontales (base: índice+medio arriba) — se detecta estáticamente

Uso típico:
  clf = TwoPhaseMotionClassifier()
  phase, phase_progress = clf.push_frame(landmarks, fingers_up, target_sign_id)
  sign_id, conf = clf.detect(fingers_up)
"""
from __future__ import annotations

import numpy as np
from collections import deque
from typing import Optional, Tuple, List

MOTION_WINDOW     = 28   # frames a analizar (~0.9s a 30 FPS)
MIN_MOTION_FRAMES = 14   # mínimo de frames antes de detectar

POSITION_HOLD_FRAMES = 10  # frames estables necesarios para confirmar posición (~0.33s)

PINKY_TIP  = 20
INDEX_TIP  = 8
MIDDLE_TIP = 12
WRIST_IDX  = 0

MOTION_THRESHOLD = 0.52  # confianza mínima para reportar seña de movimiento


class MotionBuffer:
    """Buffer circular de landmarks para análisis temporal de movimiento."""

    def __init__(self, window: int = MOTION_WINDOW):
        self.window = window
        self._frames: deque = deque(maxlen=window)

    def push(self, landmarks: list):
        if landmarks and len(landmarks) == 21:
            self._frames.append(landmarks)

    def tip_trajectory(self, tip_idx: int) -> Optional[np.ndarray]:
        """Retorna array (N, 2) con posiciones XY del tip especificado."""
        if len(self._frames) < MIN_MOTION_FRAMES:
            return None
        return np.array(
            [[frame[tip_idx]["x"], frame[tip_idx]["y"]] for frame in self._frames],
            dtype=np.float64,
        )

    def clear(self):
        self._frames.clear()

    def __len__(self):
        return len(self._frames)


def _smooth(traj: np.ndarray, k: int = 3) -> np.ndarray:
    """Media móvil para reducir ruido de cámara."""
    if len(traj) < k:
        return traj
    out = np.zeros_like(traj)
    half = k // 2
    for i in range(len(traj)):
        lo = max(0, i - half)
        hi = min(len(traj), i + half + 1)
        out[i] = traj[lo:hi].mean(axis=0)
    return out


def _path_length(traj: np.ndarray) -> float:
    return float(np.sum(np.linalg.norm(np.diff(traj, axis=0), axis=1)))


def _detect_J(traj: np.ndarray, fingers: List[bool]) -> float:
    """
    Detecta la letra J LSC.

    Forma: meñique extendido (como I), traza un arco hacia abajo y luego
    gira hacia afuera (gancho inferior). En imagen de vídeo:
      - Y aumenta hacia abajo
      - Movimiento principal: hacia abajo y ligeramente lateral al final

    Returns:
        float [0, 1] — confianza de la detección
    """
    if fingers and len(fingers) == 5:
        # Solo el meñique debe estar extendido
        if not fingers[4] or any(fingers[:4]):
            return 0.0

    traj = _smooth(traj, k=3)
    n = len(traj)
    if n < MIN_MOTION_FRAMES:
        return 0.0

    if _path_length(traj) < 0.07:
        return 0.0

    rel = traj - traj[0]

    # Desplazamiento vertical total (positivo = hacia abajo en imagen)
    dy_total = rel[-1, 1] - rel[0, 1]

    # Dividir en primera mitad (bajada) y segunda mitad (gancho)
    mid = n * 2 // 3
    second = rel[mid:]

    # 1. Movimiento descendente dominante
    vert_score = float(np.clip(dy_total / 0.12, 0.0, 1.0)) if dy_total > 0 else 0.0

    # 2. Gancho: la última parte tiene componente lateral (X) notable
    dx_late = abs(second[-1, 0] - second[0, 0]) if len(second) > 1 else 0.0
    hook_score = float(np.clip(dx_late / 0.07, 0.0, 1.0))

    # 3. La trayectoria tiene curvatura (no es línea recta)
    # — medida como desviación de la línea directa
    direct = rel[-1] - rel[0]
    if np.linalg.norm(direct) > 1e-6:
        unit = direct / np.linalg.norm(direct)
        deviations = np.abs(np.cross(rel, unit))
        curve_score = float(np.clip(deviations.max() / 0.06, 0.0, 1.0))
    else:
        curve_score = 0.0

    confidence = vert_score * 0.50 + hook_score * 0.30 + curve_score * 0.20
    return float(np.clip(confidence, 0.0, 1.0))


def _detect_Z(traj: np.ndarray, fingers: List[bool]) -> float:
    """
    Detecta la letra Z LSC.

    Forma: índice extendido traza una Z — tres trazos:
      1. Diagonal o horizontal hacia un lado
      2. Diagonal cruzada (opuesta)
      3. Horizontal opuesta al primer trazo

    Se detecta como: al menos 2 reversals en la velocidad horizontal
    con desplazamiento significativo.

    Returns:
        float [0, 1] — confianza de la detección
    """
    if fingers and len(fingers) == 5:
        # Solo índice extendido (puede haber pulgar)
        if not fingers[1] or any(fingers[2:]):
            return 0.0

    traj = _smooth(traj, k=3)
    n = len(traj)
    if n < MIN_MOTION_FRAMES:
        return 0.0

    if _path_length(traj) < 0.10:
        return 0.0

    rel = traj - traj[0]

    # Velocidad en X a lo largo de la trayectoria
    vx = np.diff(rel[:, 0])

    # Contar reversals de dirección en X (cambios de signo en vx)
    # Usar threshold para ignorar ruido pequeño
    threshold = 0.004
    sign_changes = 0
    prev_sign = None
    i = 0
    while i < len(vx):
        if abs(vx[i]) > threshold:
            cur_sign = 1 if vx[i] > 0 else -1
            if prev_sign is not None and cur_sign != prev_sign:
                sign_changes += 1
                i += 4  # saltar para evitar contar ruido local
            prev_sign = cur_sign
        i += 1

    reversal_score = float(np.clip(sign_changes / 2.0, 0.0, 1.0))

    # Amplitud horizontal total (la Z requiere movimiento lateral amplio)
    x_range = rel[:, 0].max() - rel[:, 0].min()
    amplitude_score = float(np.clip(x_range / 0.15, 0.0, 1.0))

    # La Z también baja verticalmente
    dy = rel[-1, 1] - rel[0, 1]
    descent_score = float(np.clip(dy / 0.10, 0.0, 1.0)) if dy > 0 else 0.3

    confidence = reversal_score * 0.55 + amplitude_score * 0.30 + descent_score * 0.15
    return float(np.clip(confidence, 0.0, 1.0))


def _detect_S(traj: np.ndarray, fingers: List[bool]) -> float:
    """
    Detecta la letra S en LSC.

    Forma: puño cerrado (pulgar sobre dedos) + sacudida lateral rápida
    en el eje X (oscilación rápida de múltiples reversals).

    Returns:
        float [0, 1] — confianza de la detección
    """
    if fingers and len(fingers) == 5:
        # Todos los dedos deben estar cerrados (puño cerrado)
        if any(fingers[1:]):  # índice, medio, anular, meñique deben estar cerrados
            return 0.0

    traj = _smooth(traj, k=2)   # menos suavizado para capturar vibración rápida
    n = len(traj)
    if n < MIN_MOTION_FRAMES:
        return 0.0

    if _path_length(traj) < 0.04:
        return 0.0

    rel = traj - traj[0]

    # Amplitude horizontal (la sacudida debe ser pequeña, no amplia como Z)
    x_range = rel[:, 0].max() - rel[:, 0].min()
    if x_range > 0.22:
        return 0.0   # demasiado amplio → se parece más a Z

    amplitude_score = float(np.clip(x_range / 0.09, 0.0, 1.0))

    # Contar reversals rápidos en X (sacudida = muchas inversiones en poco tiempo)
    vx = np.diff(rel[:, 0])
    threshold = 0.002
    sign_changes = 0
    prev_sign = None
    i = 0
    while i < len(vx):
        if abs(vx[i]) > threshold:
            cur_sign = 1 if vx[i] > 0 else -1
            if prev_sign is not None and cur_sign != prev_sign:
                sign_changes += 1
                i += 2   # saltar menos que Z (sacudida es más rápida)
            prev_sign = cur_sign
        i += 1

    # S necesita al menos 3 reversals
    reversal_score = float(np.clip((sign_changes - 1) / 3.0, 0.0, 1.0))

    # Estabilidad vertical: la sacudida no debe bajar mucho
    dy = abs(rel[-1, 1] - rel[0, 1])
    vertical_stability = float(np.clip(1.0 - dy / 0.09, 0.0, 1.0))

    confidence = reversal_score * 0.50 + amplitude_score * 0.30 + vertical_stability * 0.20
    return float(np.clip(confidence, 0.0, 1.0))


def _detect_N(traj: np.ndarray, fingers: List[bool]) -> float:
    """
    Detecta la letra Ñ en LSC.

    Forma: configuración N (índice + medio extendidos) + movimiento ondulante
    tipo tilde (~): arco suave lateral con una ligera curvatura vertical.

    Returns:
        float [0, 1] — confianza de la detección
    """
    if fingers and len(fingers) == 5:
        # Índice y medio extendidos (base de N/Ñ)
        if not fingers[1] or not fingers[2]:
            return 0.0
        # Anular y meñique cerrados
        if fingers[3] or fingers[4]:
            return 0.0

    traj = _smooth(traj, k=3)
    n = len(traj)
    if n < MIN_MOTION_FRAMES:
        return 0.0

    if _path_length(traj) < 0.08:
        return 0.0

    rel = traj - traj[0]

    # Desplazamiento horizontal significativo (la tilde va de un lado a otro)
    x_range = rel[:, 0].max() - rel[:, 0].min()
    amplitude_score = float(np.clip(x_range / 0.12, 0.0, 1.0))

    # Curvatura tipo tilde: el punto medio tiene desvío vertical respecto a los extremos
    mid = n // 2
    y_mid   = rel[mid, 1]
    y_start = rel[0,   1]
    y_end   = rel[-1,  1]
    y_deviation = abs(y_mid - (y_start + y_end) / 2.0)
    curve_score = float(np.clip(y_deviation / 0.04, 0.0, 1.0))

    # Máximo 1 reversal en X (arco suave, no zigzag)
    vx = np.diff(rel[:, 0])
    threshold = 0.003
    sign_changes = 0
    prev_sign = None
    i = 0
    while i < len(vx):
        if abs(vx[i]) > threshold:
            cur_sign = 1 if vx[i] > 0 else -1
            if prev_sign is not None and cur_sign != prev_sign:
                sign_changes += 1
                i += 3
            prev_sign = cur_sign
        i += 1

    smoothness_score = float(np.clip(1.0 - sign_changes / 2.0, 0.0, 1.0))

    confidence = amplitude_score * 0.40 + curve_score * 0.35 + smoothness_score * 0.25
    return float(np.clip(confidence, 0.0, 1.0))


class MotionClassifier:
    """
    Detecta señas dinámicas (J, Z, S, Ñ) analizando trayectorias de landmarks.

    Se usa como complemento al clasificador MLP: cuando el MLP detecta
    la posición estática base, el MotionClassifier verifica si hay movimiento
    que confirme la seña dinámica.
    """

    def __init__(self, window: int = MOTION_WINDOW):
        self.buffer = MotionBuffer(window)
        self._last_detected: Optional[str] = None
        self._cooldown = 0     # frames de cooldown tras detectar

    def push_frame(self, landmarks: list):
        """Añade landmarks de un frame al buffer."""
        self.buffer.push(landmarks)
        if self._cooldown > 0:
            self._cooldown -= 1

    def detect(self, fingers_up: List[bool]) -> Tuple[Optional[str], float]:
        """
        Intenta detectar una seña de movimiento.

        Args:
            fingers_up: [thumb, index, middle, ring, pinky] — dedos extendidos

        Returns:
            (sign_id, confidence) — sign_id es None si no se detecta nada
        """
        if len(self.buffer) < MIN_MOTION_FRAMES or self._cooldown > 0:
            return None, 0.0

        candidates = []

        # Intentar J (meñique traza J)
        traj_pinky = self.buffer.tip_trajectory(PINKY_TIP)
        if traj_pinky is not None:
            j_conf = _detect_J(traj_pinky, fingers_up)
            if j_conf > 0.0:
                candidates.append(("J", j_conf))

        # Intentar Z (índice traza Z)
        traj_index = self.buffer.tip_trajectory(INDEX_TIP)
        if traj_index is not None:
            z_conf = _detect_Z(traj_index, fingers_up)
            if z_conf > 0.0:
                candidates.append(("Z", z_conf))

        # Intentar S (puño con sacudida lateral — rastrear muñeca)
        traj_wrist = self.buffer.tip_trajectory(WRIST_IDX)
        if traj_wrist is not None:
            s_conf = _detect_S(traj_wrist, fingers_up)
            if s_conf > 0.0:
                candidates.append(("S", s_conf))

        # Intentar Ñ (N con movimiento tilde — rastrear dedo medio)
        traj_middle = self.buffer.tip_trajectory(MIDDLE_TIP)
        if traj_middle is not None:
            n_conf = _detect_N(traj_middle, fingers_up)
            if n_conf > 0.0:
                candidates.append(("Ñ", n_conf))

        if not candidates:
            return None, 0.0

        best_sign, best_conf = max(candidates, key=lambda x: x[1])

        if best_conf >= MOTION_THRESHOLD:
            self._last_detected = best_sign
            self._cooldown = 8  # evitar detecciones repetidas en ráfaga
            return best_sign, best_conf

        return None, 0.0

    def get_trail_points(self, tip_idx: int = PINKY_TIP) -> list:
        """
        Retorna los últimos puntos del trail para visualización.

        Returns:
            Lista de dicts {x, y} normalizados (últimos 15 frames)
        """
        frames = list(self.buffer._frames)[-15:]
        return [{"x": frame[tip_idx]["x"], "y": frame[tip_idx]["y"]}
                for frame in frames]

    def reset(self):
        self.buffer.clear()
        self._last_detected = None
        self._cooldown = 0


# ── Finger-state base para cada seña dinámica ─────────────────────────────────
# [thumb, index, middle, ring, pinky]
DYNAMIC_SIGN_BASE_FINGERS: dict = {
    "J":  [False, False, False, False, True],   # meñique arriba
    "Z":  [False, True,  False, False, False],  # índice arriba
    "S":  [False, False, False, False, False],  # puño cerrado
    "Ñ":  [False, True,  True,  False, False],  # índice+medio arriba
    "G":  [True,  True,  False, False, False],  # pulgar+índice arriba
    "H":  [False, True,  True,  False, False],  # índice+medio arriba
}

DYNAMIC_SIGN_BASE_FINGERS["Ã‘"] = DYNAMIC_SIGN_BASE_FINGERS["Ñ"]
DYNAMIC_SIGN_BASE_FINGERS["Ãƒâ€˜"] = DYNAMIC_SIGN_BASE_FINGERS["Ñ"]

# Señas que el sistema de dos fases maneja
DYNAMIC_SIGNS = set(DYNAMIC_SIGN_BASE_FINGERS.keys())


def _fingers_match_base(fingers_up: List[bool], target_sign: str) -> bool:
    """Verifica si los dedos actuales coinciden con la posición base de la seña."""
    base = DYNAMIC_SIGN_BASE_FINGERS.get(target_sign)
    if not base or len(fingers_up) != 5:
        return False
    return all(fingers_up[i] == base[i] for i in range(5))


class TwoPhaseMotionClassifier:
    """
    Clasificador de dos fases para señas dinámicas.

    Fase 1 "position": espera que el usuario fije la postura base correcta
                       durante POSITION_HOLD_FRAMES frames consecutivos.
    Fase 2 "motion":   una vez confirmada la posición, activa la detección
                       del trazo dinámico (J, Z, S, Ñ).

    Las señas G y H se consideran semi-dinámicas: la dirección de los dedos
    (horizontal) se valida en fase 2 con heurísticas de orientación.
    """

    def __init__(self, window: int = MOTION_WINDOW):
        self._motion_clf = MotionClassifier(window)
        self._phase = "position"        # "position" | "motion"
        self._hold_count = 0            # frames consecutivos con postura correcta
        self._current_target: Optional[str] = None

    @property
    def phase(self) -> str:
        return self._phase

    @property
    def hold_progress(self) -> float:
        """Progreso de la fase posición: 0.0 → 1.0"""
        return min(1.0, self._hold_count / POSITION_HOLD_FRAMES)

    def set_target(self, sign_id: Optional[str]):
        """Llamar cuando cambia la seña objetivo."""
        if sign_id != self._current_target:
            self._current_target = sign_id
            self.reset()

    def push_frame(self, landmarks: list, fingers_up: List[bool]) -> Tuple[str, float]:
        """
        Procesa un frame.

        Returns:
            (phase, hold_progress) — fase actual y progreso del hold
        """
        if self._current_target not in DYNAMIC_SIGNS:
            # Seña estática normal — no aplica dos fases
            self._motion_clf.push_frame(landmarks)
            return "static", 1.0

        if self._phase == "position":
            if _fingers_match_base(fingers_up, self._current_target):
                self._hold_count += 1
                if self._hold_count >= POSITION_HOLD_FRAMES:
                    self._phase = "motion"
                    self._motion_clf.buffer.clear()  # limpiar buffer al entrar en movimiento
            else:
                # Resetear contador si pierde la postura
                self._hold_count = max(0, self._hold_count - 2)
        else:
            # Fase motion: siempre acumular landmarks
            self._motion_clf.push_frame(landmarks)
            # Si pierde completamente la postura base durante >8 frames → volver a fase position
            if not _fingers_match_base(fingers_up, self._current_target):
                self._hold_count -= 1
                if self._hold_count <= -8:
                    self._phase = "position"
                    self._hold_count = 0
                    self._motion_clf.reset()

        return self._phase, self.hold_progress

    def detect(self, fingers_up: List[bool]) -> Tuple[Optional[str], float]:
        """Detecta seña dinámica (solo en fase motion)."""
        if self._phase != "motion":
            return None, 0.0
        if self._current_target in ("G", "H"):
            if not _fingers_match_base(fingers_up, self._current_target):
                return None, 0.0
            tip_idx = INDEX_TIP if self._current_target == "G" else MIDDLE_TIP
            traj = self._motion_clf.buffer.tip_trajectory(tip_idx)
            if traj is None:
                return None, 0.0
            movement = _path_length(_smooth(traj, k=3))
            if movement < 0.045:
                return None, 0.0
            confidence = float(np.clip(movement / 0.12, 0.55, 0.90))
            return self._current_target, confidence
        return self._motion_clf.detect(fingers_up)

    def get_trail_points(self, tip_idx: int = PINKY_TIP) -> list:
        return self._motion_clf.get_trail_points(tip_idx)

    def reset(self):
        self._phase = "position"
        self._hold_count = 0
        self._motion_clf.reset()
