"""
landmarks.py — Normalización y extracción de features desde landmarks MediaPipe.

Versiones:
  v5  — 78 features/mano: XY + geométricas (sensible a rotación)
  v6  — 48 features/mano: SOLO ángulos articulares 3D + distancias normalizadas
        Completamente invariante a rotación, posición y escala.
        Funciona con la mano en cualquier dirección.
  v6-two — 96 features: 48 derecha + 48 izquierda
"""
from __future__ import annotations

import numpy as np
from typing import List, Dict, Optional

WRIST = 0
THUMB_CMC, THUMB_MCP, THUMB_IP, THUMB_TIP = 1, 2, 3, 4
INDEX_MCP,  INDEX_PIP,  INDEX_DIP,  INDEX_TIP  = 5, 6, 7, 8
MIDDLE_MCP, MIDDLE_PIP, MIDDLE_DIP, MIDDLE_TIP = 9, 10, 11, 12
RING_MCP,   RING_PIP,   RING_DIP,   RING_TIP   = 13, 14, 15, 16
PINKY_MCP,  PINKY_PIP,  PINKY_DIP,  PINKY_TIP  = 17, 18, 19, 20

FINGER_TIPS = [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP]
FINGER_MCPS = [THUMB_MCP, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP]
FINGER_PIPS = [THUMB_IP,  INDEX_PIP, MIDDLE_PIP, RING_PIP, PINKY_PIP]

# Tamaños de features
FEATURE_SIZE_ONE_HAND  = 78    # v5 legacy
FEATURE_SIZE_TWO_HANDS = 156   # v5-two legacy
FEATURE_SIZE_V6_ONE    = 48    # v6 rotation-invariant
FEATURE_SIZE_V6_TWO    = 96    # v6-two


def normalize_landmarks(raw: List[Dict[str, float]]) -> np.ndarray:
    """Normaliza landmarks: wrist al origen, escala por tamaño de palma."""
    pts = np.array([[p["x"], p["y"], p.get("z", 0.0)] for p in raw], dtype=np.float64)
    pts -= pts[WRIST].copy()
    palm_size = np.linalg.norm(pts[MIDDLE_MCP])
    if palm_size < 1e-6:
        palm_size = 1.0
    pts /= palm_size
    return pts


def normalize_world_landmarks(raw: List[Dict[str, float]]) -> np.ndarray:
    """Normaliza world landmarks 3D (métricos) de MediaPipe."""
    pts = np.array([[p["x"], p["y"], p.get("z", 0.0)] for p in raw], dtype=np.float64)
    pts -= pts[WRIST].copy()
    palm_size = np.linalg.norm(pts[MIDDLE_MCP])
    if palm_size < 1e-6:
        palm_size = 1.0
    pts /= palm_size
    return pts


# ── Helpers v5 (legacy) ──────────────────────────────────────────────────────

def _extension_ratio(pts: np.ndarray, tip: int, mcp: int) -> float:
    tip_dist = np.linalg.norm(pts[tip, :2])
    mcp_dist = np.linalg.norm(pts[mcp, :2])
    if mcp_dist < 1e-6:
        return 1.0
    return float(np.clip(tip_dist / mcp_dist, 0.4, 2.5))


def _pip_curl(pts: np.ndarray, tip: int, pip: int, mcp: int) -> float:
    chord = np.linalg.norm(pts[tip, :2] - pts[mcp, :2])
    arc   = (np.linalg.norm(pts[pip, :2] - pts[mcp, :2]) +
             np.linalg.norm(pts[tip, :2] - pts[pip, :2]))
    if arc < 1e-6:
        return 1.0
    return float(np.clip(chord / arc, 0.3, 1.0))


def _finger_angle(pts: np.ndarray, tip: int, mcp: int) -> float:
    vec = pts[tip, :2] - pts[mcp, :2]
    norm = np.linalg.norm(vec)
    if norm < 1e-6:
        return 0.0
    cos_a = np.clip(-vec[1] / norm, -1.0, 1.0)
    return float(np.arccos(cos_a))


