"""
classifier.py — Clasificador de señas usando MLP (red neuronal) + SVM.

v6: 96 features — 48 v6 mano derecha + 48 v6 mano izquierda.
    Invariante a rotación gracias a features v6 (ángulos articulares 3D).

Clasificador primario: MLPClassifier (red neuronal sklearn)
  - Mucho más preciso que LinearSVC para este problema no-lineal
  - Inference < 2ms — suficientemente rápido para tiempo real
  - Soporta probabilidades reales (no decision function aproximada)

Fallback: LinearSVC para modelos legacy (v5)
"""
from __future__ import annotations

import json
import os
from collections import deque
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Deque

import numpy as np
import joblib
from sklearn.svm import LinearSVC
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.calibration import CalibratedClassifierCV

from core.landmarks import (
    normalize_landmarks,
    extract_features_v5,
    extract_features_v6,
    extract_features_two_hands,
    extract_features_two_hands_v6,
    get_finger_states,
    get_flexion_percentages,
    FEATURE_SIZE_ONE_HAND,
    FEATURE_SIZE_TWO_HANDS,
    FEATURE_SIZE_V6_ONE,
    FEATURE_SIZE_V6_TWO,
)

DATA_DIR  = Path(__file__).parent.parent / "data"
SIGNS_DIR = DATA_DIR / "signs"
MODELS_DIR = DATA_DIR / "models"
MODELS_DIR.mkdir(exist_ok=True)

SUPPORTED_COUNTRIES = ["asl", "lsc", "bsl"]

SMOOTH_WINDOW = 3


def _load_signs(country: str) -> List[dict]:
    path = SIGNS_DIR / f"{country}.json"
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)["signs"]


class TemporalSmoother:
    """
    Suaviza predicciones usando votación ponderada sobre las últimas N frames.
    Ventana de 3 frames: mejor balance entre estabilidad y velocidad de respuesta.
    """

    def __init__(self, window: int = SMOOTH_WINDOW):
        self.window = window
        self._history: Deque[Tuple[str, float]] = deque(maxlen=window)

    def push(self, sign_id: str, confidence: float) -> Tuple[str, float]:
        self._history.append((sign_id, confidence))
        if len(self._history) < 2:
            return sign_id, confidence

        votes: Dict[str, float] = {}
        total_weight = 0.0
        for i, (sid, conf) in enumerate(self._history):
            weight = (i + 1) * conf
            votes[sid] = votes.get(sid, 0.0) + weight
            total_weight += weight

        if total_weight == 0:
            return sign_id, confidence

        winner = max(votes, key=votes.__getitem__)
        smoothed_conf = votes[winner] / total_weight
        return winner, min(smoothed_conf, 1.0)

    def reset(self):
        self._history.clear()


def _build_mlp_pipeline() -> Pipeline:
    """
    Construye pipeline MLP optimizado para clasificación de señas.

    MLPClassifier vs LinearSVC:
      - MLP aprende fronteras no-lineales → mucho mejor para señas similares (A/E/M/N/S)
      - Probabilidades reales (sin calibración artificial)
      - Inference <2ms con hidden_layer_sizes=(256, 128)
    """
    return Pipeline([
        ("scaler", StandardScaler()),
        ("mlp", MLPClassifier(
            hidden_layer_sizes=(128, 64),
            activation="relu",
            solver="adam",
            alpha=5e-4,
            learning_rate="adaptive",
            learning_rate_init=0.001,
            max_iter=350,
            random_state=42,
            early_stopping=True,
            validation_fraction=0.1,
            n_iter_no_change=15,
            tol=1e-4,
            verbose=False,
        )),
    ])


def _build_svm_pipeline() -> Pipeline:
    """Pipeline SVM legacy (para fallback o comparación)."""
    return Pipeline([
        ("scaler", StandardScaler()),
        ("svm", LinearSVC(
            C=3.0,
            max_iter=4000,
            class_weight="balanced",
            dual="auto",
            tol=1e-3,
        )),
    ])


