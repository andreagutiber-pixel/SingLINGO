from __future__ import annotations

from typing import Iterable

import numpy as np


SEQ_LEN = 32
FEATURE_SIZE = SEQ_LEN * 10 + 12


def _point(frame: dict, source: str, idx: int) -> tuple[float, float, float]:
    pts = frame.get(source) or []
    if len(pts) <= idx:
        return 0.0, 0.0, 0.0
    p = pts[idx] or {}
    return float(p.get("x", 0.0)), float(p.get("y", 0.0)), float(p.get("z", 0.0))


def _resample(values: np.ndarray, out_len: int = SEQ_LEN) -> np.ndarray:
    if len(values) == 0:
      return np.zeros((out_len, values.shape[1] if values.ndim == 2 else 1), dtype=np.float64)
    if len(values) == out_len:
      return values.astype(np.float64)
    src = np.linspace(0.0, 1.0, len(values))
    dst = np.linspace(0.0, 1.0, out_len)
    cols = [np.interp(dst, src, values[:, i]) for i in range(values.shape[1])]
    return np.stack(cols, axis=1).astype(np.float64)


def extract_sequence_features(frames: Iterable[dict]) -> np.ndarray:
    """Compact temporal features for hand/body sequences.

    Uses normalized trajectories for wrist, index tip, pinky tip, optional left wrist,
    and simple body anchors. Designed as a lightweight baseline for LSC motions.
    """
    frames = [f for f in frames if f.get("landmarks") or f.get("world_landmarks")]
    rows = []
    for frame in frames:
        source = "world_landmarks" if frame.get("world_landmarks") else "landmarks"
        wrist = _point(frame, source, 0)
        index = _point(frame, source, 8)
        pinky = _point(frame, source, 20)
        left_wrist = _point(frame, "world_landmarks_left" if frame.get("world_landmarks_left") else "landmarks_left", 0)
        pose_nose = _point(frame, "pose_landmarks", 0)
        pose_chest_l = _point(frame, "pose_landmarks", 11)
        pose_chest_r = _point(frame, "pose_landmarks", 12)
        chest = tuple((pose_chest_l[i] + pose_chest_r[i]) * 0.5 for i in range(3))
        rows.append([
            index[0] - wrist[0], index[1] - wrist[1],
            pinky[0] - wrist[0], pinky[1] - wrist[1],
            wrist[0], wrist[1],
            left_wrist[0] - wrist[0], left_wrist[1] - wrist[1],
            pose_nose[1] - wrist[1],
            chest[1] - wrist[1],
        ])

    arr = np.array(rows, dtype=np.float64) if rows else np.zeros((0, 10), dtype=np.float64)
    seq = _resample(arr, SEQ_LEN)
    if len(seq):
        seq[:, :8] -= seq[0, :8]

    deltas = np.diff(seq[:, :8], axis=0) if len(seq) > 1 else np.zeros((1, 8), dtype=np.float64)
    stats = np.array([
        float(np.sum(np.linalg.norm(deltas[:, 0:2], axis=1))),
        float(np.sum(np.linalg.norm(deltas[:, 2:4], axis=1))),
        float(np.ptp(seq[:, 0])),
        float(np.ptp(seq[:, 1])),
        float(np.ptp(seq[:, 2])),
        float(np.ptp(seq[:, 3])),
        float(np.ptp(seq[:, 6])),
        float(np.ptp(seq[:, 7])),
        float(np.nanmean(seq[:, 8])),
        float(np.nanmean(seq[:, 9])),
        float(np.nanstd(seq[:, 8])),
        float(np.nanstd(seq[:, 9])),
    ], dtype=np.float64)
    return np.concatenate([seq.flatten(), stats])