# ── Helpers v6 (rotation-invariant) ─────────────────────────────────────────

def _joint_angle_3d(pts: np.ndarray, joint: int, prev: int, next_: int) -> float:
    """
    Ángulo en 'joint' entre los huesos prev→joint y joint→next_.
    Usa los 3 ejes (x, y, z). 0 = recto, π ≈ doblado.
    Completamente invariante a rotación global.
    """
    v1 = pts[joint] - pts[prev]
    v2 = pts[next_] - pts[joint]
    n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
    if n1 < 1e-6 or n2 < 1e-6:
        return 0.0
    cos_a = np.clip(np.dot(v1, v2) / (n1 * n2), -1.0, 1.0)
    return float(np.arccos(cos_a))


def _abduction_angle_3d(pts: np.ndarray, mcp_a: int, mcp_b: int) -> float:
    """Ángulo de abducción entre dos metacarpos (spread de dedos)."""
    v1 = pts[mcp_a] - pts[WRIST]
    v2 = pts[mcp_b] - pts[WRIST]
    n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
    if n1 < 1e-6 or n2 < 1e-6:
        return 0.0
    return float(np.arccos(np.clip(np.dot(v1, v2) / (n1 * n2), -1.0, 1.0)))


def _flexion_pct(pts: np.ndarray, tip: int, pip: int, mcp: int) -> float:
    """
    Porcentaje de flexión [0-1]: 0 = completamente extendido, 1 = completamente doblado.
    Calculado como 1 - chord/arc (inversión del curl ratio).
    """
    chord = np.linalg.norm(pts[tip] - pts[mcp])
    arc   = (np.linalg.norm(pts[pip] - pts[mcp]) +
             np.linalg.norm(pts[tip] - pts[pip]))
    if arc < 1e-6:
        return 0.0
    return float(np.clip(1.0 - chord / arc, 0.0, 1.0))