class SignClassifier:
    """
    Clasificador de señas para un idioma específico.

    Pipeline v6 (rotation-invariant):
        (right_lms, left_lms) → extract_features_v6 (96 features) → MLP
                                                                       ↓
                                                              TemporalSmoother (win=3)

    Backward compatible con modelos v5 (156 features) guardados.
    """

    def __init__(self, country: str = "lsc"):
        self.country  = country
        self.signs: List[dict] = _load_signs(country)
        self.label_map: Dict[int, str] = {}
        self.sign_map: Dict[str, dict] = {s["id"]: s for s in self.signs}
        self.pipeline: Optional[Pipeline] = None
        self.smoother = TemporalSmoother(SMOOTH_WINDOW)
        self.feature_size: int = FEATURE_SIZE_V6_TWO
        self._model_version: str = "v6"
        self._try_load()

    def _model_path(self) -> Path:
        return MODELS_DIR / f"classifier_{self.country}.pkl"

    def _try_load(self):
        path = self._model_path()
        if path.exists():
            data = joblib.load(path)
            self.pipeline = data["pipeline"]
            self.label_map = data["label_map"]
            self.feature_size = data.get("feature_size", FEATURE_SIZE_ONE_HAND)
            self._model_version = data.get("model_version", "v5")

    def is_trained(self) -> bool:
        return self.pipeline is not None

    def is_v6_model(self) -> bool:
        return self.feature_size in (FEATURE_SIZE_V6_ONE, FEATURE_SIZE_V6_TWO)

    def is_two_hand_model(self) -> bool:
        return self.feature_size in (FEATURE_SIZE_TWO_HANDS, FEATURE_SIZE_V6_TWO)

    def train(self, X: np.ndarray, y: np.ndarray, use_mlp: bool = True) -> float:
        """
        Entrena el pipeline con MLPClassifier (por defecto) o SVM (fallback).

        MLPClassifier: mucho mejor para señas no-linealmente separables.
        hidden=(256,128,64): suficientemente potente, <2ms inference.
        """
        self.feature_size = X.shape[1]
        self._model_version = "v6" if self.feature_size in (FEATURE_SIZE_V6_ONE, FEATURE_SIZE_V6_TWO) else "v5"

        if use_mlp:
            self.pipeline = _build_mlp_pipeline()
        else:
            self.pipeline = _build_svm_pipeline()

        self.pipeline.fit(X, y)
        preds = self.pipeline.predict(X)
        accuracy = float(np.mean(preds == y))
        return accuracy

    def save(self):
        joblib.dump({
            "pipeline":      self.pipeline,
            "label_map":     self.label_map,
            "feature_size":  self.feature_size,
            "model_version": self._model_version,
        }, self._model_path())

    def predict(self, features: np.ndarray, smooth: bool = True) -> Tuple[str, float]:
        if not self.is_trained():
            return "UNKNOWN", 0.0

        feats = features.reshape(1, -1)
        estimator = self.pipeline.named_steps.get("mlp") or self.pipeline.named_steps.get("svm")

        if hasattr(estimator, "predict_proba"):
            proba = self.pipeline.predict_proba(feats)[0]
            proba_idx = int(np.argmax(proba))
            class_idx = int(getattr(estimator, "classes_", [proba_idx])[proba_idx])
            confidence = float(proba[proba_idx])
        else:
            decision = self.pipeline.decision_function(feats)[0]
            decision = decision - decision.max()
            exp_d = np.exp(decision)
            proba = exp_d / exp_d.sum()
            proba_idx = int(np.argmax(proba))
            class_idx = int(getattr(estimator, "classes_", [proba_idx])[proba_idx])
            confidence = float(proba[proba_idx])

        sign_id = self.label_map.get(class_idx, "UNKNOWN")

        if smooth:
            sign_id, confidence = self.smoother.push(sign_id, confidence)

        return sign_id, confidence

    def predict_from_raw(self, raw_landmarks: List[dict], smooth: bool = True) -> dict:
        return self.predict_from_raw_two_hands(
            right_raw=raw_landmarks,
            left_raw=None,
            smooth=smooth,
        )

    def predict_from_raw_two_hands(
        self,
        right_raw: Optional[List[dict]],
        left_raw:  Optional[List[dict]],
        smooth: bool = True,
    ) -> dict:
        if not self.is_trained():
            return {
                "sign_id": "UNKNOWN", "sign_name": "Sin modelo", "confidence": 0.0,
                "fingers_up": [False] * 5, "fingers_up_left": None,
                "flexion_pcts": [0.0] * 5, "flexion_pcts_left": None,
                "tips": [], "score": 0.0, "two_handed": False, "hands_detected": 0,
            }

        dominant = right_raw or left_raw
        if not dominant:
            return {
                "sign_id": "UNKNOWN", "sign_name": "Sin mano", "confidence": 0.0,
                "fingers_up": [False] * 5, "fingers_up_left": None,
                "flexion_pcts": [0.0] * 5, "flexion_pcts_left": None,
                "tips": [], "score": 0.0, "two_handed": False, "hands_detected": 0,
            }

        # Extrae features según la versión del modelo cargado
        single_hand_raw = right_raw if (right_raw and not left_raw) else (left_raw if (left_raw and not right_raw) else None)
        if self.is_v6_model():
            if self.feature_size == FEATURE_SIZE_V6_TWO:
                if single_hand_raw:
                    features_right = extract_features_two_hands_v6(single_hand_raw, None)
                    features_left = extract_features_two_hands_v6(None, single_hand_raw)
                    _, conf_r = self.predict(features_right, smooth=False)
                    _, conf_l = self.predict(features_left, smooth=False)
                    features = features_right if conf_r >= conf_l else features_left
                else:
                    features = extract_features_two_hands_v6(right_raw, left_raw)
            else:
                norm = normalize_landmarks(dominant)
                features = extract_features_v6(norm)
        else:
            if self.is_two_hand_model():
                features = extract_features_two_hands(right_raw, left_raw)
            else:
                norm = normalize_landmarks(dominant)
                features = extract_features_v5(norm)

        fingers_up = [False] * 5
        fingers_up_left = None
        flexion_pcts = [0.0] * 5
        flexion_pcts_left = None

        if right_raw and len(right_raw) == 21:
            norm_r = normalize_landmarks(right_raw)
            fingers_up = get_finger_states(norm_r)
            flexion_pcts = get_flexion_percentages(norm_r)

        if left_raw and len(left_raw) == 21:
            norm_l = normalize_landmarks(left_raw)
            fingers_up_left = get_finger_states(norm_l)
            flexion_pcts_left = get_flexion_percentages(norm_l)
            if not right_raw:
                fingers_up = fingers_up_left
                flexion_pcts = flexion_pcts_left

        hands_detected = (1 if right_raw else 0) + (1 if left_raw else 0)

        sign_id, confidence = self.predict(features, smooth=smooth)

        sign_data = self.sign_map.get(sign_id, {})
        sign_name = sign_data.get("name", sign_id)
        tips       = sign_data.get("tips", [])
        score      = round(confidence * 100, 1)
        two_handed = sign_data.get("two_handed", False)

        return {
            "sign_id":           sign_id,
            "sign_name":         sign_name,
            "confidence":        confidence,
            "fingers_up":        fingers_up,
            "fingers_up_left":   fingers_up_left,
            "flexion_pcts":      flexion_pcts,
            "flexion_pcts_left": flexion_pcts_left,
            "tips":              tips[:2],
            "score":             score,
            "two_handed":        two_handed,
            "hands_detected":    hands_detected,
        }

    def get_sign_templates(self) -> Dict[str, dict]:
        templates = {}
        for sign in self.signs:
            templates[sign["id"]] = {
                "finger_states":       sign.get("finger_states", [False] * 5),
                "finger_states_other": sign.get("finger_states_other"),
                "name":       sign["name"],
                "emoji":      sign.get("emoji", "🤟"),
                "tips":       sign.get("tips", []),
                "two_handed": sign.get("two_handed", False),
            }
        return templates

    def reset_smoother(self):
        self.smoother.reset()


_classifiers: Dict[str, SignClassifier] = {}


def get_classifier(country: str) -> SignClassifier:
    if country not in _classifiers:
        _classifiers[country] = SignClassifier(country)
    return _classifiers[country]


def reload_all():
    global _classifiers
    _classifiers = {}
    for c in SUPPORTED_COUNTRIES:
        _classifiers[c] = SignClassifier(c)