def extract_features_v6(pts: np.ndarray) -> np.ndarray:
    """
    Extrae 48 features v6 — completamente invariantes a rotación y posición.

    NO usa coordenadas XY absolutas. Usa exclusivamente:
      [0:15]  — 15 ángulos articulares 3D (5 dedos × 3 articulaciones)
                Invariantes a cualquier rotación de la mano en el espacio
      [15:20] — 5 porcentajes de flexión por dedo [0=extendido, 1=doblado]
      [20:25] — 5 ratios de extensión (tip/mcp distance normalized)
      [25:30] — 5 distancias tip-to-wrist normalizadas
      [30:35] — 5 distancias entre puntas (thumb-to-each + index-to-pinky)
      [35:39] — 4 ángulos de abducción (spread entre dedos adyacentes)
      [39:42] — 3 componentes del vector normal de la palma (orientación)
      [42:44] — distancia pulgar-centro-palma + extensión máxima
      [44:46] — min extensión + std extensión
      [46:48] — thumb_signed_x + thumb_signed_y (posición relativa del pulgar)

    Args:
        pts: Array (21, 3) normalizado (salida de normalize_landmarks)

    Returns:
        Array (48,) de features
    """
    # ── Bloque 1: Ángulos articulares 3D (15 features) ───────────────────────
    # Para cada dedo: ángulo en MCP, PIP, DIP/IP
    # Definición: (base/prev_joint → joint → next_joint)
    finger_defs = [
        (WRIST,     THUMB_CMC,  THUMB_MCP,  THUMB_IP,   THUMB_TIP),
        (WRIST,     INDEX_MCP,  INDEX_PIP,  INDEX_DIP,  INDEX_TIP),
        (WRIST,     MIDDLE_MCP, MIDDLE_PIP, MIDDLE_DIP, MIDDLE_TIP),
        (WRIST,     RING_MCP,   RING_PIP,   RING_DIP,   RING_TIP),
        (WRIST,     PINKY_MCP,  PINKY_PIP,  PINKY_DIP,  PINKY_TIP),
    ]

    joint_angles = []
    for base, mcp, pip, dip, tip in finger_defs:
        joint_angles.append(_joint_angle_3d(pts, mcp, base, pip))
        joint_angles.append(_joint_angle_3d(pts, pip, mcp, dip))
        joint_angles.append(_joint_angle_3d(pts, dip, pip, tip))
    joint_angles = np.array(joint_angles, dtype=np.float64)  # 15

    # ── Bloque 2: Porcentaje de flexión por dedo (5 features) ────────────────
    flexion_pcts = np.array([
        _flexion_pct(pts, THUMB_TIP,  THUMB_IP,   THUMB_MCP),
        _flexion_pct(pts, INDEX_TIP,  INDEX_PIP,  INDEX_MCP),
        _flexion_pct(pts, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP),
        _flexion_pct(pts, RING_TIP,   RING_PIP,   RING_MCP),
        _flexion_pct(pts, PINKY_TIP,  PINKY_PIP,  PINKY_MCP),
    ], dtype=np.float64)  # 5

    # ── Bloque 3: Ratios de extensión (5 features) ───────────────────────────
    ext = np.array([
        _extension_ratio(pts, THUMB_TIP,  THUMB_MCP),
        _extension_ratio(pts, INDEX_TIP,  INDEX_MCP),
        _extension_ratio(pts, MIDDLE_TIP, MIDDLE_MCP),
        _extension_ratio(pts, RING_TIP,   RING_MCP),
        _extension_ratio(pts, PINKY_TIP,  PINKY_MCP),
    ], dtype=np.float64)  # 5

    # ── Bloque 4: Distancias tip-to-wrist normalizadas (5 features) ──────────
    palm_size = float(np.linalg.norm(pts[MIDDLE_MCP]))
    if palm_size < 1e-6:
        palm_size = 1.0

    tip_wrist = np.array([
        float(np.linalg.norm(pts[THUMB_TIP]))  / palm_size,
        float(np.linalg.norm(pts[INDEX_TIP]))  / palm_size,
        float(np.linalg.norm(pts[MIDDLE_TIP])) / palm_size,
        float(np.linalg.norm(pts[RING_TIP]))   / palm_size,
        float(np.linalg.norm(pts[PINKY_TIP]))  / palm_size,
    ], dtype=np.float64)  # 5

    # ── Bloque 5: Distancias entre puntas (5 features) ────────────────────────
    inter_tips = np.array([
        float(np.linalg.norm(pts[THUMB_TIP]  - pts[INDEX_TIP]))  / palm_size,
        float(np.linalg.norm(pts[THUMB_TIP]  - pts[MIDDLE_TIP])) / palm_size,
        float(np.linalg.norm(pts[THUMB_TIP]  - pts[RING_TIP]))   / palm_size,
        float(np.linalg.norm(pts[THUMB_TIP]  - pts[PINKY_TIP]))  / palm_size,
        float(np.linalg.norm(pts[INDEX_TIP]  - pts[PINKY_TIP]))  / palm_size,
    ], dtype=np.float64)  # 5

    # ── Bloque 6: Ángulos de abducción (4 features) ───────────────────────────
    abduction = np.array([
        _abduction_angle_3d(pts, THUMB_MCP,  INDEX_MCP),
        _abduction_angle_3d(pts, INDEX_MCP,  MIDDLE_MCP),
        _abduction_angle_3d(pts, MIDDLE_MCP, RING_MCP),
        _abduction_angle_3d(pts, RING_MCP,   PINKY_MCP),
    ], dtype=np.float64)  # 4

    # ── Bloque 7: Normal de la palma (3 features) ────────────────────────────
    v_index = pts[INDEX_MCP].copy()
    v_pinky = pts[PINKY_MCP].copy()
    palm_normal = np.cross(v_index, v_pinky)
    pn_norm = np.linalg.norm(palm_normal)
    if pn_norm > 1e-6:
        palm_normal /= pn_norm
    else:
        palm_normal = np.array([0.0, 0.0, 1.0])
    palm_normal = palm_normal.astype(np.float64)  # 3

    # ── Bloque 8: Features del pulgar (2 features) ───────────────────────────
    palm_center = (pts[INDEX_MCP] + pts[PINKY_MCP]) / 2.0
    thumb_palm_dist = float(np.linalg.norm(pts[THUMB_TIP] - palm_center)) / palm_size
    max_ext = float(np.max(ext))

    # ── Bloque 9: Estadísticas de extensión (2 features) ─────────────────────
    min_ext = float(np.min(ext))
    std_ext = float(np.std(ext))

    # ── Bloque 10: Posición relativa del pulgar (2 features) ─────────────────
    # Clave para letras como B (pulgar cruza palma) vs A (pulgar al lado)
    # Estos son signed para preservar el lado del pulgar
    thumb_signed_x = float(pts[THUMB_TIP, 0])
    thumb_signed_y = float(pts[THUMB_TIP, 1])

    return np.concatenate([
        joint_angles,                              # [0:15]  15
        flexion_pcts,                              # [15:20]  5
        ext,                                       # [20:25]  5
        tip_wrist,                                 # [25:30]  5
        inter_tips,                                # [30:35]  5
        abduction,                                 # [35:39]  4
        palm_normal,                               # [39:42]  3
        [thumb_palm_dist, max_ext],                # [42:44]  2
        [min_ext, std_ext],                        # [44:46]  2
        [thumb_signed_x, thumb_signed_y],          # [46:48]  2
    ], dtype=np.float64)
    # TOTAL: 48 features


def extract_features_two_hands_v6(
    right_raw: Optional[List[Dict[str, float]]],
    left_raw:  Optional[List[Dict[str, float]]],
) -> np.ndarray:
    """
    Extrae 96 features v6 concatenando ambas manos.
    Mano ausente → 48 ceros.
    """
    if right_raw and len(right_raw) == 21:
        r_feat = extract_features_v6(normalize_landmarks(right_raw))
    else:
        r_feat = np.zeros(FEATURE_SIZE_V6_ONE, dtype=np.float64)

    if left_raw and len(left_raw) == 21:
        l_feat = extract_features_v6(normalize_landmarks(left_raw))
    else:
        l_feat = np.zeros(FEATURE_SIZE_V6_ONE, dtype=np.float64)

    return np.concatenate([r_feat, l_feat])


# ── v5 (legacy) ──────────────────────────────────────────────────────────────

def extract_features_v4(pts: np.ndarray) -> np.ndarray:
    xy = pts[:, :2].flatten()
    ext = np.array([
        _extension_ratio(pts, THUMB_TIP,  THUMB_MCP),
        _extension_ratio(pts, INDEX_TIP,  INDEX_MCP),
        _extension_ratio(pts, MIDDLE_TIP, MIDDLE_MCP),
        _extension_ratio(pts, RING_TIP,   RING_MCP),
        _extension_ratio(pts, PINKY_TIP,  PINKY_MCP),
    ], dtype=np.float64)
    curl = np.array([
        _pip_curl(pts, THUMB_TIP,  THUMB_IP,   THUMB_MCP),
        _pip_curl(pts, INDEX_TIP,  INDEX_PIP,  INDEX_MCP),
        _pip_curl(pts, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP),
        _pip_curl(pts, RING_TIP,   RING_PIP,   RING_MCP),
        _pip_curl(pts, PINKY_TIP,  PINKY_PIP,  PINKY_MCP),
    ], dtype=np.float64)
    tip_to_thumb = np.array([
        float(np.linalg.norm(pts[THUMB_TIP,  :2] - pts[INDEX_TIP,  :2])),
        float(np.linalg.norm(pts[THUMB_TIP,  :2] - pts[MIDDLE_TIP, :2])),
        float(np.linalg.norm(pts[THUMB_TIP,  :2] - pts[RING_TIP,   :2])),
        float(np.linalg.norm(pts[THUMB_TIP,  :2] - pts[PINKY_TIP,  :2])),
        float(np.linalg.norm(pts[INDEX_TIP,  :2] - pts[PINKY_TIP,  :2])),
    ], dtype=np.float64)
    pinch_dist  = float(np.linalg.norm(pts[THUMB_TIP, :2] - pts[INDEX_TIP, :2]))
    spread      = float(np.linalg.norm(pts[INDEX_TIP, :2] - pts[PINKY_TIP, :2]))
    thumb_horiz = float(abs(pts[THUMB_TIP, 0] - pts[THUMB_MCP, 0]))
    global_desc = np.array([pinch_dist, spread, thumb_horiz], dtype=np.float64)
    index_height = float(pts[INDEX_MCP, 1]  - pts[INDEX_TIP, 1])
    pinky_height = float(pts[PINKY_MCP, 1]  - pts[PINKY_TIP, 1])
    palm_dir_y   = float(pts[MIDDLE_MCP, 1] / (np.linalg.norm(pts[MIDDLE_MCP, :2]) + 1e-6))
    heights      = np.array([index_height, pinky_height, palm_dir_y], dtype=np.float64)
    return np.concatenate([xy, ext, curl, tip_to_thumb, global_desc, heights])


def extract_features_v5(pts: np.ndarray) -> np.ndarray:
    base = extract_features_v4(pts)
    ext = np.array([
        _extension_ratio(pts, THUMB_TIP,  THUMB_MCP),
        _extension_ratio(pts, INDEX_TIP,  INDEX_MCP),
        _extension_ratio(pts, MIDDLE_TIP, MIDDLE_MCP),
        _extension_ratio(pts, RING_TIP,   RING_MCP),
        _extension_ratio(pts, PINKY_TIP,  PINKY_MCP),
    ], dtype=np.float64)
    thumb_signed_x = float(pts[THUMB_TIP, 0])
    thumb_signed_y = float(pts[THUMB_TIP, 1])
    angles = np.array([
        _finger_angle(pts, THUMB_TIP,  THUMB_MCP),
        _finger_angle(pts, INDEX_TIP,  INDEX_MCP),
        _finger_angle(pts, MIDDLE_TIP, MIDDLE_MCP),
        _finger_angle(pts, RING_TIP,   RING_MCP),
        _finger_angle(pts, PINKY_TIP,  PINKY_MCP),
    ], dtype=np.float64)
    inter_tips = np.array([
        float(np.linalg.norm(pts[INDEX_TIP,  :2] - pts[MIDDLE_TIP, :2])),
        float(np.linalg.norm(pts[MIDDLE_TIP, :2] - pts[RING_TIP,   :2])),
        float(np.linalg.norm(pts[RING_TIP,   :2] - pts[PINKY_TIP,  :2])),
        float(np.linalg.norm(pts[INDEX_MCP,  :2] - pts[PINKY_MCP,  :2])),
    ], dtype=np.float64)
    max_ext = float(np.max(ext))
    min_ext = float(np.min(ext))
    tip_xs  = np.array([pts[i, 0] for i in [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP]])
    tip_x_std = float(np.std(tip_xs))
    palm_center = (pts[INDEX_MCP, :2] + pts[PINKY_MCP, :2]) / 2.0
    thumb_to_palm_center = float(np.linalg.norm(pts[THUMB_TIP, :2] - palm_center))
    new_feats = np.array([
        thumb_signed_x, thumb_signed_y,
        *angles, *inter_tips,
        max_ext, min_ext, tip_x_std, thumb_to_palm_center,
    ], dtype=np.float64)
    return np.concatenate([base, new_feats])


def extract_features_two_hands(
    right_raw: Optional[List[Dict[str, float]]],
    left_raw:  Optional[List[Dict[str, float]]],
) -> np.ndarray:
    """v5-two: 156 features."""
    if right_raw and len(right_raw) == 21:
        right_feat = extract_features_v5(normalize_landmarks(right_raw))
    else:
        right_feat = np.zeros(FEATURE_SIZE_ONE_HAND, dtype=np.float64)
    if left_raw and len(left_raw) == 21:
        left_feat = extract_features_v5(normalize_landmarks(left_raw))
    else:
        left_feat = np.zeros(FEATURE_SIZE_ONE_HAND, dtype=np.float64)
    return np.concatenate([right_feat, left_feat])


def get_finger_states(landmarks: np.ndarray) -> List[bool]:
    """
    Detecta qué dedos están extendidos.

    Pulgar: usa distancia 3D del tip a los otros tips + extensión desde su MCP.
    Distingue correctamente A (pulgar al lado) vs S (pulgar sobre dedos),
    y E (dedos doblados) vs B (dedos extendidos).

    Los 4 dedos restantes: tip arriba de su PIP (en Y normalizado).
    """
    pts = landmarks
    palm_size = float(np.linalg.norm(pts[MIDDLE_MCP])) + 1e-6

    # ── Pulgar: extendido si su tip está lejos de los otros tips ──────────────
    thumb_to_index  = float(np.linalg.norm(pts[THUMB_TIP] - pts[INDEX_TIP]))
    thumb_to_middle = float(np.linalg.norm(pts[THUMB_TIP] - pts[MIDDLE_TIP]))
    thumb_extension = float(np.linalg.norm(pts[THUMB_TIP] - pts[THUMB_MCP]))
    avg_tip_dist    = (thumb_to_index + thumb_to_middle) / 2.0
    # A: pulgar al lado → lejos del índice/medio → avg_tip_dist > 0.55 * palm
    # S: pulgar sobre dedos → cerca del índice/medio → avg_tip_dist < 0.55
    thumb_up = bool(avg_tip_dist / palm_size > 0.55 or thumb_extension / palm_size > 0.65)

    # ── Otros 4 dedos: tip arriba del PIP ────────────────────────────────────
    pairs = [
        (INDEX_TIP,  INDEX_PIP),
        (MIDDLE_TIP, MIDDLE_PIP),
        (RING_TIP,   RING_PIP),
        (PINKY_TIP,  PINKY_PIP),
    ]
    others_up = [bool(pts[tip][1] < pts[pip][1]) for tip, pip in pairs]
    return [thumb_up, *others_up]


def get_flexion_percentages(landmarks: np.ndarray) -> List[float]:
    """Retorna el porcentaje de flexión [0-1] de cada dedo (pulgar, índice, medio, anular, meñique)."""
    pts = landmarks
    return [
        _flexion_pct(pts, THUMB_TIP,  THUMB_IP,   THUMB_MCP),
        _flexion_pct(pts, INDEX_TIP,  INDEX_PIP,  INDEX_MCP),
        _flexion_pct(pts, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP),
        _flexion_pct(pts, RING_TIP,   RING_PIP,   RING_MCP),
        _flexion_pct(pts, PINKY_TIP,  PINKY_PIP,  PINKY_MCP),
    ]


def raw_to_feature_v5(raw_landmarks: List[Dict[str, float]]) -> np.ndarray:
    normalized = normalize_landmarks(raw_landmarks)
    return extract_features_v5(normalized)


def raw_to_feature_v6(raw_landmarks: List[Dict[str, float]]) -> np.ndarray:
    normalized = normalize_landmarks(raw_landmarks)
    return extract_features_v6(normalized)
